"""Exercise the publishing wrapper without real keys, network access, or publishing."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import quote, quote_plus


WRAPPER = Path(sys.argv.pop(1)).resolve()
TOKEN = "synthetic/pat+with=reserved%characters~*"


class OvsxWrapperTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="sops-safe-ovsx-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.secret = self.root / "secrets.yaml"
        self.secret.write_text("open_vsx_pat: ENC[synthetic test fixture]\n")
        self.sops_log = self.root / "sops.json"
        self.npx_log = self.root / "npx.json"
        self.env = dict(os.environ)
        self.env.update({
            "OVSX_TEST_ROOT": str(self.root),
            "OVSX_TEST_TOKEN": TOKEN,
            "OVSX_PAT": "stale-parent-token",
            "DEBUG": "*",
            "NODE_DEBUG": "http,https",
            "NODE_DEBUG_NATIVE": "*",
        })
        self.sops = self.make_program("fake-sops", r'''
import json, os, pathlib, sys
root = pathlib.Path(os.environ["OVSX_TEST_ROOT"])
(root / "sops.json").write_text(json.dumps({"args": sys.argv[1:], "inherited_pat": "OVSX_PAT" in os.environ}))
if os.environ.get("OVSX_TEST_DECRYPT_FAIL"):
    print("decryption-output-must-not-escape", flush=True)
    print("decryption-error-must-not-escape", file=sys.stderr)
    sys.exit(23)
sys.stdout.write(os.environ["OVSX_TEST_TOKEN"])
''')
        self.npx = self.make_program("fake-npx", r'''
import json, os, pathlib, sys
from urllib.parse import quote, quote_plus
root = pathlib.Path(os.environ["OVSX_TEST_ROOT"])
token = os.environ.get("OVSX_PAT")
(root / "npx.json").write_text(json.dumps({
    "args": sys.argv[1:], "pat": token,
    "debug": {key: os.environ.get(key) for key in ("DEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE")},
}))
if token:
    # A reflected token can arrive across writes and in either output stream.
    raw = token.encode()
    os.write(1, b"raw=" + raw[:7])
    os.write(1, raw[7:] + b"\n")
    print("encoded=" + quote(token, safe=""), flush=True)
    print("plus=" + quote_plus(token, safe=""), file=sys.stderr, flush=True)
    print("form=" + quote_plus(token, safe="*").replace("~", "%7E"), file=sys.stderr, flush=True)
    os.write(2, b"last-line-without-newline=" + raw)
else:
    print("usage: ovsx", flush=True)
sys.exit(int(os.environ.get("OVSX_TEST_EXIT_CODE", "0")))
''')

    def make_program(self, name, content):
        path = self.root / name
        path.write_text(f"#!{sys.executable}\n" + content)
        path.chmod(0o755)
        return path

    def invoke(self, *args):
        return subprocess.run(
            [sys.executable, str(WRAPPER), "--sops", str(self.sops),
             "--npx", str(self.npx), "--secrets", str(self.secret), "--", *args],
            env=self.env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=15,
        )

    def test_extracts_only_named_key_and_forwards_pinned_cli_arguments(self):
        args = ["publish", "a file.vsix", "--registryUrl", "https://example.invalid"]
        result = self.invoke(*args)
        self.assertEqual(result.returncode, 0, result.stderr)
        sops = json.loads(self.sops_log.read_text())
        self.assertEqual(sops["args"][:3], ["decrypt", "--extract", '["open_vsx_pat"]'])
        self.assertEqual(sops["args"][-1], str(self.secret))
        self.assertFalse(sops["inherited_pat"])
        npx = json.loads(self.npx_log.read_text())
        self.assertEqual(npx["args"], ["--yes", "--ignore-scripts", "--package=ovsx@1.2.0", "--", "ovsx", *args])
        self.assertEqual(npx["pat"], TOKEN)
        self.assertTrue(all(value is None for value in npx["debug"].values()))
        self.assertNotIn(TOKEN, " ".join(npx["args"]))
        self.assertEqual(self.env["OVSX_PAT"], "stale-parent-token")

    def test_redacts_both_streams_and_preserves_failure_status(self):
        self.env["OVSX_TEST_EXIT_CODE"] = "17"
        result = self.invoke("publish", "extension.vsix")
        self.assertEqual(result.returncode, 17)
        for token in (TOKEN, quote(TOKEN, safe=""), quote_plus(TOKEN, safe=""),
                      quote_plus(TOKEN, safe="*").replace("~", "%7E")):
            self.assertNotIn(token, result.stdout + result.stderr)
        self.assertIn("raw=", result.stdout)
        self.assertIn("encoded=", result.stdout)
        self.assertIn("last-line-without-newline=", result.stderr)

    def test_decryption_failure_never_launches_cli_or_prints_captured_output(self):
        self.env["OVSX_TEST_DECRYPT_FAIL"] = "1"
        result = self.invoke("publish")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.npx_log.exists())
        self.assertNotIn("decryption-output-must-not-escape", result.stdout + result.stderr)
        self.assertNotIn("decryption-error-must-not-escape", result.stdout + result.stderr)

    def test_invalid_tokens_never_launch_cli(self):
        for value in ("", " ", "null\nvalue", "pat with spaces", "\tpat"):
            with self.subTest(value=value):
                self.env["OVSX_TEST_TOKEN"] = value
                result = self.invoke("publish")
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.npx_log.exists())
                if value.strip():
                    self.assertNotIn(value, result.stdout + result.stderr)

    def test_help_and_version_need_no_decryption_or_token(self):
        for args in ((), ("--help",), ("-h",), ("--version",), ("-V",), ("publish", "--help")):
            with self.subTest(args=args):
                self.env["OVSX_TEST_DECRYPT_FAIL"] = "1"
                result = self.invoke(*args)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse(self.sops_log.exists())
                self.assertIsNone(json.loads(self.npx_log.read_text())["pat"])

    def test_persistent_auth_and_unsafe_flags_rejected_before_decryption(self):
        for args in (("login",), ("publish", "--debug"), ("publish", "--pat", "dummy"),
                     ("publish", "--pat=dummy"), ("publish", "-p", "dummy"), ("publish", "-pdummy")):
            with self.subTest(args=args):
                result = self.invoke(*args)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.sops_log.exists())
                self.assertFalse(self.npx_log.exists())

    def test_help_as_option_value_or_filename_does_not_skip_authentication(self):
        for args in (("publish", "example.vsix", "--baseContentUrl", "--help"),
                     ("publish", "--", "--help")):
            with self.subTest(args=args):
                result = self.invoke(*args)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(self.sops_log.exists())
                self.assertEqual(json.loads(self.npx_log.read_text())["pat"], TOKEN)


if __name__ == "__main__":
    unittest.main()
