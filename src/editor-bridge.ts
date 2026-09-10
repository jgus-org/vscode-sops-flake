import { constants, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertPrivateFile,
  assertPrivateTmpfsDirectory,
  isStrictDescendant
} from "./secure-runtime.js";

async function main(): Promise<void> {
  const targetPath = process.argv[2];
  const plaintextPath = process.env.VSCODE_SOPS_PLAINTEXT;
  const markerPath = process.env.VSCODE_SOPS_EDIT_MARKER;
  const runtimePath = process.env.VSCODE_SOPS_RUNTIME;
  if (targetPath === undefined || plaintextPath === undefined || markerPath === undefined || runtimePath === undefined) {
    throw new Error("The editor bridge environment is incomplete.");
  }

  const normalizedRuntime = resolve(runtimePath);
  const normalizedTarget = resolve(targetPath);
  const normalizedPlaintext = resolve(plaintextPath);
  const normalizedMarker = resolve(markerPath);
  await assertPrivateTmpfsDirectory(normalizedRuntime);
  if (
    !isStrictDescendant(normalizedRuntime, normalizedTarget) ||
    !isStrictDescendant(normalizedRuntime, normalizedPlaintext) ||
    !isStrictDescendant(normalizedRuntime, normalizedMarker)
  ) {
    throw new Error("The editor bridge path escaped its runtime directory.");
  }
  if (await realpath(normalizedTarget) !== normalizedTarget) {
    throw new Error("The SOPS editor target contains a symbolic-link path component.");
  }
  await assertPrivateFile(normalizedTarget);
  await assertPrivateFile(normalizedPlaintext);

  const markerHandle = await open(
    normalizedMarker,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await markerHandle.chmod(0o600);
    await markerHandle.sync();
  } finally {
    await markerHandle.close();
  }

  const plaintextHandle = await open(normalizedPlaintext, constants.O_RDONLY | constants.O_NOFOLLOW);
  const targetHandle = await open(normalizedTarget, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
  try {
    const plaintext = await plaintextHandle.readFile();
    await targetHandle.chmod(0o600);
    await targetHandle.writeFile(plaintext);
    await targetHandle.sync();
  } finally {
    await targetHandle.close();
    await plaintextHandle.close();
  }
}

void main().catch(() => {
  process.exitCode = 1;
});
