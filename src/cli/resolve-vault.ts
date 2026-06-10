// Vault-root discovery for CLI command handlers.
//
// Git-style upward resolution: without an explicit `--vault`, a command run
// from anywhere inside a vault (e.g. `<vault>/wiki/`) targets the nearest
// ancestor directory containing `.dome/config.yaml`. Before this, every
// handler used the bare cwd, so running from a subdirectory failed with
// advice to run `dome init` — which would have scaffolded a nested vault
// inside the real one.
//
// Rules:
//   - An explicit `--vault` is used as given; no discovery.
//   - Discovery stops at the filesystem root and falls back to the cwd, so
//     every "not a vault" failure mode is unchanged when no ancestor vault
//     exists.
//   - `dome init` does NOT use this helper: initializing a new vault in a
//     subdirectory of an existing vault must target the cwd, not the parent.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function resolveVaultPath(vaultOption?: string | undefined): string {
  if (vaultOption !== undefined) return resolve(vaultOption);
  const cwd = resolve(process.cwd());
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, ".dome", "config.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
}
