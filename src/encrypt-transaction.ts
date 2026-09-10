import { readFileSnapshot } from "./encrypted-file.js";
import { replaceWithEncryptedCandidate } from "./encrypted-replacement.js";
import { SopsClient } from "./sops-client.js";

export class AlreadyEncryptedSourceError extends Error {
  constructor() {
    super("The source file is already SOPS-encrypted.");
    this.name = "AlreadyEncryptedSourceError";
  }
}

export async function encryptPlaintextFile(sourcePath: string, sops: SopsClient): Promise<Buffer> {
  const source = await readFileSnapshot(sourcePath);
  if (await sops.fileStatus(sourcePath) === "encrypted") {
    throw new AlreadyEncryptedSourceError();
  }
  const ciphertext = await sops.encrypt(sourcePath, source.content);
  return await replaceWithEncryptedCandidate({
    sourcePath,
    sourceMode: source.mode,
    baseContent: source.content,
    candidateContent: ciphertext,
    sops
  });
}
