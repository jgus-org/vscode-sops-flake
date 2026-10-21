{
  description = "Agent-aware, security-conscious SOPS editing for VS Code.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    flake-lib = {
      url = "github:jgus-org/flake-lib/v1";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-lib,
      treefmt-nix,
    }:
    flake-lib.lib.eachDefaultLinuxSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

        treefmtEval = treefmt-nix.lib.evalModule pkgs {
          projectRootFile = "flake.nix";
          programs.nixfmt.enable = true;
          programs.shfmt.enable = true;
          programs.prettier.enable = true;
          # Unscoped prettier claims *.yaml/*.json and would reflow secrets.yaml, package-lock.json and the release workflows.
          programs.prettier.includes = [
            "*.ts"
            "*.mjs"
          ];
        };

        vsix = pkgs.stdenvNoCC.mkDerivation {
          name = "sops-safe-${version}.vsix";
          pname = "sops-safe-vsix";
          inherit version;
          src = ./.;

          npmDeps = pkgs.importNpmLock { npmRoot = ./.; };

          nativeBuildInputs = with pkgs; [
            age
            librsvg
            nodejs
            importNpmLock.npmConfigHook
            sops
          ];

          npmInstallFlags = [ "--ignore-scripts" ];
          npmRebuildFlags = [ "--ignore-scripts" ];

          buildPhase = ''
            runHook preBuild
            npm run build
            runHook postBuild
          '';

          doCheck = true;
          checkPhase = ''
            runHook preCheck
            export TMPDIR=/dev/shm
            npm test
            runHook postCheck
          '';

          installPhase = ''
            runHook preInstall
            npm run package
            cp "sops-safe-${version}.vsix" "$out"
            runHook postInstall
          '';
        };

        sops-safe = pkgs.vscode-utils.buildVscodeExtension {
          pname = "sops-safe";
          inherit version;
          vscodeExtPublisher = "jgus";
          vscodeExtName = "sops-safe";
          vscodeExtUniqueId = "jgus.sops-safe";
          src = vsix;
          passthru = { inherit vsix; };
          meta = {
            description = "Agent-aware, security-conscious SOPS editing for VS Code";
            license = pkgs.lib.licenses.mit;
            platforms = pkgs.lib.platforms.linux;
          };
        };

        version-stamp = pkgs.writeShellApplication {
          name = "version-stamp";
          runtimeInputs = [
            pkgs.nodejs
            pkgs.jq
            pkgs.coreutils
          ];
          text = builtins.readFile ./scripts/version-stamp.sh;
        };

        ovsx = pkgs.writeShellApplication {
          name = "ovsx";
          runtimeInputs = [
            pkgs.sops
            pkgs.nodejs
          ];
          text = ''
            set +x
            open_vsx_pat=$(sops decrypt --extract '["open_vsx_pat"]' ${./secrets.yaml})
            if [[ -z "$open_vsx_pat" ]]; then
              echo "open_vsx_pat is empty" >&2
              exit 1
            fi
            OVSX_PAT="$open_vsx_pat" exec npx --yes --ignore-scripts --package=ovsx@1.2.0 -- ovsx "$@"
          '';
        };
      in
      {
        packages = {
          inherit sops-safe vsix;
          default = sops-safe;
        };

        formatter = treefmtEval.config.build.wrapper;
        checks = {
          default = sops-safe;
          formatting = treefmtEval.config.build.check self;
        };
        apps.version-stamp = {
          type = "app";
          program = "${version-stamp}/bin/version-stamp";
        };
        devShells.default = pkgs.mkShellNoCC {
          packages = with pkgs; [
            age
            librsvg
            nodejs
            sops
            ovsx
            version-stamp
          ];
        };
      }
    );
}
