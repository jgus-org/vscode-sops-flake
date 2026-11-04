# AGENTS.md

This file provides shared guidance to agents working in this repository. `CLAUDE.md` is a compatibility symlink to this file.

This flake follows the fleet flake standard: [jgus-org/flake-lib `AGENTS.md`](https://github.com/jgus-org/flake-lib/blob/v1/AGENTS.md). It owns what belongs in `flake.nix`, `pin.nix`, and `flake.lock`, how to author a producer, the update workflows, the build gate, and every rule a flake in this fleet follows. Read it before changing this flake, and read the library at the revision this flake's `flake.lock` names for anything a caller passes to it.

Anything specific to this repository belongs here. Anything the standard states belongs to the standard, which this file links rather than restating.

`README.md` is the extension's storefront: the Visual Studio Marketplace and Open VSX both render it as the product page, and it is bundled into the released `.vsix` through `package.json`'s `files` list. Its prose is user-facing product copy, not developer documentation, so NEVER bulk-edit it (e.g. during a review sweep.) Targeted, _specifically-requested_ edits only.
