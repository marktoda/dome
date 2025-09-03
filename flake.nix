{
  description = "Dome";

  ######################################################################
  # 1. Inputs
  ######################################################################
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
  };

  ######################################################################
  # 2. Outputs
  ######################################################################
  outputs = {
    self,
    nixpkgs,
    ...
  }: let
    # Supported CPU / OS pairs
    systems = ["x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin"];

    # Helper: map over every system
    forSystems = f: nixpkgs.lib.genAttrs systems (system: f (import nixpkgs {inherit system;}));
  in {
    ##################################################################
    ## 3. Dev‑shell
    ##################################################################
    devShells = forSystems (pkgs: {
      default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs_22
          pnpm
          openssl
          prisma
          biome
        ];

        shellHook = ''
          # Local global‑npm dir (avoids polluting $HOME)
          export NPM_CONFIG_PREFIX="$PWD/.npm-global"
          export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
          mkdir -p "$NPM_CONFIG_PREFIX"

          echo "🧑‍💻 Astrolabe dev‑shell ready:"
          node --version
          pnpm --version
        '';
      };
    });

    ##################################################################
    ## 4. Packages  (build with `nix build .#dome`, run with `nix run`)
    ##################################################################
    packages = forSystems (pkgs: let
      node = pkgs.nodejs_22;
      pnpm = pkgs.pnpm;
    in rec {
      dome = pkgs.stdenv.mkDerivation rec {
        pname = "dome";
        version = "1.0.0";
        src = self; # repo root (contains pnpm‑lock.yaml)

        ##############################
        # Build‑time dependencies
        ##############################
        nativeBuildInputs = [
          node
          pnpm
          pnpm.configHook # installs deps from pnpm‑lock.yaml, offline
          pkgs.makeWrapper
        ];

        ##############################
        # Vendored node_modules store
        ##############################
        pnpmDeps = pnpm.fetchDeps {
          inherit pname version src;
          fetcherVersion = 2; # permission‑normalisation fix
          # First build with lib.fakeHash, copy the printed hash here:
          hash = "sha256-w7D4lvXxe226b8FguNeLh733QxF4NjlYdQh19DmTXY0=";
        };

        ##############################
        # Build phase
        ##############################
        buildPhase = ''
          runHook preBuild
          pnpm run build                 # must exist in package.json
          runHook postBuild
        '';

        ##############################
        # Install phase
        ##############################
        installPhase = ''
          runHook preInstall

          mkdir -p $out/lib/dome $out/bin
          cp -R dist package.json pnpm-lock.yaml node_modules $out/lib/dome/

          # Lightweight launcher
          makeWrapper ${node}/bin/node \
            $out/bin/dome \
            --add-flags "$out/lib/dome/dist/cli/index.js" \
            --set NODE_PATH "$out/lib/dome/node_modules"

          runHook postInstall
        '';

        meta = with pkgs.lib; {
          description = "Dome – task‑navigation CLI";
          homepage = "https://github.com/astrotask/astrolabe";
          license = licenses.mit;
          maintainers = []; # add your GitHub handle if you like
          mainProgram = "dome"; # enables `nix run .#dome`
        };
      };

      default = dome; # `nix build` / `nix run` default
    });
  };
}
