# Release and publisher administration

Extension ID: **`jgus.sops-safe`**. Both registries use publisher/namespace **`jgus`**.

## Verify a publication

| Destination | Public listing | What to check |
| --- | --- | --- |
| Visual Studio Marketplace | [SOPS Safe](https://marketplace.visualstudio.com/items?itemName=jgus.sops-safe) | The version in the listing and its Version History tab matches the GitHub release. |
| Open VSX Registry | [SOPS Safe](https://open-vsx.org/extension/jgus/sops-safe) | The displayed version matches the release; the [latest-version API](https://open-vsx.org/api/jgus/sops-safe/latest) also exposes `version` and `files.download`. |

In the editor's Extensions view, search for `@id:jgus.sops-safe` and inspect the version. VS Code uses Visual Studio Marketplace; [code-server normally uses Open VSX](https://coder.com/docs/code-server/FAQ#why-cant-code-server-use-microsofts-extension-marketplace), unless its gallery configuration has been overridden.

Check the publishing step's log as well as the workflow's overall result: Microsoft `check-auth` does not publish, and both publishers skip an already-existing version. The [latest GitHub release](https://github.com/jgus-org/vscode-sops-flake/releases/latest) is the reference version and VSIX.

For an API check of Open VSX:

```bash
curl --fail --silent --show-error https://open-vsx.org/api/jgus/sops-safe/latest \
  | jq '{namespace, name, version, download: .files.download}'
```

Microsoft's publisher reports that a listing can take **a few minutes** to appear, and public availability follows malware scanning. Open VSX documents **5–10 seconds** for normal asynchronous processing, with longer waits for large packages, load, or review. These are availability estimates, not guaranteed search-index update times. Use the direct listing/API before relying on search results.

Timing references: [vsce publishing message](https://github.com/microsoft/vscode-vsce/blob/v3.9.2/src/publish.ts#L253), [Marketplace protections](https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security#marketplace-protections), [Open VSX processing and review](https://github.com/EclipseFdn/open-vsx.org/wiki/Publishing-Extensions#6-see-the-result).

## GitHub

| Entrypoint | Purpose |
| --- | --- |
| [Release VSIX](https://github.com/jgus-org/vscode-sops-flake/actions/workflows/release.yml) | Run on `main` with the next version. Stamps, builds/tests, commits, tags, and creates the GitHub release. |
| [Publish to Visual Studio Marketplace](https://github.com/jgus-org/vscode-sops-flake/actions/workflows/publish-visual-studio.yml) | Run on `main`; `publish` is the default. Optional `check-auth` prints the Marketplace member ID. |
| [Publish to Open VSX Registry](https://github.com/jgus-org/vscode-sops-flake/actions/workflows/publish-open-vsx.yml) | Run on `main` to publish the latest release to Open VSX. |
| [Releases](https://github.com/jgus-org/vscode-sops-flake/releases) | Inspect tags, release notes, and attached VSIX files. |
| [Actions variables](https://github.com/jgus-org/vscode-sops-flake/settings/variables/actions) | `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`: the Entra application and directory IDs. |
| [Actions secrets](https://github.com/jgus-org/vscode-sops-flake/settings/secrets/actions) | `OVSX_PAT`: the Open VSX publishing token. |
| [Actions settings](https://github.com/jgus-org/vscode-sops-flake/settings/actions) | Workflow permissions and repository Actions policy. |

The publishing actions are independent. Each resolves the latest release when its download step runs; wait for both workflows to finish before creating another release if they should publish the same version. Retry only the destination that needs it.

## Microsoft

The publishing application is **`sops-safe GitHub publishing`**. GitHub OIDC signs in through its federated credential; Marketplace publisher membership grants permission to publish under `jgus`.

| Entrypoint | Where to go / purpose |
| --- | --- |
| [Marketplace publisher management: jgus](https://marketplace.visualstudio.com/manage/publishers/jgus) | Manage extension versions, inspect validation status, and open **Members** to manage publisher access. |
| [All Marketplace publishers](https://marketplace.visualstudio.com/manage) | Publisher selector if the direct publisher page opens in the wrong account. |
| [Microsoft Entra admin center](https://entra.microsoft.com/) | Select the application's directory, then **Entra ID → App registrations → sops-safe GitHub publishing**. Overview has the client/tenant IDs; **Certificates & secrets → Federated credentials** holds the GitHub trust. |
| [Enterprise applications in Entra](https://entra.microsoft.com/) | **Entra ID → Enterprise apps → sops-safe GitHub publishing**. This is the service principal; its Object ID differs from the app registration's Object ID. |
| [Azure portal](https://portal.azure.com/) | Azure account/subscription administration and an alternative entry to Microsoft Entra ID. |
| [Azure DevOps organization selector](https://aex.dev.azure.com/me) | Open the existing organization in the application's Entra directory. **Organization settings → Microsoft Entra ID** manages the directory connection; **Organization settings → Users** manages the service principal's organization access. |

If the organization disappears from the selector after switching directories, use its original direct URL, `https://dev.azure.com/<organization>`. The organization name is not recorded in this repository; bookmark that URL once inside it. Select the same Entra directory as the application (called **Default Directory** during initial setup).

The Marketplace member ID returned by `check-auth` is **`7dcdc600-bc78-4d61-9720-c0c1616909d2`**. It was added to publisher `jgus` with **Contributor** access. This ID is distinct from the client ID and either Entra Object ID.

The configured GitHub federated credential uses:

| Field | Value |
| --- | --- |
| Issuer | `https://token.actions.githubusercontent.com` |
| Subject | `repo:jgus-org@326239378/vscode-sops-flake@1363387762:ref:refs/heads/main` |
| Audience | `api://AzureADTokenExchange` |

Reference: [Microsoft application/service-principal distinction](https://learn.microsoft.com/en-us/entra/identity-platform/app-objects-and-service-principals), [Marketplace Entra authentication](https://learn.microsoft.com/en-us/azure/devops/extend/publish/command-line?view=azure-devops#publish-with-a-microsoft-entra-token).

## Open VSX / Eclipse

Sign in to Open VSX with the GitHub account that owns the publishing token. Its linked Eclipse account supplies the Publisher Agreement.

| Entrypoint | Purpose |
| --- | --- |
| [Access tokens](https://open-vsx.org/user-settings/tokens) | Create/revoke publishing tokens. Update the GitHub `OVSX_PAT` secret when rotating the CI token. |
| [Profile and Publisher Agreement](https://open-vsx.org/user-settings/profile) | Link the Eclipse account and inspect/sign the Open VSX Publisher Agreement. |
| [Namespace settings](https://open-vsx.org/user-settings/namespaces) | Inspect `jgus` membership and ownership. |
| [Published extension settings](https://open-vsx.org/user-settings/extensions) | Manage published extensions and inspect processing/review status. |
| [Eclipse account](https://accounts.eclipse.org/) | Manage the Eclipse identity linked to the Open VSX profile. |
| [Namespace ownership guide](https://github.com/EclipseFdn/open-vsx.org/wiki/Managing-Namespaces) | Request verified ownership; a namespace verification warning is separate from successful publication. |
| [Registry support/issues](https://github.com/EclipseFdn/open-vsx.org/issues) | Report registry or review problems. |

The local devshell's `ovsx` wrapper reads `open_vsx_pat` from SOPS-encrypted `secrets.yaml`; CI uses the separately configured `OVSX_PAT` Actions secret. If both should use a rotated token, update both locations.

Reference: [Official Open VSX publishing guide](https://github.com/EclipseFdn/open-vsx.org/wiki/Publishing-Extensions).
