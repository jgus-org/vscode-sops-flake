import { readEncryptedFileSnapshot } from "./encrypted-file.js";
import { saveEncryptedFile } from "./save-transaction.js";
import { SecureSessionDirectory } from "./secure-runtime.js";
import { SopsClient } from "./sops-client.js";

export interface EncryptedSessionOptions {
  sourcePath: string;
  sourceMode: number;
  ciphertext: Buffer;
  plaintext: Buffer;
  sessionDirectory: SecureSessionDirectory;
  sops: SopsClient;
  editorRuntimePath: string;
  editorBridgePath: string;
}

export class EncryptedSession {
  private ciphertext: Buffer;
  private plaintext: Buffer;
  private saveTail: Promise<void> = Promise.resolve();
  private modifiedAt = Date.now();

  private constructor(private readonly options: EncryptedSessionOptions) {
    this.ciphertext = options.ciphertext;
    this.plaintext = options.plaintext;
  }

  static async open(
    sourcePath: string,
    sessionDirectory: SecureSessionDirectory,
    sops: SopsClient,
    editorRuntimePath: string,
    editorBridgePath: string
  ): Promise<EncryptedSession> {
    const source = await readEncryptedFileSnapshot(sourcePath);
    const plaintext = await sops.decrypt(sourcePath, source.ciphertext);
    return new EncryptedSession({
      sourcePath,
      sourceMode: source.mode,
      ciphertext: source.ciphertext,
      plaintext,
      sessionDirectory,
      sops,
      editorRuntimePath,
      editorBridgePath
    });
  }

  get sourcePath(): string {
    return this.options.sourcePath;
  }

  get content(): Buffer {
    return Buffer.from(this.plaintext);
  }

  get size(): number {
    return this.plaintext.byteLength;
  }

  get mtime(): number {
    return this.modifiedAt;
  }

  async save(plaintext: Uint8Array): Promise<void> {
    const operation = this.saveTail.then(async () => {
      const updatedCiphertext = await saveEncryptedFile({
        sourcePath: this.options.sourcePath,
        sourceMode: this.options.sourceMode,
        baseCiphertext: this.ciphertext,
        plaintext,
        sessionDirectory: this.options.sessionDirectory,
        sops: this.options.sops,
        editorRuntimePath: this.options.editorRuntimePath,
        editorBridgePath: this.options.editorBridgePath
      });
      this.ciphertext = updatedCiphertext;
      this.plaintext = Buffer.from(plaintext);
      this.modifiedAt = Date.now();
    });
    this.saveTail = operation.catch(() => undefined);
    await operation;
  }

  async dispose(): Promise<void> {
    await this.saveTail;
    await this.options.sessionDirectory.dispose();
  }
}
