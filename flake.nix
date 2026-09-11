{
  description = "Agent-aware, security-conscious SOPS editing for VS Code.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachSystem [ "x86_64-linux" "aarch64-linux" ] (system:
      let
        pkgs = import nixpkgs { inherit system; };
        version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

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
          runtimeInputs = [ pkgs.nodejs pkgs.jq pkgs.coreutils ];
          text = builtins.readFile ./scripts/version-stamp.sh;
        };

        ovsx = pkgs.writeShellApplication {
          name = "ovsx";
          runtimeInputs = [ pkgs.sops pkgs.nodejs ];
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
        checks.default = sops-safe;
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
      });
}
