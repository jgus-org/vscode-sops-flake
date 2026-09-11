import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { AlreadyEncryptedSourceError, encryptPlaintextFile } from "../src/encrypt-transaction.js";
import { readEncryptedFileSnapshot, readFileSnapshot } from "../src/encrypted-file.js";
import { InvalidEncryptedCandidateError, replaceWithEncryptedCandidate } from "../src/encrypted-replacement.js";
import { runCommand } from "../src/process.js";
import { saveEncryptedFile, StaleSourceError } from "../src/save-transaction.js";
import {
  prepareRuntimeRoot,
  RuntimeSecurityError,
  SecureSessionDirectory
} from "../src/secure-runtime.js";
import { SopsClient, SopsOperationError } from "../src/sops-client.js";

interface Fixture {
  testRoot: string;
  workspacePath: string;
  sourcePath: string;
  recipient: string;
  environment: NodeJS.ProcessEnv;
  sops: SopsClient;
  sessionDirectory: SecureSessionDirectory;
  plaintext: Buffer;
}

async function encrypt(recipient: string, plaintext: Uint8Array, environment: NodeJS.ProcessEnv): Promise<Buffer> {
  return await runCommand(
    "sops",
    [
      "--config",
      "/dev/null",
      "encrypt",
      "--age",
      recipient,
      "--filename-override",
      "secret.yaml"
    ],
    { input: plaintext, environment }
  );
}

async function createFixture(
  postQuantum: boolean,
  sourceState: "encrypted" | "plain" = "encrypted",
  matchingCreationRule = true,
  sourceRelativePath = "secret.yaml"
): Promise<Fixture> {
  const testRoot = await mkdtemp(join(tmpdir(), "sops-safe-test-"));
  await chmod(testRoot, 0o700);
  const workspacePath = join(testRoot, "workspace");
  await mkdir(workspacePath, 0o700);
  const keyPath = join(testRoot, "age-key.txt");
  await runCommand("age-keygen", [...(postQuantum ? ["-pq"] : []), "-o", keyPath]);
  const key = await readFile(keyPath, "utf8");
  const recipient = /^# public key: (.+)$/m.exec(key)?.[1];
  if (recipient === undefined) {
    throw new Error("age-keygen did not write a public recipient.");
  }
  const environment = { ...process.env, SOPS_AGE_KEY_FILE: keyPath };
  const plaintext = Buffer.from("value: original\n", "utf8");
  const sourcePath = join(workspacePath, sourceRelativePath);
  await mkdir(dirname(sourcePath), { recursive: true, mode: 0o700 });
  const pathRegex = sourceRelativePath.replaceAll(".", "\\.");
  const creationRules = matchingCreationRule
    ? `creation_rules:\n  - path_regex: ${pathRegex}$\n    age: ${recipient}\n`
    : "creation_rules: []\n";
  await writeFile(join(workspacePath, ".sops.yaml"), creationRules);
  const sourceContent = sourceState === "encrypted"
    ? await encrypt(recipient, plaintext, environment)
    : plaintext;
  await writeFile(sourcePath, sourceContent, { mode: 0o640 });
  await chmod(sourcePath, 0o640);
  const runtimeRoot = await prepareRuntimeRoot(undefined, testRoot);
  const sessionDirectory = await SecureSessionDirectory.create(runtimeRoot);
  return {
    testRoot,
    workspacePath,
    sourcePath,
    recipient,
    environment,
    sops: new SopsClient("sops", environment),
    sessionDirectory,
    plaintext
  };
}

function candidateEntries(entries: readonly string[]): string[] {
  return entries.filter((name) => name.includes(".sops-safe-"));
}

async function disposeFixture(fixture: Fixture): Promise<void> {
  await fixture.sessionDirectory.dispose();
  await rm(fixture.testRoot, { recursive: true });
}

async function saveFixture(fixture: Fixture, plaintext: Uint8Array): Promise<Buffer> {
  const source = await readEncryptedFileSnapshot(fixture.sourcePath);
  return await saveEncryptedFile({
    sourcePath: fixture.sourcePath,
    sourceMode: source.mode,
    baseCiphertext: source.ciphertext,
    plaintext,
    sessionDirectory: fixture.sessionDirectory,
    sops: fixture.sops,
    editorRuntimePath: process.execPath,
    editorBridgePath: resolve(__dirname, "../src/editor-bridge.js")
  });
}

