// extensions/bundle-roots: resolve the bundle roots a runtime composes.
//
// Lifted from `src/cli/commands/sync-shared.ts` so non-CLI surfaces (the
// public `openVault` wrapper in `src/vault.ts`, the MCP adapter, future
// protocol surfaces) can resolve the canonical root set without importing
// CLI modules. The CLI re-exports these from sync-shared for its commands.
//
// Read-only module: it inspects the filesystem (existsSync) but never writes.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ResolvedBundleRoots = {
  readonly bundlesRoot: string;
  readonly additionalBundlesRoots?: ReadonlyArray<string>;
};

/**
 * Returns the absolute path to the SDK's shipped first-party bundles
 * directory (`<SDK>/assets/extensions/`).
 *
 * Resolved relative to this module's location via `import.meta.url`, so
 * the math works regardless of where the user installed the SDK (global
 * `bun install -g`, local `node_modules`, `bun link` symlink, or a
 * `bun build`-produced single-file). From `src/extensions/bundle-roots.ts`,
 * two directories up reaches the SDK package root; `assets/extensions/` is
 * the canonical shipped-bundles dir.
 */
export function resolveShippedBundlesRoot(): string {
  const url = new URL("../../assets/extensions", import.meta.url);
  return fileURLToPath(url);
}

/**
 * Returns the absolute path to the SDK's shipped first-party model-provider
 * templates directory (`<SDK>/assets/model-providers/`). Same resolution
 * story as `resolveShippedBundlesRoot`. The templates are shipped data —
 * `dome init --with-model-provider <provider>` copies one into the vault as
 * `.dome/model-provider.ts` — and are never imported by any `src/` module,
 * so the ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY fence stays intact.
 */
export function resolveShippedModelProvidersRoot(): string {
  const url = new URL("../../assets/model-providers", import.meta.url);
  return fileURLToPath(url);
}

/**
 * Returns the absolute path to the SDK's shipped source-handler templates
 * directory (`<SDK>/assets/source-handlers/`). Same resolution story as
 * `resolveShippedBundlesRoot`. The templates are shipped data —
 * `dome init --with-source <kind>` copies one into the vault as
 * `.dome/bin/fetch-<kind>.sh` — and are never imported by any `src/`
 * module (they are shell scripts the vault owner reviews before enabling
 * the matching dome.sources subscription).
 */
export function resolveShippedSourceHandlersRoot(): string {
  const url = new URL("../../assets/source-handlers", import.meta.url);
  return fileURLToPath(url);
}

export function resolveVaultLocalBundlesRoot(vaultPath: string): string {
  return join(vaultPath, ".dome", "extensions");
}

/**
 * Resolve bundle roots for normal CLI/runtime use. An explicit
 * `--bundles-root` remains an exact override for tests and ad-hoc dev. The
 * default path composes SDK-shipped bundles with an existing vault-local
 * `.dome/extensions/` root, with vault-local bundles taking precedence.
 */
export function resolveBundleRoots(opts: {
  readonly vaultPath: string;
  readonly bundlesRoot?: string | undefined;
}): ResolvedBundleRoots {
  if (opts.bundlesRoot !== undefined) {
    return Object.freeze({
      bundlesRoot: resolve(opts.bundlesRoot),
    });
  }

  const shipped = resolveShippedBundlesRoot();
  const local = resolveVaultLocalBundlesRoot(opts.vaultPath);
  if (!existsSync(local)) {
    return Object.freeze({ bundlesRoot: shipped });
  }
  return Object.freeze({
    bundlesRoot: shipped,
    additionalBundlesRoots: Object.freeze([local]),
  });
}
