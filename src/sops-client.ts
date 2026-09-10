import { dirname } from "node:path";
import { CommandFailure, CommandStartError, runCommand } from "./process.js";

function operationMessage(summary: string, error: unknown): string {
  if (!(error instanceof CommandFailure)) {
    return summary;
  }
  const detail = error.stderr.trim();
  return detail.length === 0 ? summary : `${summary} ${detail}`;
}

export type SopsFileStatus = "encrypted" | "plain";

export class SopsUnavailableError extends Error {
  constructor(cause: unknown) {
    super("The SOPS executable is unavailable.", { cause });
    this.name = "SopsUnavailableError";
  }
}

export class SopsOperationError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "SopsOperationError";
  }
}

export class SopsClient {
  constructor(
    readonly executable: string,
    private readonly environment: NodeJS.ProcessEnv = process.env
  ) {}

  withEnvironment(environment: NodeJS.ProcessEnv): SopsClient {
    return new SopsClient(this.executable, { ...this.environment, ...environment });
  }

  async fileStatus(filePath: string): Promise<SopsFileStatus> {
    let output: Buffer;
    try {
      output = await runCommand(this.executable, ["filestatus", filePath], { environment: this.environment });
    } catch (error) {
      if (error instanceof CommandStartError) {
        throw new SopsUnavailableError(error);
      }
      throw new SopsOperationError(operationMessage("SOPS could not determine the source encryption status.", error), error);
    }

    try {
      const status: unknown = JSON.parse(output.toString("utf8"));
      if (typeof status === "object" && status !== null && "encrypted" in status && typeof status.encrypted === "boolean") {
        return status.encrypted ? "encrypted" : "plain";
      }
    } catch (error) {
      throw new SopsOperationError("SOPS returned an invalid source encryption status.", error);
    }
    throw new SopsOperationError("SOPS returned an invalid source encryption status.", new Error("Missing encrypted status."));
  }

  async isEncrypted(filePath: string): Promise<boolean> {
    try {
      return await this.fileStatus(filePath) === "encrypted";
    } catch (error) {
      if (error instanceof SopsUnavailableError) {
        throw error;
      }
      return false;
    }
  }

  async encrypt(filePath: string, plaintext: Uint8Array): Promise<Buffer> {
    try {
      return await runCommand(
        this.executable,
        ["encrypt", "--filename-override", filePath],
        { input: plaintext, environment: this.environment, workingDirectory: dirname(filePath) }
      );
    } catch (error) {
      if (error instanceof CommandStartError) {
        throw new SopsUnavailableError(error);
      }
      throw new SopsOperationError(operationMessage("SOPS could not encrypt the plaintext source.", error), error);
    }
  }

  async decrypt(filePath: string, ciphertext: Uint8Array): Promise<Buffer> {
    try {
      return await runCommand(
        this.executable,
        ["decrypt", "--filename-override", filePath],
        { input: ciphertext, environment: this.environment }
      );
    } catch (error) {
      if (error instanceof CommandStartError) {
        throw new SopsUnavailableError(error);
      }
      throw new SopsOperationError(operationMessage("SOPS could not decrypt the encrypted source.", error), error);
    }
  }

  async edit(filePath: string): Promise<void> {
    try {
      await runCommand(this.executable, ["edit", filePath], { environment: this.environment });
    } catch (error) {
      if (error instanceof CommandStartError) {
        throw new SopsUnavailableError(error);
      }
      throw new SopsOperationError(operationMessage("SOPS could not encrypt the edited document.", error), error);
    }
  }
}
