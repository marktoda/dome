// cli/commands/init: the `dome init [path]` command.
//
// Phase 9 minimal surface per [[wiki/specs/cli]] §"dome init". The full
// spec lists seven steps (git init, scaffold dirs, AGENTS.md/CLAUDE.md,
// config.yaml, page-types.yaml, log.md/index.md seeds, initial sync);
// Phase 9 ships the two load-bearing pieces:
//
//   1. Create `<path>/.dome/state/` so the projection / outbox / ledger
//      DB opens have somewhere to land.
//   2. Copy the shipped `assets/extensions/dome.lint/` bundle into
//      `<path>/.dome/extensions/` so a Phase 9 `dome submit` against
//      the fresh vault has a non-empty registry to compose against.
//
// Idempotent: re-running on an already-initialized vault is a no-op
// (`mkdir -p` semantics; existing extension files are overwritten on
// re-copy — re-copy lands the latest shipped bundle, which is the
// expected upgrade semantic).
//
// Exit codes per spec:
//   - 0 on success.
//   - 1 on unexpected I/O failure (we surface the underlying error).
//   - 64 (EX_USAGE) if the `path` arg is malformed.
//
// House-style notes:
//   - No DB opens here. The runtime is opened on first command that
//     needs it (submit, doctor, status). `init` is filesystem-only.
//   - Resolve the bundles source path relative to `__dirname` so the
//     command works whether the CLI is invoked from a global install,
//     a local clone, or a bundled binary.

import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ParsedArgs } from "../args";

// ----- Paths ----------------------------------------------------------------

const THIS_FILE = fileURLToPath(import.meta.url);
// `src/cli/commands/init.ts` → repo root is three directories up.
const REPO_ROOT = resolve(dirname(THIS_FILE), "..", "..", "..");
const SHIPPED_BUNDLES_ROOT = join(REPO_ROOT, "assets", "extensions");

// ----- runInit --------------------------------------------------------------

/**
 * Execute `dome init`. Returns the exit code; never throws on expected
 * I/O paths (a missing source bundle directory is a programmer error
 * worth raising, not a recoverable case).
 */
export async function runInit(args: ParsedArgs): Promise<number> {
  // Resolve the target vault path: `dome init` defaults to `.`; an
  // optional positional overrides it.
  const target = args.positionals[0] ?? ".";
  const vaultPath = resolve(target);

  try {
    // 1. Create `<vault>/.dome/state/`.
    const statePath = join(vaultPath, ".dome", "state");
    await mkdir(statePath, { recursive: true });

    // 2. Copy the shipped `dome.lint/` bundle into
    //    `<vault>/.dome/extensions/dome.lint/`. The destination root
    //    `<vault>/.dome/extensions/` is created via `mkdir -p`.
    const extensionsRoot = join(vaultPath, ".dome", "extensions");
    await mkdir(extensionsRoot, { recursive: true });
    await copyTree(
      join(SHIPPED_BUNDLES_ROOT, "dome.lint"),
      join(extensionsRoot, "dome.lint"),
    );

    console.log(`dome init: initialized vault at ${vaultPath}`);
    console.log(`  created: .dome/state/`);
    console.log(`  copied:  .dome/extensions/dome.lint/`);
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`dome init: failed: ${msg}`);
    return 1;
  }
}

// ----- internals ------------------------------------------------------------

/**
 * Recursively copy `src` to `dst`, creating intermediate directories as
 * needed. Mirrors `cp -r src dst`. Files are overwritten on collision —
 * `dome init` is idempotent re-copy at the bundle level.
 *
 * No symlink handling: bundle source trees ship as regular files only.
 * A symlink in the source surface would surface as the underlying file
 * content (the default `copyFile` semantic).
 */
async function copyTree(src: string, dst: string): Promise<void> {
  const srcStat = await stat(src);
  if (!srcStat.isDirectory()) {
    // Single file — ensure dest dir exists, then copy.
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
    return;
  }

  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcChild = join(src, entry.name);
    const dstChild = join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyTree(srcChild, dstChild);
    } else if (entry.isFile()) {
      await copyFile(srcChild, dstChild);
    }
    // Sockets / fifos / symlinks are skipped — not part of any bundle.
  }
}
