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
          name = "vscode-sops-${version}.vsix";
          pname = "vscode-sops-vsix";
          inherit version;
          src = ./.;

          npmDeps = pkgs.fetchNpmDeps {
            src = ./.;
            hash = "sha256-IyF3oFz7MQ9m6E4FQAhYZOivAH7ErK10P9h8no8Uqq0=";
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
            cp "vscode-sops-${version}.vsix" "$out"
            runHook postInstall
          '';
        };

        vscode-sops = pkgs.vscode-utils.buildVscodeExtension {
          pname = "vscode-sops";
          inherit version;
          vscodeExtPublisher = "jgus";
          vscodeExtName = "vscode-sops";
          vscodeExtUniqueId = "jgus.vscode-sops";
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
          inherit vscode-sops vsix;
          default = vscode-sops;
        };
        checks.default = vscode-sops;
        devShells.default = pkgs.mkShellNoCC {
          packages = with pkgs; [
            age
            nodejs
            sops
          ];
        };
      });
}
