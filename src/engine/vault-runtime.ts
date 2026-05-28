// vault-runtime: the composed v1 runtime handle.
//
// One `VaultRuntime` opens the three operational databases — projection,
// outbox, and run-ledger — and builds the `ProcessorRuntime` against
// either a caller-supplied `ProcessorRegistry` or a bundle-loader-derived
// registry built by walking `bundlesRoot/`. The handle is consumed by the
// engine-internal daemon (Phase 11b's `dome serve`); a single VaultRuntime
// can serve many adoption runs without re-opening sqlite per run.
//
// `openVaultRuntime` accepts either the pre-built-registry opts (used by
// tests and advanced consumers that hand-compose their processor set) or
// the `bundlesRoot:` opts (the canonical entry shape for v1 vaults —
// `<vault>/.dome/extensions/` or `assets/extensions/`).
//
// This module is not re-exported from `src/index.ts`. The daemon is the
// only consumer; harnesses that want to query the projection / outbox /
// ledger reach the three DBs via the dedicated `open<*>Db` functions on
// the public surface.
//
// v1.0 scope (intentional deferrals, documented inline):
//
//   - `resolveGrants`: granted := declared (every declared capability is
//     granted). Matches the v1 "trust the bundle manifest" default. A
//     follow-up phase wires real per-extension grant lookups from
//     `.dome/config.yaml` via the capability-policy resolver.
//   - `extensionIdFor`: identity (`processorId === extensionId`). The
//     registry already keys by bundle-prefixed processor id per
//     [[wiki/specs/sdk-surface]] §"Bundle load lifecycle"; the bundle id
//     is the processor id verbatim for v1. A follow-up phase refines this
//     once the bundle loader threads a per-processor → bundle map through.
//   - `resolveTree`: a thin wrapper over `../git`'s `readTree`. The
//     runtime calls `resolveTree(candidate)` once per adoption iteration
//     whenever the registry has any adoption-phase processors — even
//     before any processor fires (`src/processors/runtime.ts`'s
//     `adoptionRunner`). A throwing placeholder would block every
//     adoption run with a non-empty registry, so the resolver is wired
//     against the live git boundary.
//
// Normative references:
//   - docs/wiki/specs/vault-layout.md §"Derived operational state under
//     `.dome/`" — the canonical paths for the three databases.
//   - docs/wiki/specs/proposals.md — the engine-internal contract this
//     runtime backs.
//
// House-style notes (matches src/engine/adopt.ts, src/projections/sinks.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - `Object.freeze` on the returned handle so misbehaving callers cannot
//     swap a field out post-construction.
//   - Errors surface via `Result<T, E>`; never throws on expected I/O paths.
//   - Imports limited to v1 substrate (engine, processors, projections,
//     outbox, ledger), plus `node:path` for path-joining and `../types` for
//     `Result`. No old-v0.5 imports.

import { join } from "node:path";

import { err, ok, type Result } from "../types";
import type { CommitOid } from "../core/source-ref";
import { treeOid, type Capability, type TreeOid } from "../core/processor";
import { readTree } from "../git";
import { openProjectionDb, type ProjectionDb } from "../projections/db";
import { openOutboxDb, type OutboxDb } from "../outbox/db";
import { openLedgerDb, type LedgerDb } from "../ledger/db";
import {
  buildRuntime,
  type ProcessorRuntime,
} from "../processors/runtime";
import {
  buildRegistry,
  type ProcessorRegistry,
  type RegistryError,
} from "../processors/registry";
import {
  flattenBundleProcessors,
  loadBundles,
  type LoadBundlesError,
  type LoadedBundle,
} from "../extensions/loader";

// ----- Public types ---------------------------------------------------------

