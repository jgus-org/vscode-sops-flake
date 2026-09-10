import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { encryptPlaintextFile } from "./encrypt-transaction.js";
import { prepareRuntimeRoot, SecureSessionDirectory } from "./secure-runtime.js";
import { EncryptedSession } from "./session.js";
import {
  combineSecurityFindings,
  extensionIdsFromSetting,
  formatSecurityFinding,
  inspectBackupStorage,
  inspectExtensionHost,
  mergeExtensionIds,
  SecurityFinding,
  SecurityPosture,
  SecurityWarningGate,
  untrustedExtensionIds
} from "./security-posture.js";
import { SourceLifecycle } from "./source-lifecycle.js";
import { SopsClient, SopsUnavailableError } from "./sops-client.js";
import { SopsFileSystemProvider } from "./virtual-file-system.js";

const TRUST_CURRENT_EXTENSIONS = "Trust Current Extensions";

class ExtensionController {
  private readonly provider = new SopsFileSystemProvider();
  private readonly lifecycle = new SourceLifecycle();
  private readonly sourceSessions = new Map<string, vscode.Uri>();
  private readonly opening = new Map<string, Promise<vscode.Uri>>();
  private readonly disposables: vscode.Disposable[] = [];
  private runtimeRoot: Promise<string> | undefined;
  private unavailableReported = false;
  private readonly postureWarning = new SecurityWarningGate();

  constructor(private readonly context: vscode.ExtensionContext) {}

  start(): void {
    this.disposables.push(
      vscode.workspace.registerFileSystemProvider("sops", this.provider, {
        isCaseSensitive: true,
        isReadonly: false
      }),
      vscode.commands.registerCommand("vscode-sops.openDecrypted", async (uri?: vscode.Uri) => {
        await this.openFromCommand(uri);
      }),
      vscode.commands.registerCommand("vscode-sops.encryptInPlace", async (uri?: vscode.Uri) => {
        await this.encryptFromCommand(uri);
      }),
      vscode.commands.registerCommand("vscode-sops.checkSecurityPosture", async () => {
        await this.showSecurityPosture();
      }),
      vscode.commands.registerCommand("vscode-sops.resetTrustedExtensions", async () => {
        await this.resetTrustedExtensions();
      }),
      vscode.workspace.onDidOpenTextDocument((document) => {
        void this.consider(document);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        void this.closed(document);
      }),
      vscode.window.tabGroups.onDidChangeTabs((event) => {
        void this.tabsChanged(event);
      }),
      vscode.extensions.onDidChange(() => {
        if (this.sourceSessions.size > 0) {
          void this.warnAboutSecurityPosture();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("vscode-sops.trustedExtensions")) {
          this.postureWarning.resetBoundary("extension-host");
          if (this.sourceSessions.size > 0) {
            void this.warnAboutSecurityPosture();
          }
        }
      })
    );

    for (const document of vscode.workspace.textDocuments) {
      void this.consider(document);
    }
  }

  async dispose(): Promise<void> {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    await this.provider.dispose();
  }

  private configuredSops(): SopsClient {
    const executable = vscode.workspace.getConfiguration("vscode-sops").get<string>("sopsPath", "sops");
    return new SopsClient(executable);
  }

  private runtimeRootPath(): Promise<string> {
    this.runtimeRoot ??= prepareRuntimeRoot(
      vscode.workspace.getConfiguration("vscode-sops").get<string>("runtimeDirectory", "").trim() || undefined
    );
    return this.runtimeRoot;
  }

  private assertSupportedWorkspace(): void {
    if (!vscode.workspace.isTrusted) {
      throw new Error("SOPS editing is disabled in an untrusted workspace.");
    }
    if (vscode.workspace.workspaceFolders?.some((folder) => folder.uri.scheme !== "file") === true) {
      throw new Error("SOPS editing is unavailable in a virtual workspace.");
    }
  }

  private assertLocalWorkspaceFile(uri: vscode.Uri): void {
    this.assertSupportedWorkspace();
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (uri.scheme !== "file" || workspaceFolder === undefined || workspaceFolder.uri.scheme !== "file") {
      throw new Error("The active document is not a local file in the current workspace.");
    }
  }

  private async openFromCommand(argument?: vscode.Uri): Promise<void> {
    try {
      this.assertSupportedWorkspace();
      const sourceUri = argument ?? vscode.window.activeTextEditor?.document.uri;
      if (sourceUri === undefined || sourceUri.scheme !== "file") {
        throw new Error("The active document is not a local file.");
      }
      if (!(await this.configuredSops().isEncrypted(sourceUri.fsPath))) {
        throw new Error("The active document is not a readable SOPS-encrypted file.");
      }
      this.lifecycle.markEncrypted(sourceUri.fsPath);
      await this.openEncrypted(sourceUri, vscode.window.activeTextEditor?.document.languageId);
    } catch (error) {
      await vscode.window.showErrorMessage(error instanceof Error ? error.message : "The encrypted document could not be opened.");
    }
  }

