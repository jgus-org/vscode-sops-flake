import { constants, open } from "node:fs/promises";

export interface EncryptedFileSnapshot {
  ciphertext: Buffer;
  mode: number;
}

export interface FileSnapshot {
  content: Buffer;
  mode: number;
}

export class SourceFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceFileError";
  }
}

export async function readFileSnapshot(filePath: string): Promise<FileSnapshot> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new SourceFileError("The source is not a regular file.");
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new SourceFileError("The source changed while it was being read.");
    }
    return { content, mode: before.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

export async function readEncryptedFileSnapshot(filePath: string): Promise<EncryptedFileSnapshot> {
  const snapshot = await readFileSnapshot(filePath);
  return { ciphertext: snapshot.content, mode: snapshot.mode };
}
