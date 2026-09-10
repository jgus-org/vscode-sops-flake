import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isStrictDescendant, privateTmpfsDirectoryViolations, RuntimeSecurityError } from "./secure-runtime.js";

export type SecurityStatus = "safe" | "unsafe" | "unverifiable";

export interface SecurityFinding {
  boundary: "backup-storage" | "extension-host";
  status: SecurityStatus;
  detail: string;
  untrustedExtensionIds?: readonly string[];
}

export interface SecurityPosture {
  status: SecurityStatus;
  findings: readonly SecurityFinding[];
}

export interface InstalledExtension {
  id: string;
  extensionPath: string;
}

export class SecurityWarningGate {
  private readonly reported = new Set<string>();

  takeUnreported(posture: SecurityPosture): SecurityPosture | undefined {
    const findings = posture.findings.filter(
      (finding) => finding.status !== "safe" && !this.reported.has(this.key(finding))
    );
    if (findings.length === 0) {
      return undefined;
    }
    const unreported = combineSecurityFindings(findings);
    this.markReported(unreported);
    return unreported;
  }

  markReported(posture: SecurityPosture): void {
    for (const finding of posture.findings) {
      if (finding.status !== "safe") {
        this.reported.add(this.key(finding));
      }
    }
  }

  reset(): void {
    this.reported.clear();
  }

  resetBoundary(boundary: SecurityFinding["boundary"]): void {
    const prefix = `${boundary}\0`;
    for (const key of this.reported) {
      if (key.startsWith(prefix)) {
        this.reported.delete(key);
      }
    }
  }

  private key(finding: SecurityFinding): string {
    return `${finding.boundary}\0${finding.status}\0${finding.detail}`;
  }
}

export function normalizeExtensionIds(extensionIds: readonly string[]): string[] {
  return [...new Set(extensionIds.map((id) => id.trim().toLowerCase()).filter((id) => id.length > 0))].sort();
}

export function extensionIdsFromSetting(value: unknown): string[] {
  return normalizeExtensionIds(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
}

export function mergeExtensionIds(current: readonly string[], additions: readonly string[]): string[] {
  return normalizeExtensionIds([...current, ...additions]);
}

export function untrustedExtensionIds(finding: SecurityFinding): string[] {
  return normalizeExtensionIds(finding.untrustedExtensionIds ?? []);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "an unknown error occurred";
}

export function backupDirectoryFromGlobalStorage(globalStoragePath: string): string | undefined {
  if (!isAbsolute(globalStoragePath)) {
    return undefined;
  }
  const globalStorageDirectory = dirname(resolve(globalStoragePath));
  if (basename(globalStorageDirectory) !== "globalStorage") {
    return undefined;
  }
  const userDirectory = dirname(globalStorageDirectory);
  if (basename(userDirectory) !== "User") {
    return undefined;
  }
  return join(dirname(userDirectory), "Backups");
}

export async function inspectBackupStorage(globalStorageScheme: string, globalStoragePath: string): Promise<SecurityFinding> {
  if (globalStorageScheme !== "file" && globalStorageScheme !== "vscode-userdata") {
    return {
      boundary: "backup-storage",
      status: "unverifiable",
      detail: `VS Code backup storage cannot be derived from the ${globalStorageScheme} global-storage URI.`
    };
  }
  const backupDirectory = backupDirectoryFromGlobalStorage(globalStoragePath);
  if (backupDirectory === undefined) {
    return {
      boundary: "backup-storage",
      status: "unverifiable",
      detail: `VS Code backup storage cannot be derived from ${globalStoragePath}.`
    };
  }
  try {
    const violations = await privateTmpfsDirectoryViolations(backupDirectory);
    if (violations.length > 0) {
      return {
        boundary: "backup-storage",
        status: "unsafe",
        detail: violations.join(" ")
      };
    }
    return {
      boundary: "backup-storage",
      status: "safe",
      detail: `${backupDirectory} is a private tmpfs directory.`
    };
  } catch (error) {
    return {
      boundary: "backup-storage",
      status: error instanceof RuntimeSecurityError ? "unsafe" : "unverifiable",
      detail: `VS Code backup storage at ${backupDirectory} could not be verified: ${errorMessage(error)}.`
    };
  }
}

export function inspectExtensionHost(
  appRoot: string,
  ownExtensionId: string,
  trustedExtensionIds: readonly string[],
  installedExtensions: readonly InstalledExtension[]
): SecurityFinding {
  if (!isAbsolute(appRoot)) {
    return {
      boundary: "extension-host",
      status: "unverifiable",
      detail: `The VS Code application root is not absolute: ${appRoot}.`,
      untrustedExtensionIds: []
    };
  }
  const builtInRoot = resolve(appRoot, "extensions");
  const trusted = new Set([ownExtensionId, ...trustedExtensionIds].map((id) => id.toLowerCase()));
  const untrusted: string[] = [];
  const unverifiable: string[] = [];
  for (const extension of installedExtensions) {
    if (trusted.has(extension.id.toLowerCase())) {
      continue;
    }
    if (!isAbsolute(extension.extensionPath)) {
      unverifiable.push(extension.id);
      continue;
    }
    if (!isStrictDescendant(builtInRoot, resolve(extension.extensionPath))) {
      untrusted.push(extension.id);
    }
  }
  untrusted.sort();
  unverifiable.sort();
  if (untrusted.length > 0) {
    const unknown = unverifiable.length > 0 ? ` Extension locations are also unverifiable for: ${unverifiable.join(", ")}.` : "";
    return {
      boundary: "extension-host",
      status: "unsafe",
      detail: `Non-built-in extensions outside the trusted set share decrypted documents: ${untrusted.join(", ")}.${unknown}`,
      untrustedExtensionIds: normalizeExtensionIds([...untrusted, ...unverifiable])
    };
  }
  if (unverifiable.length > 0) {
    return {
      boundary: "extension-host",
      status: "unverifiable",
      detail: `Extension locations are unverifiable for: ${unverifiable.join(", ")}.`,
      untrustedExtensionIds: normalizeExtensionIds(unverifiable)
    };
  }
  return {
    boundary: "extension-host",
    status: "safe",
    detail: "Only built-in and explicitly trusted extensions share decrypted documents.",
    untrustedExtensionIds: []
  };
}

export function combineSecurityFindings(findings: readonly SecurityFinding[]): SecurityPosture {
  const status = findings.some((finding) => finding.status === "unsafe")
    ? "unsafe"
    : findings.some((finding) => finding.status === "unverifiable")
      ? "unverifiable"
      : "safe";
  return { status, findings };
}

export function formatSecurityFinding(finding: SecurityFinding): string {
  if (finding.boundary === "backup-storage") {
    if (finding.status === "safe") {
      return `VS Code plaintext backup storage is contained. ${finding.detail}`;
    }
    if (finding.status === "unsafe") {
      return `VS Code backup storage can retain SOPS plaintext. ${finding.detail}`;
    }
    return `VS Code plaintext backup storage could not be verified. ${finding.detail}`;
  }
  if (finding.status === "safe") {
    return `Extension access to SOPS decrypted documents is contained. ${finding.detail}`;
  }
  if (finding.status === "unsafe") {
    return `Other extensions can observe SOPS decrypted documents. ${finding.detail}`;
  }
  return `Extension access to SOPS decrypted documents could not be verified. ${finding.detail}`;
}