/**
 * The composed v1 runtime handle. Carries the open projection / outbox /
 * ledger database connections, the built `ProcessorRuntime`, and the
 * vault path the engine reads git state from.
 *
 * Lifetime: opened once via `openVaultRuntime`, consumed by zero or more
 * adoption runs (the daemon's per-commit `adopt()` calls), released via
 * `close()`. The DB handles inside are shared across runs — the engine's
 * adoption loop reuses them iteration-to-iteration.
 *
 * `close()` is idempotent at the SQLite layer (Bun's `sqlite3_close_v2`
 * semantics); calling twice is safe.
 */
export type VaultRuntime = {
  readonly path: string;
  readonly projectionDb: ProjectionDb;
  readonly outboxDb: OutboxDb;
  readonly ledgerDb: LedgerDb;
  readonly processorRuntime: ProcessorRuntime;
  readonly close: () => Promise<void>;
};

/**
 * The pre-built-registry shape: the caller has already loaded bundles
 * (or hand-constructed processors), built the registry, and computed the
 * `(extensions, processorVersions)` lists for the projection cache key.
 * The runtime composes against these directly.
 */
export type OpenVaultRuntimeWithRegistryOpts = {
  /**
   * Absolute filesystem path to the vault root. The three databases land
   * at `<vaultPath>/.dome/state/{projection,outbox,runs}.db`.
   */
  readonly vaultPath: string;
  /**
   * The loaded processor registry. Built by the bundle loader (today:
   * `src/extensions/loader.ts`; future: a unified loader) before this
   * function is called. The runtime walks this registry per adoption
   * iteration.
   */
  readonly registry: ProcessorRegistry;
  /**
   * The installed extension bundles. Hashed by `openProjectionDb` (sorted
   * by name) for cache-key invalidation per
   * [[wiki/specs/projection-store]] §"Cache key".
   */
  readonly extensions: ReadonlyArray<{
    readonly name: string;
    readonly version: string;
  }>;
  /**
   * The loaded processors and their versions. Hashed by `openProjectionDb`
   * (sorted by id) for per-processor cache-key invalidation per
   * [[wiki/gotchas/processor-version-drift]].
   */
  readonly processorVersions: ReadonlyArray<{
    readonly id: string;
    readonly version: string;
  }>;
};

/**
 * The auto-load shape: the caller points at a `bundlesRoot/` directory
 * and the runtime walks it, loads + validates each bundle's manifest,
 * dynamic-imports each declared processor module, builds the registry,
 * and derives `(extensions, processorVersions)` from the loaded bundles.
 *
 * This is the canonical entry shape for v1 vaults — `bundlesRoot` is
 * typically `<vault>/.dome/extensions/` (per
 * [[wiki/specs/sdk-surface]] §"Extension bundles") or `assets/extensions/`
 * (for SDK-shipped first-party bundles in tests / dev).
 */
export type OpenVaultRuntimeWithBundlesOpts = {
  readonly vaultPath: string;
  /**
   * Directory containing one subdirectory per bundle. Each subdirectory
   * holds a `manifest.yaml` (or `manifest.json`) plus a `processors/`
   * directory with the declared processor modules.
   */
  readonly bundlesRoot: string;
};

/**
 * Union of the two construction shapes. Discriminated structurally: the
 * `registry`-bearing variant takes a pre-built `ProcessorRegistry`; the
 * `bundlesRoot`-bearing variant takes a filesystem path and lets the
 * runtime load bundles itself.
 */
export type OpenVaultRuntimeOpts =
  | OpenVaultRuntimeWithRegistryOpts
  | OpenVaultRuntimeWithBundlesOpts;

/**
 * The closed set of `openVaultRuntime` failures. Each variant carries the
 * underlying cause from the failing call so the caller can surface an
 * actionable error.
 *
 *   - `projection-db-open-failed`, `outbox-db-open-failed`,
 *     `ledger-db-open-failed`: the three DB-open seams.
 *   - `bundle-load-failed`: the bundle loader rejected the bundlesRoot
 *     (root missing, manifest invalid, processor import failure, etc.).
 *     Carries the nested `LoadBundlesError` for the operator's diagnostic.
 *   - `registry-build-failed`: the loaded processor set failed
 *     `buildRegistry`'s structural checks (duplicate id, empty triggers,
 *     invalid phase). Carries the nested `RegistryError`.
 */
