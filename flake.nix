{
  description = "Communicator";
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-24.11";
    nixpkgs-unstable.url = "github:nixos/nixpkgs/nixos-unstable";
    foundry.url = "github:shazow/foundry.nix";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };
  outputs = {
    self,
    nixpkgs,
    nixpkgs-unstable,
    rust-overlay,
    foundry,
  }: let
    supportedSystems = ["x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin"];
    forEachSupportedSystem = f:
      nixpkgs.lib.genAttrs supportedSystems (system:
        f {
          pkgs = import nixpkgs {
            inherit system;
            overlays = [rust-overlay.overlays.default foundry.overlay self.overlays.default];
          };
          pkgs-unstable = import nixpkgs-unstable {
            inherit system;
          };
        });
  in {
    overlays.default = final: prev: {
      rustToolchain = let
        rust = prev.rust-bin;
      in
        if builtins.pathExists ./rust-toolchain.toml
        then rust.fromRustupToolchainFile ./rust-toolchain.toml
        else if builtins.pathExists ./rust-toolchain
        then rust.fromRustupToolchainFile ./rust-toolchain
        else
          rust.stable.latest.default.override {
            extensions = ["rust-src" "rustfmt"];
          };
    };

    devShells = forEachSupportedSystem ({
      pkgs,
      pkgs-unstable,
      ...
    }: {
      default = pkgs.mkShell {
        nativeBuildInputs = with pkgs; [
          gcc
        ];
        buildInputs = with pkgs; [
          glibc.static
          cmake
          ccache
        ];
        packages = with pkgs; [
          rustToolchain
          openssl
          pkgs.postgresql
          pkg-config
          pnpm
          nodejs_20
          cargo-deny
          diesel-cli
          boost
          catch2
          cmake
          nodePackages.ts-node
          cargo-edit
          cargo-watch
          rust-analyzer
          sqlite
          cargo-shuttle
          pkgs-unstable.railway
        ];

        shellHook = ''
          export PKG_CONFIG_PATH=${pkgs.postgresql}/lib/pkgconfig:$PKG_CONFIG_PATH
          export LIBPQ_LIB_DIR=${pkgs.postgresql}/lib
          export LIBPQ_INCLUDE_DIR=${pkgs.postgresql}/include
          export PG_CONFIG=${pkgs.postgresql}/bin/pg_config

          # Create alias for cargo-shuttle as shuttle
          alias shuttle="cargo shuttle"
        '';
      };
    });
  };
}
