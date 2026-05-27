// vault-runtime: the composed v1 runtime handle.
//
// One `VaultRuntime` opens the three operational databases — projection,
// outbox, and run-ledger — and builds the `ProcessorRuntime` against the
// caller-supplied `ProcessorRegistry`. The handle is consumed by
// `submitProposal` (in `./submit-proposal.ts`); a single VaultRuntime can
// serve many `submitProposal` calls without re-opening sqlite per call.
//
// This file replaces — for v1-engine consumers — the v0.5 `src/vault.ts`'s
// `openVault()`. The old `openVault` stays in place for Phase 7a (existing
// Tools-surface consumers continue to use it); Phase 7b retires the old
// path once the projection / outbox / ledger seams are the only writers.
//
// Phase 7a scope (intentional deferrals, documented inline):
//
//   - `resolveGrants`: granted := declared (every declared capability is
//     granted). Matches the v1 "trust the bundle manifest" default. Phase 8+
//     wires real per-extension grant lookups from `.dome/config.yaml` via
//     the capability-policy resolver.
//   - `extensionIdFor`: identity (`processorId === extensionId`). The
//     registry already keys by bundle-prefixed processor id per
//     [[wiki/specs/sdk-surface]] §"Bundle load lifecycle"; the bundle id
//     is the processor id verbatim for v1. Phase 7b refines this once the
//     bundle loader threads a per-processor → bundle map through.
//   - `resolveTree`: a thin wrapper over `../git`'s `readTree`. The
//     runtime calls `resolveTree(candidate)` once per adoption iteration
//     whenever the registry has any adoption-phase processors — even
//     before any processor fires (`src/processors/runtime.ts`'s
//     `adoptionRunner`). A throwing placeholder would block every
//     submission with a non-empty registry, so the resolver is wired
//     against the live git boundary in Phase 7a. The Phase 7a smoke
//     test surface exercises only diagnostic / fact / question effects,
//     but the snapshot's `tree` OID must still resolve so the
//     `ProcessorContext.snapshot` is well-formed.
//
// Normative references:
//   - docs/wiki/specs/vault-layout.md §"Derived operational state under
//     `.dome/`" — the canonical paths for the three databases.
//   - docs/wiki/specs/proposals.md §"Submission API" — the user-facing
//     entry point this runtime backs.
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
import type { ProcessorRegistry } from "../processors/registry";

// ----- Public types ---------------------------------------------------------

/**
 * The composed v1 runtime handle. Carries the open projection / outbox /
 * ledger database connections, the built `ProcessorRuntime`, and the
 * vault path the engine reads git state from.
 *
 * Lifetime: opened once via `openVaultRuntime`, consumed by zero or more
 * `submitProposal` calls, released via `close()`. The DB handles inside
 * are shared across calls — the engine's adoption loop reuses them
 * iteration-to-iteration.
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

export type OpenVaultRuntimeOpts = {
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
 * The closed set of `openVaultRuntime` failures. Each variant carries the
 * underlying cause string from the failing DB-open call so the caller can
 * surface an actionable error.
 */
export type OpenVaultRuntimeError =
  | { readonly kind: "projection-db-open-failed"; readonly cause: string }
  | { readonly kind: "outbox-db-open-failed"; readonly cause: string }
  | { readonly kind: "ledger-db-open-failed"; readonly cause: string };

// ----- openVaultRuntime -----------------------------------------------------

/**
 * Open the three operational databases under `<vaultPath>/.dome/state/`
 * and build a `ProcessorRuntime` against `opts.registry`. Returns a
 * `VaultRuntime` handle the caller passes to `submitProposal`.
 *
 * On any DB-open failure, every already-opened DB is closed before the
 * error is returned — no leaked handles on the error path.
 *
 * Phase 7a placeholders (documented in the file banner; this comment
 * lists the wired seams the function injects):
 *   - `resolveGrants` := identity-on-declared (grant set = declared set).
 *   - `extensionIdFor` := identity (`processorId` is treated as the
 *     extension id).
 *   - `resolveTree` := throwing placeholder; only invoked when an
 *     adoption-phase processor reads through `ctx.snapshot`, which the
 *     Phase 7a smoke test does not trigger.
 *
 * @param opts.vaultPath          Absolute vault root.
 * @param opts.registry           The processor registry the runtime walks.
 * @param opts.extensions         Installed bundles (for projection cache key).
 * @param opts.processorVersions  Loaded processors (for projection cache key).
 */
export async function openVaultRuntime(
  opts: OpenVaultRuntimeOpts,
): Promise<Result<VaultRuntime, OpenVaultRuntimeError>> {
  // 1. Projection DB.
  const projectionPath = join(opts.vaultPath, ".dome", "state", "projection.db");
  const projectionResult = await openProjectionDb({
    path: projectionPath,
    extensionSet: opts.extensions,
    processorVersions: opts.processorVersions,
  });
  if (!projectionResult.ok) {
    return err({
      kind: "projection-db-open-failed",
      cause: projectionResult.error.kind,
    });
  }
  const projectionDb = projectionResult.value.db;

  // 2. Outbox DB. Close the projection on failure to avoid a handle leak.
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

  // 3. Ledger DB. Close the prior two on failure.
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

  // 4. Build the ProcessorRuntime. The three injections cover the
  //    Phase 7a seams — see file banner. `resolveTree` is wired against
  //    the live git boundary so the runtime's per-iteration
  //    `Snapshot` construction doesn't trip on a throw placeholder.
  const processorRuntime = buildRuntime({
    registry: opts.registry,
    resolveGrants: defaultResolveGrants(opts.registry),
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

// ----- Phase 7a placeholder injections --------------------------------------

/**
 * Phase 7a default: grant = declared. Every capability a processor
 * declares in its bundle manifest is granted at adoption time. This
 * matches the v1 "trust the bundle manifest" default — third-party
 * extensions installed into the vault are assumed vetted at install time.
 *
 * Phase 8+ replaces this with a real per-extension grant lookup driven
 * by `.dome/config.yaml`'s capability-policy section (per
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
 * Phase 7a default: extension id := processor id. The bundle loader
 * prefixes each processor id with its bundle id (per
 * [[wiki/specs/sdk-surface]] §"Bundle load lifecycle" step 4), so the
 * processor id itself is a reasonable extension-id surrogate for the
 * `Dome-Extension` trailer.
 *
 * Phase 7b refines this once the bundle loader threads a per-processor
 * → bundle map through to `openVaultRuntime`; the seam is the
 * `extensionIdFor` callback of `buildRuntime`.
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
 * divergence") makes the cumulative call count small. Phase 8+ may
 * add memoization once the model-invoke / view-phase surfaces drive
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