export type OpenVaultRuntimeError =
  | { readonly kind: "projection-db-open-failed"; readonly cause: string }
  | { readonly kind: "outbox-db-open-failed"; readonly cause: string }
  | { readonly kind: "ledger-db-open-failed"; readonly cause: string }
  | { readonly kind: "bundle-load-failed"; readonly cause: LoadBundlesError }
  | { readonly kind: "registry-build-failed"; readonly cause: RegistryError };

// ----- openVaultRuntime -----------------------------------------------------

/**
 * Open the three operational databases under `<vaultPath>/.dome/state/`
 * and build a `ProcessorRuntime` against the resolved registry. Returns a
 * `VaultRuntime` handle the daemon passes to `adopt()` per commit.
 *
 * Two construction shapes are supported (see `OpenVaultRuntimeOpts`):
 *
 *   - Pre-built registry shape: caller supplies `registry`, `extensions`,
 *     `processorVersions` — used by tests + advanced consumers that hand-
 *     compose their processor set.
 *   - Auto-load shape: caller supplies `bundlesRoot` — the runtime walks
 *     it, loads + validates each bundle's manifest, dynamic-imports
 *     declared processor modules, builds the registry, and derives the
 *     projection-cache-key lists from the loaded bundles. This is the
 *     canonical entry shape for v1 vaults.
 *
 * On any DB-open / bundle-load / registry-build failure, every already-
 * opened DB is closed before the error is returned — no leaked handles on
 * the error path.
 *
 * v1.0 defaults (documented in the file banner; this comment lists the
 * wired seams the function injects):
 *   - `resolveGrants` := identity-on-declared (grant set = declared set).
 *   - `extensionIdFor` := identity (`processorId` is treated as the
 *     extension id).
 *   - `resolveTree` := the live git boundary (`../git`'s `readTree`).
 */
export async function openVaultRuntime(
  opts: OpenVaultRuntimeOpts,
): Promise<Result<VaultRuntime, OpenVaultRuntimeError>> {
  // 1. Resolve the registry + projection-cache-key lists from the opts
  //    shape. Bundle-load failures and registry-build failures surface as
  //    structured `OpenVaultRuntimeError` variants before any DB opens —
  //    no need to clean up handles on these paths.
  const resolved = await resolveRegistryFromOpts(opts);
  if (!resolved.ok) return err(resolved.error);
  const { registry, extensions, processorVersions } = resolved.value;

  // 2. Projection DB.
  const projectionPath = join(opts.vaultPath, ".dome", "state", "projection.db");
  const projectionResult = await openProjectionDb({
    path: projectionPath,
    extensionSet: extensions,
    processorVersions,
  });
  if (!projectionResult.ok) {
    return err({
      kind: "projection-db-open-failed",
      cause: projectionResult.error.kind,
    });
  }
  const projectionDb = projectionResult.value.db;

  // 3. Outbox DB. Close the projection on failure to avoid a handle leak.
  const outboxPath = join(opts.vaultPath, ".dome", "state", "outbox.db");
  const outboxResult = await openOutboxDb({ path: outboxPath });
  if (!outboxResult.ok) {
    projectionDb.close();
    return err({
      kind: "outbox-db-open-failed",
      cause: outboxResult.error.kind,
    });
  }
  const outboxDb = outboxResult.value.db;

  // 4. Ledger DB. Close the prior two on failure.
  const ledgerPath = join(opts.vaultPath, ".dome", "state", "runs.db");
  const ledgerResult = await openLedgerDb({ path: ledgerPath });
  if (!ledgerResult.ok) {
    outboxDb.close();
    projectionDb.close();
    return err({
      kind: "ledger-db-open-failed",
      cause: ledgerResult.error.kind,
    });
  }
  const ledgerDb = ledgerResult.value.db;

  // 5. Build the ProcessorRuntime. The three injections cover the v1.0
  //    runtime seams — see file banner. `resolveTree` is wired against
  //    the live git boundary so the runtime's per-iteration
  //    `Snapshot` construction doesn't trip on a throw placeholder.
  const processorRuntime = buildRuntime({
    registry,
    resolveGrants: defaultResolveGrants(registry),
    extensionIdFor: defaultExtensionIdFor,
    resolveTree: makeResolveTree(opts.vaultPath),
    ledger: ledgerDb,
  });

  const runtime: VaultRuntime = Object.freeze({
    path: opts.vaultPath,
    projectionDb,
    outboxDb,
    ledgerDb,
    processorRuntime,
    close: async () => {
      // Close in reverse-open order. SQLite handles are idempotent under
      // `sqlite3_close_v2`, so a double-close is safe.
      ledgerDb.close();
      outboxDb.close();
      projectionDb.close();
    },
  });

  return ok(runtime);
}

