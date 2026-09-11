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
          name = "safe-sops-${version}.vsix";
          pname = "safe-sops-vsix";
          inherit version;
          src = ./.;

          npmDeps = pkgs.fetchNpmDeps {
            src = ./.;
            hash = "sha256-otfVaRwoBv8uE+XUUnHyGRJaBqc5/KdrkPHvq9Q5qk8=";
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
            cp "safe-sops-${version}.vsix" "$out"
            runHook postInstall
          '';
        };

        safe-sops = pkgs.vscode-utils.buildVscodeExtension {
          pname = "safe-sops";
          inherit version;
          vscodeExtPublisher = "jgus";
          vscodeExtName = "safe-sops";
          vscodeExtUniqueId = "jgus.safe-sops";
          src = vsix;
          passthru = { inherit vsix; };
          meta = {
            description = "Agent-aware, security-conscious SOPS editing for VS Code";
            license = pkgs.lib.licenses.mit;
            platforms = pkgs.lib.platforms.linux;
          };
        };
      in
      {
        packages = {
          inherit safe-sops vsix;
          # Preserve the output consumed by existing flake users.
          vscode-sops = safe-sops;
          default = safe-sops;
        };
        checks.default = safe-sops;
        devShells.default = pkgs.mkShellNoCC {
          packages = with pkgs; [
            age
            nodejs
            sops
          ];
        };
      });
}
