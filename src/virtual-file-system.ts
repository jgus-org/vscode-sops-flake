import * as vscode from "vscode";
import { EncryptedSession } from "./session.js";

export class SopsFileSystemProvider implements vscode.FileSystemProvider {
  private readonly sessions = new Map<string, EncryptedSession>();
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

  readonly onDidChangeFile = this.changes.event;

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const session = this.session(uri);
    return {
      type: vscode.FileType.File,
      ctime: session.mtime,
      mtime: session.mtime,
      size: session.size
    };
  }

  readDirectory(): [string, vscode.FileType][] {
    throw vscode.FileSystemError.FileNotADirectory();
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  readFile(uri: vscode.Uri): Uint8Array {
    return this.session(uri).content;
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    try {
      await this.session(uri).save(content);
      this.changes.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    } catch (error) {
      throw vscode.FileSystemError.Unavailable(error instanceof Error ? error.message : "The encrypted document could not be saved.");
    }
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  register(uri: vscode.Uri, session: EncryptedSession): void {
    this.sessions.set(uri.toString(), session);
    this.changes.fire([{ type: vscode.FileChangeType.Created, uri }]);
  }

  get(uri: vscode.Uri): EncryptedSession | undefined {
    return this.sessions.get(uri.toString());
  }

  async unregister(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const session = this.sessions.get(key);
    if (session === undefined) {
      return;
    }
    this.sessions.delete(key);
    this.changes.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    await session.dispose();
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.changes.dispose();
    await Promise.all(sessions.map(async (session) => await session.dispose()));
  }

  private session(uri: vscode.Uri): EncryptedSession {
    const session = this.get(uri);
    if (session === undefined) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return session;
  }
}
