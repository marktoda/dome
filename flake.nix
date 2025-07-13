{
  description = "Astrolabe - A local-first, MCP-compatible task-navigation platform";
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-25.05";
  };
  outputs = {
    self,
    nixpkgs,
  }: let
    supportedSystems = ["x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin"];
    forEachSupportedSystem = f:
      nixpkgs.lib.genAttrs supportedSystems (system:
        f {
          pkgs = import nixpkgs {
            inherit system;
          };
        });
  in {
    devShells = forEachSupportedSystem ({pkgs, ...}: {
      default = pkgs.mkShell {
        packages = with pkgs; [
          openssl
          prisma
          # Node.js ecosystem
          nodejs_22
          pnpm

          # Development tools
          biome
        ];

        shellHook = ''
          # Setup npm global directory in project
          export NPM_CONFIG_PREFIX="$PWD/.npm-global"
          export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
          mkdir -p "$NPM_CONFIG_PREFIX"

          npm install -g @astrotask/cli
          npm install -g @astrotask/mcp

          # Set Biome binary path for consistency
          export BIOME_BINARY="${pkgs.biome}/bin/biome"

          echo "🚀 Astrolabe development environment ready!"
          echo "   Node.js: $(node --version)"
          echo "   pnpm: $(pnpm --version)"
          echo "   Task Master: $(task-master --version 2>/dev/null || echo 'installing...')"
        '';
      };
    });
  };
}
