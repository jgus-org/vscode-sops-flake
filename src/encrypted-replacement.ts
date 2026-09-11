import { randomUUID } from "node:crypto";
import { constants, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { readFileSnapshot } from "./encrypted-file.js";
import { SopsClient } from "./sops-client.js";

export class StaleSourceError extends Error {
  constructor() {
    super("The source file changed during the encryption transaction.");
    this.name = "StaleSourceError";
  }
}

export class InvalidEncryptedCandidateError extends Error {
  constructor() {
    super("SOPS produced a candidate that is not encrypted.");
    this.name = "InvalidEncryptedCandidateError";
  }
}

export interface EncryptedReplacementOptions {
  sourcePath: string;
  sourceMode: number;
  baseContent: Buffer;
  candidateContent: Uint8Array;
  sops: Pick<SopsClient, "isEncrypted">;
  transformCandidate?: (candidatePath: string) => Promise<void>;
}

function candidatePathFor(sourcePath: string): string {
  const sourceName = basename(sourcePath);
  const sourceExtension = extname(sourceName);
  const sourceStem = sourceExtension.length === 0 ? sourceName : sourceName.slice(0, -sourceExtension.length);
  return join(dirname(sourcePath), `.${sourceStem}.sops-safe-${randomUUID()}${sourceExtension}`);
}

async function writeCandidate(filePath: string, content: Uint8Array, mode: number): Promise<void> {
  const handle = await open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.chmod(mode);
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeCandidate(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

async function assertSourceUnchanged(sourcePath: string, baseContent: Buffer): Promise<void> {
  const current = await readFileSnapshot(sourcePath);
  if (!current.content.equals(baseContent)) {
    throw new StaleSourceError();
  }
}

export async function replaceWithEncryptedCandidate(options: EncryptedReplacementOptions): Promise<Buffer> {
  await assertSourceUnchanged(options.sourcePath, options.baseContent);
  const candidatePath = candidatePathFor(options.sourcePath);
  let committed = false;

  try {
    await writeCandidate(candidatePath, options.candidateContent, options.sourceMode);
    await options.transformCandidate?.(candidatePath);
    if (!(await options.sops.isEncrypted(candidatePath))) {
      throw new InvalidEncryptedCandidateError();
    }
    const candidate = await readFileSnapshot(candidatePath);
    await assertSourceUnchanged(options.sourcePath, options.baseContent);
    await syncFile(candidatePath);
    await rename(candidatePath, options.sourcePath);
    committed = true;
    await syncDirectory(dirname(options.sourcePath));
    return candidate.content;
  } finally {
    if (!committed) {
      await removeCandidate(candidatePath);
    }
  }
}
