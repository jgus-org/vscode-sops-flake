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
        version = "0.1.0";

        vsix = pkgs.stdenvNoCC.mkDerivation {
          name = "sops-safe-${version}.vsix";
          pname = "sops-safe-vsix";
          inherit version;
          src = ./.;

          npmDeps = pkgs.fetchNpmDeps {
            src = ./.;
            hash = "sha256-DA+vqQKaNsIiAGlJ5u43X6YlvIMG817+EK6+bgXCqPo=";
          };

          nativeBuildInputs = with pkgs; [
            age
            nodejs
            npmHooks.npmConfigHook
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

        ovsx = pkgs.writeShellApplication {
          name = "ovsx";
          text = ''
            exec ${pkgs.python3}/bin/python3 ${./scripts/ovsx.py} \
              --sops ${pkgs.sops}/bin/sops \
              --npx ${pkgs.nodejs}/bin/npx \
              --secrets ${./secrets.yaml} -- "$@"
          '';
        };
      in
      {
        packages = {
          inherit sops-safe vsix;
          default = sops-safe;
        };
        checks.default = sops-safe;
        checks.ovsx-wrapper = pkgs.runCommand "ovsx-wrapper-tests" {
          nativeBuildInputs = [ pkgs.python3 ];
        } ''
          python3 ${./test/ovsx-wrapper.test.py} ${./scripts/ovsx.py}
          touch "$out"
        '';
        devShells.default = pkgs.mkShellNoCC {
          packages = with pkgs; [
            age
            nodejs
            sops
            ovsx
          ];
        };
      });
}
