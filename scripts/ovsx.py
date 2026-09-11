#!/usr/bin/env python3
"""Run Open VSX with a process-scoped SOPS token and redact CLI output."""

import argparse
import os
import re
import subprocess
import sys
import threading
from urllib.parse import quote, quote_plus


def fail(message):
    print(f"ovsx: {message}", file=sys.stderr)
    return 1


def forbidden(argument):
    # Block token persistence and flags that can expose or override our token.
    return (
        argument == "login"
        or argument.split("=", 1)[0] in ("--pat", "--debug")
        or argument.startswith("-p")
    )


def redactions(token):
    values = {token, quote(token, safe=""), quote(token), quote_plus(token)}
    # Match URLSearchParams, which leaves '*' literal but encodes '~'.
    values.add(quote_plus(token, safe="*").replace("~", "%7E"))
    values |= {re.sub(r"%[0-9A-F]{2}", lambda match: match[0].lower(), value)
               for value in values}
    return sorted((value.encode("utf-8") for value in values), key=len, reverse=True)


def forward(source, destination, secrets):
    # Drain both pipes concurrently; never spool potentially sensitive output.
    with source:
        for line in iter(source.readline, b""):
            for secret in secrets:
                line = line.replace(secret, b"[REDACTED]")
            try:
                destination.write(line)
                destination.flush()
            except BrokenPipeError:
                # Keep draining the child even when the caller closes a pipe.
                pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("sops", "npx", "secrets"):
        parser.add_argument(f"--{option}", required=True)
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    options = parser.parse_args()
    arguments = options.arguments
    if arguments[:1] == ["--"]:
        arguments = arguments[1:]
    if any(forbidden(argument) for argument in arguments):
        return fail("login, PAT flags, and debug flags are disabled; use the encrypted token.")

    # Make a child environment rather than exporting secrets into the shell.
    environment = {key: value for key, value in os.environ.items()
                   if key not in ("OVSX_PAT", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "DEBUG")}
    secrets = []
    # An apparent help flag can instead be an option value or follow '--'.
    # Only bypass authentication for unambiguous help/version invocations.
    help_only = (
        not arguments
        or (len(arguments) == 1 and arguments[0] in ("-h", "--help", "-V", "--version", "help"))
        or (len(arguments) == 2 and not arguments[0].startswith("-")
            and (arguments[1] in ("-h", "--help") or arguments[0] == "help"))
    )
    if not help_only:
        try:
            result = subprocess.run(
                [options.sops, "decrypt", "--extract", '["open_vsx_pat"]', "--", options.secrets],
                env=environment, capture_output=True, check=True,
            )
            token = result.stdout.decode("utf-8")
        except (OSError, subprocess.CalledProcessError, UnicodeError):
            return fail("could not decrypt open_vsx_pat; check your SOPS identity configuration.")
        if not token or any(character.isspace() or character == "\0" for character in token):
            return fail("open_vsx_pat must be a nonempty UTF-8 token without whitespace or NUL.")
        environment["OVSX_PAT"] = token
        secrets = redactions(token)

    try:
        child = subprocess.Popen(
            [options.npx, "--yes", "--ignore-scripts", "--package=ovsx@1.2.0", "--", "ovsx", *arguments],
            env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
    except OSError:
        return fail("could not start the Open VSX CLI.")
    workers = [threading.Thread(target=forward, args=(source, destination, secrets))
               for source, destination in ((child.stdout, sys.stdout.buffer),
                                            (child.stderr, sys.stderr.buffer))]
    for worker in workers:
        worker.start()
    status = child.wait()
    for worker in workers:
        worker.join()
    return status if status >= 0 else 128 - status


if __name__ == "__main__":
    sys.exit(main())
