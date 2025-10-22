{
  description = "Cashu Gateway development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    pre-commit-hooks = {
      url = "github:cachix/pre-commit-hooks.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
    pre-commit-hooks,
  }:
    flake-utils.lib.eachDefaultSystem (
      system: let
        pkgs = nixpkgs.legacyPackages.${system};

        pre-commit-check = pre-commit-hooks.lib.${system}.run {
          src = ./.;
          hooks = {
            biome-check = {
              enable = true;
              name = "biome check";
              entry = "${pkgs.bun}/bin/bun run check";
              files = "\\.(ts|tsx|js|jsx|json)$";
              pass_filenames = false;
            };
            typecheck = {
              enable = true;
              name = "typescript typecheck";
              entry = "${pkgs.bun}/bin/bun x tsc --noEmit";
              files = "\\.(ts|tsx)$";
              pass_filenames = false;
            };
            alejandra = {
              enable = true;
              name = "alejandra";
              entry = "${pkgs.alejandra}/bin/alejandra";
              files = "\\.nix$";
            };
            prettier = {
              enable = true;
              name = "prettier";
              entry = "${pkgs.nodePackages.prettier}/bin/prettier --write";
              files = "\\.(md|markdown)$";
            };
          };
        };
      in {
        checks = {
          pre-commit = pre-commit-check;
        };

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            bun
            alejandra
            nodePackages.prettier
          ];

          shellHook = ''
            ${pre-commit-check.shellHook}

            alias alice='bun cli alice'
            alias dealer='bun cli dealer'
            alias gateway='bun cli gateway'
          '';
        };
      }
    );
}
