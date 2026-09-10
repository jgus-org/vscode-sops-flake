import { spawn } from "node:child_process";

export class CommandStartError extends Error {
  constructor(executable: string, cause: unknown) {
    super(`${executable} could not be started.`, { cause });
    this.name = "CommandStartError";
  }
}

export class CommandFailure extends Error {
  constructor(
    executable: string,
    readonly code: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly stderr: string
  ) {
    const status = code === null ? signal ?? "unknown" : code.toString();
    const detail = stderr.trim();
    super(`${executable} exited with status ${status}.${detail.length === 0 ? "" : ` ${detail}`}`);
    this.name = "CommandFailure";
  }
}

export interface CommandOptions {
  input?: Uint8Array;
  environment?: NodeJS.ProcessEnv;
  workingDirectory?: string;
}

export async function runCommand(
  executable: string,
  arguments_: readonly string[],
  options: CommandOptions = {}
): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: options.workingDirectory,
      env: options.environment ?? process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    let startFailure: unknown;

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errorChunks.push(chunk));
    child.stdin.on("error", () => undefined);
    child.once("error", (error) => {
      startFailure = error;
    });
    child.once("close", (code, signal) => {
      if (startFailure !== undefined) {
        reject(new CommandStartError(executable, startFailure));
        return;
      }
      if (code !== 0) {
        reject(new CommandFailure(executable, code, signal, Buffer.concat(errorChunks).toString("utf8")));
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    child.stdin.end(options.input);
  });
}
