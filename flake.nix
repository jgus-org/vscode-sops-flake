{
  description = "Agent-aware, security-conscious SOPS editing for VS Code.";

  inputs = {
    flake-lib.url = "github:jgus-org/flake-lib/v1";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  };

  outputs =
    {
      self,
      flake-lib,
      nixpkgs,
    }:
    flake-lib.lib.eachDefaultLinuxSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

        orgFormatting = flake-lib.lib.mkFormatting {
          inherit self system;
          excludes = [
            "package-lock.json"
            "secrets.yaml"
          ];
        };

        vsix = pkgs.stdenvNoCC.mkDerivation {
          inherit version;
          buildPhase = ''
            runHook preBuild
            npm run build
            runHook postBuild
          '';
          checkPhase = ''
            runHook preCheck
            export TMPDIR=/dev/shm
            npm test
            runHook postCheck
          '';
          doCheck = true;
          installPhase = ''
            runHook preInstall
            npm run package
            cp "sops-safe-${version}.vsix" "$out"
            runHook postInstall
          '';
          name = "sops-safe-${version}.vsix";
          nativeBuildInputs = with pkgs; [
            age
            librsvg
            nodejs
            importNpmLock.npmConfigHook
            sops
          ];
          npmDeps = pkgs.importNpmLock { npmRoot = ./.; };
          npmInstallFlags = [ "--ignore-scripts" ];
          npmRebuildFlags = [ "--ignore-scripts" ];
          pname = "sops-safe-vsix";
          src = ./.;
        };

        sops-safe = pkgs.vscode-utils.buildVscodeExtension {
          inherit version;
          meta = {
            description = "Agent-aware, security-conscious SOPS editing for VS Code";
            license = pkgs.lib.licenses.mit;
            platforms = pkgs.lib.platforms.linux;
          };
          passthru = { inherit vsix; };
          pname = "sops-safe";
          src = vsix;
          vscodeExtName = "sops-safe";
          vscodeExtPublisher = "jgus";
          vscodeExtUniqueId = "jgus.sops-safe";
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
        apps.version-stamp = {
          program = "${version-stamp}/bin/version-stamp";
          type = "app";
        };
        checks = {
          default = sops-safe;
          formatting = orgFormatting.check;
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
        formatter = orgFormatting.formatter;
        packages = {
          inherit sops-safe vsix;
          default = sops-safe;
        };
      }
    );
}
