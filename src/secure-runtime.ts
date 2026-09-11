import {
  constants,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  statfs,
  unlink
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const TMPFS_MAGIC = 0x01021994;

export class RuntimeSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeSecurityError";
  }
}

function effectiveUid(): number {
  if (process.geteuid === undefined) {
    throw new RuntimeSecurityError("The extension requires a local Linux process with an effective user ID.");
  }
  return process.geteuid();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function isStrictDescendant(parentPath: string, childPath: string): boolean {
  const pathFromParent = relative(parentPath, childPath);
  return pathFromParent.length > 0 && pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent);
}

export async function privateTmpfsDirectoryViolations(directoryPath: string): Promise<string[]> {
  const normalizedPath = resolve(directoryPath);
  const directoryStats = await lstat(normalizedPath);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    return [`${normalizedPath} is not a non-symlink directory.`];
  }
  const violations: string[] = [];
  if (directoryStats.uid !== effectiveUid()) {
    violations.push(`${normalizedPath} is not owned by the effective user.`);
  }
  if ((directoryStats.mode & 0o077) !== 0) {
    violations.push(`${normalizedPath} is accessible by another user or group.`);
  }
  if (await realpath(normalizedPath) !== normalizedPath) {
    violations.push(`${normalizedPath} contains a symbolic-link path component.`);
  }
  if ((await statfs(normalizedPath)).type !== TMPFS_MAGIC) {
    violations.push(`${normalizedPath} is not on tmpfs.`);
  }
  return violations;
}

export async function assertPrivateTmpfsDirectory(directoryPath: string): Promise<void> {
  const violations = await privateTmpfsDirectoryViolations(directoryPath);
  if (violations.length > 0) {
    throw new RuntimeSecurityError(violations.join(" "));
  }
}

export async function assertPrivateFile(filePath: string): Promise<void> {
  const fileStats = await lstat(filePath);
  if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
    throw new RuntimeSecurityError(`${filePath} is not a non-symlink regular file.`);
  }
  if (fileStats.uid !== effectiveUid()) {
    throw new RuntimeSecurityError(`${filePath} is not owned by the effective user.`);
  }
  if ((fileStats.mode & 0o077) !== 0) {
    throw new RuntimeSecurityError(`${filePath} is accessible by another user or group.`);
  }
}

async function createPrivateDescendants(runtimeDirectory: string, rootPath: string): Promise<void> {
  const pathFromRuntime = relative(runtimeDirectory, rootPath);
  let currentPath = runtimeDirectory;
  for (const component of pathFromRuntime.split(sep)) {
    currentPath = join(currentPath, component);
    try {
      await mkdir(currentPath, 0o700);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
    }
    await assertPrivateTmpfsDirectory(currentPath);
  }
}

export async function prepareRuntimeRoot(
  configuredRoot?: string,
  xdgRuntimeDirectory = process.env.XDG_RUNTIME_DIR
): Promise<string> {
  if (xdgRuntimeDirectory === undefined || !isAbsolute(xdgRuntimeDirectory)) {
    throw new RuntimeSecurityError("XDG_RUNTIME_DIR is not an absolute path.");
  }
  const runtimeDirectory = resolve(xdgRuntimeDirectory);
  await assertPrivateTmpfsDirectory(runtimeDirectory);

  if (configuredRoot !== undefined && !isAbsolute(configuredRoot)) {
    throw new RuntimeSecurityError("The configured runtime directory is not an absolute path.");
  }
  const rootPath = resolve(configuredRoot ?? join(runtimeDirectory, "sops-safe"));
  if (!isStrictDescendant(runtimeDirectory, rootPath)) {
    throw new RuntimeSecurityError("The extension runtime directory is not beneath XDG_RUNTIME_DIR.");
  }
  await createPrivateDescendants(runtimeDirectory, rootPath);
  return rootPath;
}

export class SecureSessionDirectory {
  private disposed = false;

  private constructor(
    readonly rootPath: string,
    readonly path: string
  ) {}

  static async create(rootPath: string): Promise<SecureSessionDirectory> {
    await assertPrivateTmpfsDirectory(rootPath);
    const sessionPath = await mkdtemp(join(rootPath, "session-"));
    await assertPrivateTmpfsDirectory(sessionPath);
    return new SecureSessionDirectory(rootPath, sessionPath);
  }

  filePath(name: string): string {
    if (name.length === 0 || basename(name) !== name) {
      throw new RuntimeSecurityError("A runtime filename escaped its session directory.");
    }
    return join(this.path, name);
  }

  async writePrivateFile(name: string, content: Uint8Array): Promise<string> {
    const filePath = this.filePath(name);
    const handle = await open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    try {
      await handle.chmod(0o600);
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertPrivateFile(filePath);
    return filePath;
  }

  async removeFile(filePath: string): Promise<void> {
    if (!isStrictDescendant(this.path, resolve(filePath))) {
      throw new RuntimeSecurityError("A runtime file escaped its session directory.");
    }
    try {
      await unlink(filePath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    await assertPrivateTmpfsDirectory(this.path);
    if (!isStrictDescendant(this.rootPath, this.path)) {
      throw new RuntimeSecurityError("A runtime session escaped the extension runtime directory.");
    }
    await rm(this.path, { recursive: true });
    this.disposed = true;
  }
}