// ----- Registry resolution --------------------------------------------------

/**
 * Internal shape returned by `resolveRegistryFromOpts`: the three pieces
 * the downstream DB-open + runtime-build steps consume, regardless of
 * which `OpenVaultRuntimeOpts` shape produced them.
 */
type ResolvedRegistry = {
  readonly registry: ProcessorRegistry;
  readonly extensions: ReadonlyArray<{
    readonly name: string;
    readonly version: string;
  }>;
  readonly processorVersions: ReadonlyArray<{
    readonly id: string;
    readonly version: string;
  }>;
};

/**
 * Discriminate the input shape and produce the (registry, extensions,
 * processorVersions) triple. Pre-built shapes flow through unchanged; the
 * `bundlesRoot` shape runs the loader → buildRegistry pipeline and
 * derives the two cache-key lists from the loaded bundles.
 *
 * Discrimination is by `"registry" in opts`. Both `OpenVaultRuntimeOpts`
 * variants carry `vaultPath`; the registry-variant additionally carries
 * `registry`, the bundles-variant additionally carries `bundlesRoot`. The
 * narrowing is type-safe under the union.
 */
async function resolveRegistryFromOpts(
  opts: OpenVaultRuntimeOpts,
): Promise<Result<ResolvedRegistry, OpenVaultRuntimeError>> {
  if ("registry" in opts) {
    return ok({
      registry: opts.registry,
      extensions: opts.extensions,
      processorVersions: opts.processorVersions,
    });
  }

  // Auto-load path: walk `bundlesRoot`, then compose.
  const bundlesResult = await loadBundles({ bundlesRoot: opts.bundlesRoot });
  if (!bundlesResult.ok) {
    return err({ kind: "bundle-load-failed", cause: bundlesResult.error });
  }
  const bundles = bundlesResult.value;

  const processors = flattenBundleProcessors(bundles);
  const registryResult = buildRegistry(processors);
  if (!registryResult.ok) {
    return err({
      kind: "registry-build-failed",
      cause: registryResult.error,
    });
  }

  return ok({
    registry: registryResult.value,
    extensions: deriveExtensionList(bundles),
    processorVersions: deriveProcessorVersionList(processors),
  });
}

/**
 * Derive the `(name, version)` list `openProjectionDb` hashes for its
 * cache key. The `name` field maps to the bundle's manifest `id` — the
 * projection-cache-key contract uses the structural name of the
 * installed extension, which is the bundle id.
 */
function deriveExtensionList(
  bundles: ReadonlyArray<LoadedBundle>,
): ReadonlyArray<{ readonly name: string; readonly version: string }> {
  return bundles.map((b) => ({ name: b.id, version: b.version }));
}

