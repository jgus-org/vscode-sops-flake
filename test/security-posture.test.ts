import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  backupDirectoryFromGlobalStorage,
  combineSecurityFindings,
  extensionIdsFromSetting,
  formatSecurityFinding,
  inspectBackupStorage,
  inspectExtensionHost,
  mergeExtensionIds,
  SecurityWarningGate,
  untrustedExtensionIds
} from "../src/security-posture.js";

test("backup storage is derived for desktop VS Code and code-server", () => {
  assert.equal(
    backupDirectoryFromGlobalStorage("/home/josh/.config/Code/User/globalStorage/jgus.sops-safe"),
    "/home/josh/.config/Code/Backups"
  );
  assert.equal(
    backupDirectoryFromGlobalStorage("/home/josh/.local/share/code-server/User/globalStorage/jgus.sops-safe"),
    "/home/josh/.local/share/code-server/Backups"
  );
  assert.equal(backupDirectoryFromGlobalStorage("/unexpected/storage/jgus.sops-safe"), undefined);
});

test("a private tmpfs backup directory is safe and a public one is unsafe", async () => {
  const rootPath = await mkdtemp("/dev/shm/vscode-sops-posture-");
  const backupPath = join(rootPath, "Code", "Backups");
  const globalStoragePath = join(rootPath, "Code", "User", "globalStorage", "jgus.sops-safe");
  try {
    await mkdir(backupPath, { recursive: true, mode: 0o700 });
    await chmod(backupPath, 0o700);
    assert.equal((await inspectBackupStorage("file", globalStoragePath)).status, "safe");
    assert.equal((await inspectBackupStorage("vscode-userdata", globalStoragePath)).status, "safe");

    await chmod(backupPath, 0o755);
    const unsafe = await inspectBackupStorage("file", globalStoragePath);
    assert.equal(unsafe.status, "unsafe");
    assert.match(unsafe.detail, /accessible by another user or group/);
  } finally {
    await rm(rootPath, { recursive: true });
  }
});

test("a non-local backup storage URI is unverifiable", async () => {
  assert.equal((await inspectBackupStorage("untitled", "/User/globalStorage/jgus.sops-safe")).status, "unverifiable");
  assert.equal((await inspectBackupStorage("file", "/unexpected/storage/jgus.sops-safe")).status, "unverifiable");
});

test("built-in, current, and explicitly trusted extensions are accepted", () => {
  const finding = inspectExtensionHost(
    "/nix/store/vscode/resources/app",
    "jgus.sops-safe",
    ["trusted.extension"],
    [
      { id: "vscode.json", extensionPath: "/nix/store/vscode/resources/app/extensions/json" },
      { id: "jgus.sops-safe", extensionPath: "/nix/store/sops-safe" },
      { id: "trusted.extension", extensionPath: "/home/josh/.vscode/extensions/trusted.extension" }
    ]
  );

  assert.equal(finding.status, "safe");
});

test("non-built-in extensions outside the trusted set are unsafe", () => {
  const finding = inspectExtensionHost(
    "/nix/store/vscode/resources/app",
    "jgus.sops-safe",
    [],
    [
      { id: "vscode.json", extensionPath: "/nix/store/vscode/resources/app/extensions/json" },
      { id: "unknown.extension", extensionPath: "/home/josh/.vscode/extensions/unknown.extension" }
    ]
  );

  assert.equal(finding.status, "unsafe");
  assert.match(finding.detail, /unknown\.extension/);
  assert.deepEqual(finding.untrustedExtensionIds, ["unknown.extension"]);
});

test("invalid extension locations are unverifiable", () => {
  const finding = inspectExtensionHost(
    "/nix/store/vscode/resources/app",
    "jgus.sops-safe",
    [],
    [{ id: "unknown.extension", extensionPath: "relative/path" }]
  );

  assert.equal(finding.status, "unverifiable");
});

test("unsafe findings dominate unverifiable and safe findings", () => {
  const posture = combineSecurityFindings([
    { boundary: "backup-storage", status: "safe", detail: "safe backup" },
    { boundary: "extension-host", status: "unsafe", detail: "unsafe extension" },
    { boundary: "extension-host", status: "unverifiable", detail: "unknown extension" }
  ]);

  assert.equal(posture.status, "unsafe");
});

test("backup and extension findings have distinct messages", () => {
  assert.equal(
    formatSecurityFinding({ boundary: "backup-storage", status: "unsafe", detail: "backup detail" }),
    "VS Code backup storage can retain SOPS plaintext. backup detail"
  );
  assert.equal(
    formatSecurityFinding({ boundary: "extension-host", status: "unsafe", detail: "extension detail" }),
    "Other extensions can observe SOPS decrypted documents. extension detail"
  );
});

test("extension settings are normalized and merged by identifier", () => {
  assert.deepEqual(extensionIdsFromSetting([" B.Extension ", 3, "a.extension", "b.extension"]), ["a.extension", "b.extension"]);
  assert.deepEqual(extensionIdsFromSetting("a.extension"), []);
  assert.deepEqual(mergeExtensionIds(["b.extension"], ["A.Extension", "b.extension"]), ["a.extension", "b.extension"]);
});

test("untrusted extension identifiers are normalized from their finding", () => {
  assert.deepEqual(
    untrustedExtensionIds({
      boundary: "extension-host",
      status: "unsafe",
      detail: "unsafe extensions",
      untrustedExtensionIds: ["B.Extension", "a.extension"]
    }),
    ["a.extension", "b.extension"]
  );
});

test("automatic posture warnings deduplicate findings and detect changes", () => {
  const gate = new SecurityWarningGate();
  const backup = { boundary: "backup-storage" as const, status: "unsafe" as const, detail: "unsafe backup" };
  const firstExtensions = {
    boundary: "extension-host" as const,
    status: "unsafe" as const,
    detail: "extension a",
    untrustedExtensionIds: ["a.extension"]
  };
  const secondExtensions = {
    boundary: "extension-host" as const,
    status: "unsafe" as const,
    detail: "extension b",
    untrustedExtensionIds: ["b.extension"]
  };

  const first = combineSecurityFindings([backup, firstExtensions]);
  assert.deepEqual(gate.takeUnreported(first), first);
  assert.equal(gate.takeUnreported(first), undefined);
  assert.equal(gate.takeUnreported(combineSecurityFindings([backup])), undefined);
  assert.deepEqual(gate.takeUnreported(combineSecurityFindings([backup, secondExtensions])), combineSecurityFindings([secondExtensions]));

  gate.resetBoundary("extension-host");
  assert.deepEqual(gate.takeUnreported(first), combineSecurityFindings([firstExtensions]));

  gate.reset();
  assert.deepEqual(gate.takeUnreported(first), first);
});

test("trusted extensions are machine-scoped and resettable from the command palette", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    contributes: {
      commands: Array<{ command: string }>;
      configuration: { properties: Record<string, { scope?: string }> };
    };
  };

  assert.equal(packageJson.contributes.configuration.properties["vscode-sops.trustedExtensions"]?.scope, "machine");
  assert.equal(
    packageJson.contributes.commands.some(({ command }) => command === "vscode-sops.resetTrustedExtensions"),
    true
  );
});