  private async encryptFromCommand(argument?: vscode.Uri): Promise<void> {
    try {
      const sourceUri = argument ?? vscode.window.activeTextEditor?.document.uri;
      if (sourceUri === undefined) {
        throw new Error("There is no active document.");
      }
      this.assertLocalWorkspaceFile(sourceUri);
      const document = await vscode.workspace.openTextDocument(sourceUri);
      if (document.isDirty) {
        throw new Error("The plaintext document has unsaved changes.");
      }

      const sessionDirectory = await SecureSessionDirectory.create(await this.runtimeRootPath());
      try {
        const sops = this.configuredSops().withEnvironment({
          TMPDIR: sessionDirectory.path,
          TMP: sessionDirectory.path,
          TEMP: sessionDirectory.path
        });
        await encryptPlaintextFile(sourceUri.fsPath, sops);
      } finally {
        await sessionDirectory.dispose();
      }

      await this.closeSourceTabs(sourceUri.fsPath);
      this.lifecycle.markEncrypted(sourceUri.fsPath);
      await this.openEncrypted(sourceUri, document.languageId);
    } catch (error) {
      await vscode.window.showErrorMessage(error instanceof Error ? error.message : "The plaintext document could not be encrypted.");
    }
  }

  private async consider(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== "file") {
      return;
    }
    const sourceKey = document.uri.fsPath;
    if (!this.lifecycle.beginDetection(sourceKey)) {
      return;
    }
    let encrypted = false;
    try {
      this.assertSupportedWorkspace();
      encrypted = await this.configuredSops().isEncrypted(sourceKey);
      if (!this.lifecycle.detectionCompleted(sourceKey, encrypted)) {
        return;
      }
      if (encrypted) {
        await this.openEncrypted(document.uri, document.languageId);
      }
    } catch (error) {
      if (!encrypted) {
        this.lifecycle.detectionFailed(sourceKey);
      }
      if (error instanceof SopsUnavailableError && !this.unavailableReported) {
        this.unavailableReported = true;
        await vscode.window.showErrorMessage(error.message);
      } else if (encrypted) {
        await vscode.window.showErrorMessage(error instanceof Error ? error.message : "The encrypted document could not be opened.");
      }
    }
  }

  private async openEncrypted(sourceUri: vscode.Uri, languageId?: string): Promise<vscode.Uri> {
    await this.warnAboutSecurityPosture();
    const sourceKey = sourceUri.fsPath;
    const existing = this.sourceSessions.get(sourceKey);
    if (existing !== undefined) {
      await this.show(existing, languageId);
      return existing;
    }
    const pending = this.opening.get(sourceKey);
    if (pending !== undefined) {
      const virtualUri = await pending;
      await this.show(virtualUri, languageId);
      return virtualUri;
    }

    const operation = this.createSession(sourceUri);
    this.opening.set(sourceKey, operation);
    try {
      const virtualUri = await operation;
      await this.show(virtualUri, languageId);
      return virtualUri;
    } finally {
      this.opening.delete(sourceKey);
    }
  }

  private async createSession(sourceUri: vscode.Uri): Promise<vscode.Uri> {
    const sessionDirectory = await SecureSessionDirectory.create(await this.runtimeRootPath());
    const sops = this.configuredSops().withEnvironment({
      TMPDIR: sessionDirectory.path,
      TMP: sessionDirectory.path,
      TEMP: sessionDirectory.path
    });
    try {
      const session = await EncryptedSession.open(
        sourceUri.fsPath,
        sessionDirectory,
        sops,
        process.execPath,
        this.context.asAbsolutePath("dist/editor-bridge.js")
      );
      const virtualUri = sourceUri.with({ scheme: "sops", query: `session=${randomUUID()}` });
      this.provider.register(virtualUri, session);
      this.sourceSessions.set(sourceUri.fsPath, virtualUri);
      this.lifecycle.sessionOpened(sourceUri.fsPath);
      return virtualUri;
    } catch (error) {
      await sessionDirectory.dispose();
      throw error;
    }
  }

  private async show(uri: vscode.Uri, languageId?: string): Promise<void> {
    let document = await vscode.workspace.openTextDocument(uri);
    if (languageId !== undefined && document.languageId !== languageId) {
      document = await vscode.languages.setTextDocumentLanguage(document, languageId);
    }
    await vscode.window.showTextDocument(document, { preview: false });
  }

  private async closed(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme === "file") {
      this.lifecycle.sourceClosed(document.uri.fsPath);
      return;
    }
    if (document.uri.scheme !== "sops") {
      return;
    }
    await this.closeSession(document.uri);
  }

  private async tabsChanged(event: vscode.TabChangeEvent): Promise<void> {
    const closedUris = event.closed.flatMap((tab) => this.tabUris(tab));
    for (const uri of closedUris) {
      if (uri.scheme === "sops") {
        await this.closeSession(uri);
      }
    }
    for (const uri of closedUris) {
      if (uri.scheme === "file" && !this.sourceTabIsOpen(uri.fsPath)) {
        this.lifecycle.sourceClosed(uri.fsPath);
      }
    }
    for (const uri of event.opened.flatMap((tab) => this.tabUris(tab))) {
      if (uri.scheme === "file") {
        void this.considerOpenedUri(uri);
      }
    }
  }

  private async considerOpenedUri(uri: vscode.Uri): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const decision = this.lifecycle.sourceOpened(uri.fsPath);
      if (decision === "open") {
        await this.openEncrypted(uri, document.languageId);
      } else if (decision === "detect") {
        await this.consider(document);
      }
    } catch (error) {
      await vscode.window.showErrorMessage(error instanceof Error ? error.message : "The encrypted document could not be opened.");
    }
  }

  private async closeSession(uri: vscode.Uri): Promise<void> {
    const session = this.provider.get(uri);
    if (session !== undefined) {
      if (this.sourceSessions.get(session.sourcePath)?.toString() === uri.toString()) {
        this.sourceSessions.delete(session.sourcePath);
      }
      this.lifecycle.sessionClosed(session.sourcePath);
    }
    await this.provider.unregister(uri);
  }

  private sourceTabIsOpen(sourcePath: string): boolean {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (this.tabUris(tab).some((uri) => uri.scheme === "file" && uri.fsPath === sourcePath)) {
          return true;
        }
      }
    }
    return false;
  }

  private async closeSourceTabs(sourcePath: string): Promise<void> {
    const tabs = vscode.window.tabGroups.all.flatMap((group) =>
      group.tabs.filter((tab) => this.tabUris(tab).some((uri) => uri.scheme === "file" && uri.fsPath === sourcePath))
    );
    if (tabs.length > 0) {
      await vscode.window.tabGroups.close(tabs);
    }
  }

  private tabUris(tab: vscode.Tab): vscode.Uri[] {
    if (tab.input instanceof vscode.TabInputText || tab.input instanceof vscode.TabInputCustom) {
      return [tab.input.uri];
    }
    if (tab.input instanceof vscode.TabInputTextDiff) {
      return [tab.input.original, tab.input.modified];
    }
    return [];
  }

  private async inspectSecurityPosture(): Promise<SecurityPosture> {
    const backupStorage = await inspectBackupStorage(
      this.context.globalStorageUri.scheme,
      this.context.globalStorageUri.fsPath
    );
    const trustedExtensionIds = this.configuredTrustedExtensionIds();
    const extensionHost = inspectExtensionHost(
      vscode.env.appRoot,
      this.context.extension.id,
      trustedExtensionIds,
      vscode.extensions.all.map((extension) => ({
        id: extension.id,
        extensionPath: extension.extensionPath
      }))
    );
    return combineSecurityFindings([backupStorage, extensionHost]);
  }

  private async warnAboutSecurityPosture(): Promise<void> {
    const posture = await this.inspectSecurityPosture();
    const unreported = this.postureWarning.takeUnreported(posture);
    if (unreported !== undefined) {
      for (const finding of unreported.findings) {
        void this.showSecurityFindingWarning(finding);
      }
    }
  }

  private async showSecurityPosture(): Promise<void> {
    const posture = await this.inspectSecurityPosture();
    this.postureWarning.markReported(posture);
    for (const finding of posture.findings) {
      if (finding.status === "safe") {
        await vscode.window.showInformationMessage(formatSecurityFinding(finding));
      } else {
        await this.showSecurityFindingWarning(finding);
      }
    }
  }

  private configuredTrustedExtensionIds(): string[] {
    return extensionIdsFromSetting(
      vscode.workspace.getConfiguration("vscode-sops").get<unknown>("trustedExtensions")
    );
  }

  private async showSecurityFindingWarning(finding: SecurityFinding): Promise<void> {
    const extensionIds = finding.boundary === "extension-host" ? untrustedExtensionIds(finding) : [];
    const selection = extensionIds.length > 0
      ? await vscode.window.showWarningMessage(formatSecurityFinding(finding), TRUST_CURRENT_EXTENSIONS)
      : await vscode.window.showWarningMessage(formatSecurityFinding(finding));
    if (selection === TRUST_CURRENT_EXTENSIONS) {
      try {
        await this.trustExtensions(extensionIds);
      } catch (error) {
        await vscode.window.showErrorMessage(
          error instanceof Error ? `The trusted-extension setting could not be updated: ${error.message}` : "The trusted-extension setting could not be updated."
        );
      }
    }
  }

  private async trustExtensions(extensionIds: readonly string[]): Promise<void> {
    const configuration = vscode.workspace.getConfiguration("vscode-sops");
    const trusted = mergeExtensionIds(this.configuredTrustedExtensionIds(), extensionIds);
    await configuration.update("trustedExtensions", trusted, vscode.ConfigurationTarget.Global);
  }

  private async resetTrustedExtensions(): Promise<void> {
    await vscode.workspace
      .getConfiguration("vscode-sops")
      .update("trustedExtensions", undefined, vscode.ConfigurationTarget.Global);
    this.postureWarning.resetBoundary("extension-host");
    await vscode.window.showInformationMessage("The SOPS trusted-extension setting was reset.");
  }
}

let controller: ExtensionController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  controller = new ExtensionController(context);
  controller.start();
}

export async function deactivate(): Promise<void> {
  await controller?.dispose();
  controller = undefined;
}