for (const postQuantum of [false, true]) {
  const keyKind = postQuantum ? "post-quantum age" : "conventional age";
  test(`save transaction preserves encryption with ${keyKind}`, async () => {
    const fixture = await createFixture(postQuantum);
    try {
      const updatedPlaintext = Buffer.from(`value: changed-${postQuantum ? "pq" : "classic"}\n`, "utf8");
      const updatedCiphertext = await saveFixture(fixture, updatedPlaintext);
      assert.deepEqual(await readFile(fixture.sourcePath), updatedCiphertext);
      assert.deepEqual(await fixture.sops.decrypt(fixture.sourcePath, updatedCiphertext), updatedPlaintext);
      assert.equal(await fixture.sops.isEncrypted(fixture.sourcePath), true);
      assert.equal((updatedCiphertext.toString("utf8").match(/recipient:/g) ?? []).length, 1);
      assert.equal((await stat(fixture.sourcePath)).mode & 0o777, 0o640);

      const workspaceEntries = await readdir(fixture.workspacePath);
      assert.equal(workspaceEntries.some((name) => name.includes(".sops-safe-")), false);
      for (const name of workspaceEntries) {
        assert.equal((await readFile(join(fixture.workspacePath, name))).includes(updatedPlaintext), false);
      }
    } finally {
      await disposeFixture(fixture);
    }
  });

  test(`encrypt in place uses a matching creation rule with ${keyKind}`, async () => {
    const fixture = await createFixture(postQuantum, "plain", true, "nested/secret.yaml");
    try {
      const ciphertext = await encryptPlaintextFile(fixture.sourcePath, fixture.sops);
      assert.deepEqual(await readFile(fixture.sourcePath), ciphertext);
      assert.deepEqual(await fixture.sops.decrypt(fixture.sourcePath, ciphertext), fixture.plaintext);
      assert.equal(await fixture.sops.isEncrypted(fixture.sourcePath), true);
      assert.equal((ciphertext.toString("utf8").match(/recipient:/g) ?? []).length, 1);
      assert.equal((await stat(fixture.sourcePath)).mode & 0o777, 0o640);

      const sourceDirectory = dirname(fixture.sourcePath);
      const sourceEntries = await readdir(sourceDirectory);
      assert.deepEqual(candidateEntries(sourceEntries), []);
      for (const name of sourceEntries) {
        assert.equal((await readFile(join(sourceDirectory, name))).includes(fixture.plaintext), false);
      }
    } finally {
      await disposeFixture(fixture);
    }
  });
}

test("encrypt in place rejects an already encrypted source", async () => {
  const fixture = await createFixture(false);
  try {
    const originalCiphertext = await readFile(fixture.sourcePath);
    await assert.rejects(
      async () => await encryptPlaintextFile(fixture.sourcePath, fixture.sops),
      AlreadyEncryptedSourceError
    );
    assert.deepEqual(await readFile(fixture.sourcePath), originalCiphertext);
    assert.deepEqual(candidateEntries(await readdir(fixture.workspacePath)), []);
  } finally {
    await disposeFixture(fixture);
  }
});

test("a missing creation rule leaves the plaintext source unchanged", async () => {
  const fixture = await createFixture(false, "plain", false);
  try {
    await assert.rejects(
      async () => await encryptPlaintextFile(fixture.sourcePath, fixture.sops),
      SopsOperationError
    );
    assert.deepEqual(await readFile(fixture.sourcePath), fixture.plaintext);
    assert.deepEqual(candidateEntries(await readdir(fixture.workspacePath)), []);
  } finally {
    await disposeFixture(fixture);
  }
});

test("invalid plaintext leaves no encrypted replacement candidate", async () => {
  const fixture = await createFixture(false, "plain");
  try {
    const invalidPlaintext = Buffer.from("value: [\n", "utf8");
    await writeFile(fixture.sourcePath, invalidPlaintext);
    await assert.rejects(
      async () => await encryptPlaintextFile(fixture.sourcePath, fixture.sops),
      SopsOperationError
    );
    assert.deepEqual(await readFile(fixture.sourcePath), invalidPlaintext);
    assert.deepEqual(candidateEntries(await readdir(fixture.workspacePath)), []);
  } finally {
    await disposeFixture(fixture);
  }
});

test("candidate validation failure removes the candidate and preserves the source", async () => {
  const fixture = await createFixture(false, "plain");
  try {
    const source = await readFileSnapshot(fixture.sourcePath);
    await assert.rejects(
      async () => await replaceWithEncryptedCandidate({
        sourcePath: fixture.sourcePath,
        sourceMode: source.mode,
        baseContent: source.content,
        candidateContent: Buffer.from("not encrypted\n", "utf8"),
        sops: { isEncrypted: async () => false }
      }),
      InvalidEncryptedCandidateError
    );
    assert.deepEqual(await readFile(fixture.sourcePath), fixture.plaintext);
    assert.deepEqual(candidateEntries(await readdir(fixture.workspacePath)), []);
  } finally {
    await disposeFixture(fixture);
  }
});

test("invalid plaintext leaves the encrypted source unchanged", async () => {
  const fixture = await createFixture(false);
  try {
    const originalCiphertext = await readFile(fixture.sourcePath);
    await assert.rejects(
      async () => await saveFixture(fixture, Buffer.from("value: [\n", "utf8")),
      SopsOperationError
    );
    assert.deepEqual(await readFile(fixture.sourcePath), originalCiphertext);
    assert.deepEqual(candidateEntries(await readdir(fixture.workspacePath)), []);
  } finally {
    await disposeFixture(fixture);
  }
});

test("a stale encrypted source is never replaced", async () => {
  const fixture = await createFixture(false);
  try {
    const base = await readEncryptedFileSnapshot(fixture.sourcePath);
    const externalPlaintext = Buffer.from("value: external\n", "utf8");
    const externalCiphertext = await encrypt(fixture.recipient, externalPlaintext, fixture.environment);
    await writeFile(fixture.sourcePath, externalCiphertext);
    await assert.rejects(
      async () => await saveEncryptedFile({
        sourcePath: fixture.sourcePath,
        sourceMode: base.mode,
        baseCiphertext: base.ciphertext,
        plaintext: Buffer.from("value: local\n", "utf8"),
        sessionDirectory: fixture.sessionDirectory,
        sops: fixture.sops,
        editorRuntimePath: process.execPath,
        editorBridgePath: resolve(__dirname, "../src/editor-bridge.js")
      }),
      StaleSourceError
    );
    assert.deepEqual(await readFile(fixture.sourcePath), externalCiphertext);
  } finally {
    await disposeFixture(fixture);
  }
});

test("an unsafe XDG runtime directory is rejected", async () => {
  await assert.rejects(async () => await prepareRuntimeRoot(undefined, "/tmp"), RuntimeSecurityError);
});
