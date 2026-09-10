import { randomUUID } from "node:crypto";
import { replaceWithEncryptedCandidate } from "./encrypted-replacement.js";
import { SecureSessionDirectory } from "./secure-runtime.js";
import { SopsClient } from "./sops-client.js";

export { InvalidEncryptedCandidateError, StaleSourceError } from "./encrypted-replacement.js";

export interface SaveTransactionOptions {
  sourcePath: string;
  sourceMode: number;
  baseCiphertext: Buffer;
  plaintext: Uint8Array;
  sessionDirectory: SecureSessionDirectory;
  sops: SopsClient;
  editorRuntimePath: string;
  editorBridgePath: string;
}

function quoteShellArgument(argument: string): string {
  return `'${argument.replaceAll("'", `'"'"'`)}'`;
}

export async function saveEncryptedFile(options: SaveTransactionOptions): Promise<Buffer> {
  const plaintextPath = await options.sessionDirectory.writePrivateFile(
    `plaintext-${randomUUID()}`,
    options.plaintext
  );
  const markerPath = options.sessionDirectory.filePath(`edited-${randomUUID()}`);

  try {
    return await replaceWithEncryptedCandidate({
      sourcePath: options.sourcePath,
      sourceMode: options.sourceMode,
      baseContent: options.baseCiphertext,
      candidateContent: options.baseCiphertext,
      sops: options.sops,
      transformCandidate: async (candidatePath) => {
        const editingSops = options.sops.withEnvironment({
          TMPDIR: options.sessionDirectory.path,
          TMP: options.sessionDirectory.path,
          TEMP: options.sessionDirectory.path,
          ELECTRON_RUN_AS_NODE: "1",
          SOPS_EDITOR: `${quoteShellArgument(options.editorRuntimePath)} ${quoteShellArgument(options.editorBridgePath)}`,
          VSCODE_SOPS_PLAINTEXT: plaintextPath,
          VSCODE_SOPS_EDIT_MARKER: markerPath,
          VSCODE_SOPS_RUNTIME: options.sessionDirectory.path
        });
        await editingSops.edit(candidatePath);
      }
    });
  } finally {
    await Promise.allSettled([
      options.sessionDirectory.removeFile(plaintextPath),
      options.sessionDirectory.removeFile(markerPath)
    ]);
  }
}
