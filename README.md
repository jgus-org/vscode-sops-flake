# SOPS Safe

**Edit encrypted files like ordinary files—without a plaintext working copy.**

SOPS Safe detects encrypted local text files through SOPS, opens them in a native VS Code editor, and re-encrypts them when you save. You keep syntax highlighting, formatting, validation, and the familiar `Ctrl+S` workflow; the file in your workspace remains ciphertext.

That distinction matters in an agentic editor. Internet-backed coding agents can assemble model context from files in your workspace; a decrypted sibling file can become part of a prompt sent to a remote model provider just as accidentally as it can become a Git commit. SOPS Safe never creates that file, so filesystem-based agents and indexers continue to find ciphertext.

## Why SOPS Safe?

Most SOPS extensions optimize the editing workflow. SOPS Safe also treats plaintext lifetime and save failure as product features.

- **No plaintext workspace copy for agents to ingest.** The decrypted editor is backed by an in-memory virtual document rather than a sibling file beside your secret.
- **No extension-managed plaintext on persistent storage.** When SOPS needs a file during save, it exists only in a verified private tmpfs beneath `$XDG_RUNTIME_DIR`, with owner-only permissions and symlink checks.
- **Encrypted, transactional saves.** SOPS Safe builds a candidate beside the source, verifies that it is encrypted, checks twice that the source has not changed, syncs it, and atomically replaces the original.
- **An honest VS Code threat model.** Native text documents can be observed by VS Code backup storage and other extensions. SOPS Safe checks both boundaries and warns instead of claiming that a virtual document alone makes plaintext invisible.
- **SOPS stays in charge.** Detection, decryption, recipients, creation rules, and file-format semantics come from your installed SOPS binary. There is no second parser or key configuration to drift from SOPS itself.

### Designed for coding-agent safety

SOPS Safe reduces accidental **file-based** disclosure to coding agents, search indexes, and other tools that crawl the workspace. It does not claim to isolate the live editor: an agent implemented as a VS Code extension with text-document access can still observe the decrypted document. SOPS Safe includes such extensions in its security-posture warning unless you explicitly trust them.

### Compared with `@signageos/vscode-sops`

[`@signageos/vscode-sops`](https://marketplace.visualstudio.com/items?itemName=signageos.signageos-vscode-sops) is the established, broad, cross-platform option. SOPS Safe makes a narrower choice: Linux only, with stricter plaintext handling and commit semantics.

| | SOPS Safe | `@signageos/vscode-sops` 0.9.4 |
|---|---|---|
| Editable plaintext | In-memory virtual document | `.decrypted~...` file beside the ciphertext |
| Workspace agents and indexers | Find ciphertext, not a plaintext working file | Can discover the `.decrypted~...` plaintext sibling |
| Plaintext needed during save | Verified private tmpfs beneath `$XDG_RUNTIME_DIR` | General OS temporary directory |
| Replacing the source | Encrypted candidate, validation, stale-source checks, sync, atomic rename | Encrypted buffer written through the VS Code workspace API |
| Editor exposure | Checks VS Code backups and co-hosted extensions | No documented security-posture check |
| Platform focus | Linux | Linux, macOS, and Windows |

The signageOS behavior above is taken from its pinned 0.9.4 source: the [decrypted sibling workflow](https://github.com/signageos/vscode-sops/blob/36dda639ab69d5c38a635906aca410e59cfb26da/src/extension.ts#L227-L285) and the [temporary plaintext used during save](https://github.com/signageos/vscode-sops/blob/36dda639ab69d5c38a635906aca410e59cfb26da/src/extension.ts#L340-L400).

Choose signageOS when cross-platform support and its larger configuration surface matter most. Choose SOPS Safe when you edit secrets on Linux and want the risks around coding-agent disclosure, plaintext persistence, concurrent changes, interrupted saves, and extension-host exposure treated as first-class concerns.

## How it feels

1. Open an encrypted file in a trusted local workspace.
2. SOPS Safe recognizes it through `sops filestatus` and opens the decrypted virtual document automatically.
3. Edit with your normal VS Code language support.
4. Save normally. Only validated ciphertext replaces the source file.

To encrypt a new or existing plaintext file, save it first and run **SOPS: Encrypt in Place**. SOPS Safe uses the matching `creation_rules` entry from `.sops.yaml`; if encryption fails, the plaintext source is left unchanged.

## Security posture

Run **SOPS: Check Security Posture** at any time. SOPS Safe reports two boundaries independently:

- whether VS Code's `Backups` directory is a private tmpfs;
- whether every enabled, non-built-in extension sharing the extension host has been explicitly trusted.

**Trust Current Extensions** records the reported extension IDs in the machine-local `vscode-sops.trustedExtensions` setting. Newly installed extensions warn independently. **SOPS: Reset Trusted Extensions** clears that decision.

This is exposure reduction, not a sandbox. VS Code, built-in extensions, extensions you trust, the operating system, debuggers, screen capture, and the clipboard remain part of your security boundary.

## Requirements

- Linux with a private tmpfs-backed `$XDG_RUNTIME_DIR`
- VS Code 1.85 or newer
- [SOPS](https://github.com/getsops/sops) available on `PATH`, or configured with `vscode-sops.sopsPath`
- a trusted, local workspace
- working credentials for the recipients already in the file, or matching `.sops.yaml` creation rules when encrypting plaintext

SOPS Safe deliberately does not support untrusted workspaces, virtual workspaces, macOS, or Windows.

## Commands

| Command | Purpose |
|---|---|
| **SOPS: Open Decrypted** | Open the active encrypted local file explicitly |
| **SOPS: Encrypt in Place** | Encrypt a saved plaintext workspace file transactionally |
| **SOPS: Check Security Posture** | Re-check backup storage and extension-host exposure |
| **SOPS: Reset Trusted Extensions** | Clear the machine-local extension trust list |

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `vscode-sops.sopsPath` | `sops` | SOPS executable used for detection, decryption, and encryption |
| `vscode-sops.runtimeDirectory` | `$XDG_RUNTIME_DIR/vscode-sops` | Private runtime directory; must remain beneath `$XDG_RUNTIME_DIR` |
| `vscode-sops.trustedExtensions` | `[]` | Machine-local IDs allowed to share the extension host with decrypted documents |

## Installation

SOPS Safe uses the extension ID `jgus.sops-safe`. If you previously installed `jgus.vscode-sops`, including through Nix, remove the old extension when switching to SOPS Safe; the new ID is a separate installation, and running both causes command and filesystem-provider conflicts. For desktop VS Code installations made from a VSIX, including Home Manager VSIX installs, run `code --uninstall-extension jgus.vscode-sops` and reload VS Code after switching. Existing `vscode-sops.*` settings and command IDs, including custom keybindings, remain valid.

Nix users can select `packages.<system>.sops-safe`; `packages.<system>.vscode-sops` remains an alias for existing consumers. The alias points to the new extension ID and does not remove an old installation.

Download `sops-safe-<version>.vsix` from the assets on the [GitHub releases page](https://github.com/jgus-org/vscode-sops-flake/releases).

- **VS Code:** Run **Extensions: Install from VSIX** from the Command Palette and select the downloaded file.
- **code-server:** Copy the downloaded file to the code-server host and run `code-server --install-extension /path/to/sops-safe-<version>.vsix` there.

## License

MIT