/**
 * Derive the `(id, version)` list `openProjectionDb` hashes for the
 * per-processor cache-key invalidation seam per
 * [[wiki/gotchas/processor-version-drift]].
 */
function deriveProcessorVersionList(
  processors: ReadonlyArray<{ readonly id: string; readonly version: string }>,
): ReadonlyArray<{ readonly id: string; readonly version: string }> {
  return processors.map((p) => ({ id: p.id, version: p.version }));
}

// ----- v1.0 default seam injections -----------------------------------------

/**
 * v1.0 default: grant = declared. Every capability a processor declares
 * in its bundle manifest is granted at adoption time. This matches the
 * v1 "trust the bundle manifest" default — third-party extensions
 * installed into the vault are assumed vetted at install time.
 *
 * A follow-up phase replaces this with a real per-extension grant lookup
 * driven by `.dome/config.yaml`'s capability-policy section (per
 * [[wiki/specs/capabilities]] §"Vault policy"). The seam is the
 * `resolveGrants` callback of `buildRuntime`; this function is the v1
 * stand-in.
 *
 * Returned arrays are NOT frozen here — the caller (`buildRuntime`)
 * passes them through to `RunnerResult.granted`, which the engine treats
 * as readonly. Freezing them would prevent test scaffolding that
 * occasionally mutates a granted-set in place; the registry's stored
 * `Processor.capabilities` array is already frozen by `defineProcessor`.
 */
function defaultResolveGrants(
  registry: ProcessorRegistry,
): (processorId: string) => ReadonlyArray<Capability> {
  return (processorId: string): ReadonlyArray<Capability> => {
    const p = registry.get(processorId);
    if (p === undefined) {
      // The runtime only asks about processors it just walked out of the
      // registry, so an unknown id here is a programmer error. An empty
      // grant set would silently deny every effect; throw loudly instead.
      throw new Error(
        `openVaultRuntime: resolveGrants asked about unknown processor id '${processorId}'`,
      );
    }
    return p.capabilities;
  };
}

/**
 * v1.0 default: extension id := processor id. The bundle loader prefixes
 * each processor id with its bundle id (per
 * [[wiki/specs/sdk-surface]] §"Bundle load lifecycle" step 4), so the
 * processor id itself is a reasonable extension-id surrogate for the
 * `Dome-Extension` trailer.
 *
 * A follow-up phase refines this once the bundle loader threads a
 * per-processor → bundle map through to `openVaultRuntime`; the seam is
 * the `extensionIdFor` callback of `buildRuntime`.
 */
function defaultExtensionIdFor(processorId: string): string {
  return processorId;
}

/**
 * Build the `resolveTree` injection bound to `vaultPath`. The runtime
 * calls this once per adoption iteration (per
 * `src/processors/runtime.ts`'s `adoptionRunner`) to mint the
 * `Snapshot.tree` OID for the iteration's `ProcessorContext`.
 *
 * Implementation: delegate to `../git`'s `readTree` — isomorphic-git
 * accepts a commit OID and dereferences it, returning the tree's OID
 * on the result's `.oid` field. The resolver does not walk the tree
 * (no per-entry parsing); the OID alone is what the `Snapshot` shape
 * exposes downstream.
 *
 * The implementation is intentionally minimal: no caching, no
 * per-candidate memoization. The runtime invokes the resolver once per
 * iteration; a vault with bounded loop iteration counts (the
 * `MAX_ITER` cap per [[wiki/specs/adoption]] §"MAX_ITER and
 * divergence") makes the cumulative call count small. A follow-up phase
 * may add memoization once the model-invoke / view-phase surfaces drive
 * more frequent resolves.
 */
function makeResolveTree(
  vaultPath: string,
): (commit: CommitOid) => Promise<TreeOid> {
  return async (commit: CommitOid): Promise<TreeOid> => {
    const result = await readTree({ path: vaultPath, oid: commit });
    return treeOid(result.oid);
  };
}

