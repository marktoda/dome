// vault-runtime: the composed v1 runtime handle.
//
// One `VaultRuntime` opens the operational databases — projection, answers,
// outbox, and run-ledger — and builds the `ProcessorRuntime` against
// either a caller-supplied `ProcessorRegistry` or a bundle-loader-derived
// registry built by walking one or more bundle roots. The handle is consumed
// by the engine-internal daemon (Phase 11b's `dome serve`); a single VaultRuntime
// can serve many adoption runs without re-opening sqlite per run.
//
// `openVaultRuntime` accepts either the pre-built-registry opts (used by
// tests and advanced consumers that hand-compose their processor set) or
// the `bundlesRoot:` opts (the canonical entry shape for v1 vaults —
// SDK-shipped bundles plus optional vault-local extensions).
//
// This module is not re-exported from `src/index.ts`. The daemon is the
// only consumer; harnesses that want to query the projection / outbox /
// ledger reach the DBs via the dedicated `open<*>Db` functions on
// the public surface.
//
// v1.0 scope (intentional deferrals, documented inline):
//
//   - Bundle activation: when `.dome/config.yaml` exists, only
//     `extensions.<id>.enabled: true` bundles are registered. Config-less
//     test/dev vaults keep the compatibility behavior of loading all bundles.
//   - `resolveGrants`: `.dome/config.yaml` grant lookup when a config file
//     exists; compatibility fallback to declared capabilities only for
//     config-less test/dev vaults.
//   - `extensionIdFor`: processor → bundle id map derived from loaded
//     bundles (or inferred from the supplied extension list for prebuilt
//     registries).
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
//     `.dome/`" — the canonical paths for the databases.
//   - docs/wiki/specs/proposals.md — the engine-internal contract this
//     runtime backs.
//
// House-style notes (matches src/engine/core/adopt.ts, src/projections/sinks.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - `Object.freeze` on the returned handle so misbehaving callers cannot
//     swap a field out post-construction.
//   - Errors surface via `Result<T, E>`; never throws on expected I/O paths.
//   - Imports limited to v1 substrate (engine, processors, projections,
//     outbox, ledger), plus `node:path` for path-joining and `../types` for
//     `Result`. No old-v0.5 imports.

import { join } from "node:path";

import { err, ok, type Result } from "../../types";
import type { CommitOid } from "../../core/source-ref";
import {
  treeOid,
  type Capability,
  type ExtensionConfig,
  type OperationalQueryView,
  type TreeOid,
} from "../../core/processor";
import {
  computeCapabilityPolicyHash,
  loadCapabilityPolicy,
  type ExtensionPolicyStatus,
  type CapabilityPolicy,
  type RuntimeConfig,
} from "../core/capability-policy";
import {
  buildCommandModelProvider,
  buildCommandModelStepProvider,
} from "./command-model-provider";
import { readTree } from "../../git";
import { openAnswersDb, type AnswersDb } from "../../answers/db";
import { openProjectionDb, type ProjectionDb } from "../../projections/db";
import { buildProjectionQueryView } from "../../projections/query-view";
import { openOutboxDb, type OutboxDb } from "../../outbox/db";
import type {
  ExternalHandler,
  ExternalHandlerRegistry,
} from "../../outbox/dispatch";
import { openLedgerDb, type LedgerDb } from "../../ledger/db";
import { buildOperationalQueryView } from "../operational/operational-query-view";
import { openQuarantineStore } from "../operational/quarantine-store";
import type { ModelProvider, ModelStepProvider } from "../core/model-invoke";
import {
  buildRuntime,
  type ProcessorRuntime,
} from "../../processors/runtime";
import type { ProcessorExecutionState } from "../../processors/execution-state";
import {
  buildRegistry,
  type ProcessorRegistry,
  type RegistryError,
} from "../../processors/registry";
import {
  composeMaintenanceLoops,
  FIRST_PARTY_MAINTENANCE_LOOPS,
  type MaintenanceLoop,
  type MaintenanceLoopValidationError,
} from "../../extensions/maintenance-loops";
import type { ManifestGrantEntryRequirement } from "../../extensions/manifest-schema";
import {
  flattenBundleProcessors,
  loadBundlesFromRoots,
  type LoadBundlesError,
  type LoadedBundle,
} from "../../extensions/loader";
import {
  DEFAULT_PAGE_TYPE_DECLARATIONS,
  mergePageTypeDeclarations,
  type PageTypeDeclaration,
  type PageTypeRegistry,
} from "../../page-types";

const EMPTY_EXTERNAL_HANDLERS: ReadonlyMap<string, ExternalHandler> = new Map();
const EMPTY_GRANT_ENTRY_REQUIREMENTS: ReadonlyArray<ManifestGrantEntryRequirement> =
  Object.freeze([]);

// ----- Public types ---------------------------------------------------------

/**
 * The composed v1 runtime handle. Carries the open projection / outbox /
 * ledger database connections, the built `ProcessorRegistry` and
 * `ProcessorRuntime`, and the vault path the engine reads git state from.
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
  readonly answersDb: AnswersDb;
  readonly outboxDb: OutboxDb;
  readonly ledgerDb: LedgerDb;
  readonly extensions: ReadonlyArray<{
    readonly name: string;
    readonly version: string;
  }>;
  readonly configuredExtensions: ReadonlyArray<ExtensionPolicyStatus>;
  readonly processorVersions: ReadonlyArray<{
    readonly id: string;
    readonly version: string;
  }>;
  readonly capabilityPolicyHash: string;
  readonly registry: ProcessorRegistry;
  readonly processorRuntime: ProcessorRuntime;
  readonly pageTypes: PageTypeRegistry;
  readonly config: RuntimeConfig;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly extensionIdFor: (processorId: string) => string;
  readonly extensionConfigFor: (extensionId: string) => ExtensionConfig;
  readonly externalHandlers: ExternalHandlerRegistry;
  /** Composed maintenance loops (first-party registry + active bundles'). */
  readonly maintenanceLoops: ReadonlyArray<MaintenanceLoop>;
  /** Composed doctor grant-entry requirements from active bundles. */
  readonly doctorGrantEntries: ReadonlyArray<ManifestGrantEntryRequirement>;
  readonly operationalQueryView: OperationalQueryView;
  readonly modelProvider?: ModelProvider;
  readonly modelStepProvider?: ModelStepProvider;
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
   * Absolute filesystem path to the vault root. The operational databases
   * land under `<vaultPath>/.dome/state/`.
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
  /**
   * Optional processor → extension map for callers that pre-build a
   * registry. When omitted, the runtime infers the map from the supplied
   * extension names by longest prefix.
   */
  readonly processorExtensionIds?: ReadonlyMap<string, string>;
  readonly extensionPageTypes?: ReadonlyMap<
    string,
    ReadonlyArray<PageTypeDeclaration>
  >;
  readonly pageTypes?: PageTypeRegistry;
  /**
   * Capability handlers used by the outbox dispatcher for
   * ExternalActionEffects. Omitted means no external side effects are
   * performable; emitted rows fail explicitly with a missing-handler error.
   */
  readonly externalHandlers?: ExternalHandlerRegistry;
  readonly modelProvider?: ModelProvider;
};

/**
 * The auto-load shape: the caller points at one or more bundle root directories
 * and the runtime walks them, loads + validates each bundle's manifest,
 * dynamic-imports each declared processor module, builds the registry,
 * and derives `(extensions, processorVersions)` from the loaded bundles.
 *
 * This is the canonical entry shape for v1 vaults — `bundlesRoot` is the
 * primary root, and `additionalBundlesRoots` are later-precedence roots that
 * can add or override bundles.
 */
export type OpenVaultRuntimeWithBundlesOpts = {
  readonly vaultPath: string;
  /**
   * Directory containing one subdirectory per bundle. Each subdirectory
   * holds a `manifest.yaml` (or `manifest.json`) plus a `processors/`
   * directory with the declared processor modules.
   */
  readonly bundlesRoot: string;
  /**
   * Optional additional roots composed after `bundlesRoot`. Later roots win
   * on duplicate bundle ids, which lets vault-local bundles override shipped
   * bundles without changing the Processor/Effect boundary.
   */
  readonly additionalBundlesRoots?: ReadonlyArray<string>;
  /**
   * Capability handlers used by the outbox dispatcher for
   * ExternalActionEffects. Bundle-discovered handlers are a future loader
   * extension; callers may inject handlers directly today.
   */
  readonly externalHandlers?: ExternalHandlerRegistry;
  readonly modelProvider?: ModelProvider;
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
 *   - `projection-db-open-failed`, `answers-db-open-failed`,
 *     `outbox-db-open-failed`, `ledger-db-open-failed`: DB-open seams.
 *   - `quarantine-store-open-failed`: the processor quarantine JSON store
 *     could not be read or parsed.
 *   - `bundle-load-failed`: the bundle loader rejected the bundlesRoot
 *     (root missing, manifest invalid, processor import failure, etc.).
 *     Carries the nested `LoadBundlesError` for the operator's diagnostic.
 *   - `registry-build-failed`: the loaded processor set failed
 *     `buildRegistry`'s structural checks (duplicate ids, duplicate
 *     command triggers, empty triggers, invalid phase). Carries the
 *     nested `RegistryError`.
 */
export type OpenVaultRuntimeError =
  | { readonly kind: "projection-db-open-failed"; readonly cause: string }
  | { readonly kind: "answers-db-open-failed"; readonly cause: string }
  | { readonly kind: "outbox-db-open-failed"; readonly cause: string }
  | { readonly kind: "ledger-db-open-failed"; readonly cause: string }
  | { readonly kind: "quarantine-store-open-failed"; readonly cause: string }
  | { readonly kind: "capability-policy-load-failed"; readonly cause: string }
  | { readonly kind: "bundle-load-failed"; readonly cause: LoadBundlesError }
  | { readonly kind: "registry-build-failed"; readonly cause: RegistryError }
  | {
      readonly kind: "maintenance-loop-conflict";
      readonly cause: MaintenanceLoopValidationError;
    };

// ----- openVaultRuntime -----------------------------------------------------

/**
 * Open the operational databases under `<vaultPath>/.dome/state/`
 * and build a `ProcessorRuntime` against the resolved registry. Returns a
 * `VaultRuntime` handle the daemon passes to `adopt()` per commit.
 *
 * Two construction shapes are supported (see `OpenVaultRuntimeOpts`):
 *
 *   - Pre-built registry shape: caller supplies `registry`, `extensions`,
 *     `processorVersions` — used by tests + advanced consumers that hand-
 *     compose their processor set.
 *   - Auto-load shape: caller supplies `bundlesRoot` plus optional
 *     `additionalBundlesRoots` — the runtime walks them, loads + validates
 *     each bundle's manifest, dynamic-imports
 *     declared processor modules, builds the registry, and derives the
 *     projection-cache-key lists from the loaded bundles. This is the
 *     canonical entry shape for v1 vaults.
 *
 * On any DB-open / bundle-load / registry-build failure, every already-
 * opened DB is closed before the error is returned — no leaked handles on
 * the error path.
 *
 * v1 defaults (documented in the file banner; this comment lists the
 * wired seams the function injects):
 *   - Bundle activation := vault config `enabled: true` when `.dome/config.yaml`
 *     exists, compatibility all-active behavior only when it does not.
 *   - `resolveGrants` := vault config grants when `.dome/config.yaml`
 *     exists, compatibility declared-grant fallback only when it does not.
 *   - `extensionIdFor` := processor → bundle id map.
 *   - `resolveTree` := the live git boundary (`../git`'s `readTree`).
 */
export async function openVaultRuntime(
  opts: OpenVaultRuntimeOpts,
): Promise<Result<VaultRuntime, OpenVaultRuntimeError>> {
  const policyResult = await loadCapabilityPolicy(opts.vaultPath);
  if (!policyResult.ok) {
    return err({
      kind: "capability-policy-load-failed",
      cause: policyResult.error,
    });
  }
  const policy = policyResult.value;

  // 1. Resolve the registry + projection-cache-key lists from the opts
  //    shape. Bundle-load failures and registry-build failures surface as
  //    structured `OpenVaultRuntimeError` variants before any DB opens —
  //    no need to clean up handles on these paths.
  const resolved = await resolveRegistryFromOpts(opts, policy);
  if (!resolved.ok) return err(resolved.error);

  const settings = runtimeSettingsForPolicy({
    opts,
    policy,
    resolved: resolved.value,
  });

  const operationalState = await openOperationalState({
    vaultPath: opts.vaultPath,
    extensions: resolved.value.extensions,
    processorVersions: resolved.value.processorVersions,
    capabilityPolicyHash: settings.capabilityPolicyHash,
  });
  if (!operationalState.ok) return operationalState;

  // Registry-orphan GC: drop execution-state counters (quarantined.json) for
  // processors whose bundle is no longer installed (the stale
  // dome.intake.synthesize-rollup counter that lived forever). A
  // registered-but-DISABLED bundle is still configured, so its counters are
  // preserved — `isKnownProcessor` treats a processor as known when its bundle
  // is configured (enabled or disabled) OR it is in the resolved registry.
  //
  // Conservatively gated: only prune when we actually established a non-empty
  // known set (config found + at least one configured extension or a non-empty
  // registry). A missing/empty config is almost always a read edge rather than
  // a deliberate full retirement, and pruning everything then would silently
  // discard live recovery state.
  if (
    policy.foundConfig &&
    (policy.configuredExtensions.length > 0 || resolved.value.registry.size > 0)
  ) {
    operationalState.value.executionState.pruneUnknownProcessors(
      isKnownProcessorFor(policy, resolved.value.registry),
    );
  }

  return ok(buildVaultRuntime({
    opts,
    policy,
    resolved: resolved.value,
    settings,
    operationalState: operationalState.value,
  }));
}

// ----- Runtime composition --------------------------------------------------

type RuntimeSettings = {
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly capabilityPolicyHash: string;
  readonly extensionIdFor: (processorId: string) => string;
  readonly extensionConfigFor: CapabilityPolicy["configForExtension"];
  readonly externalHandlers: ExternalHandlerRegistry;
  readonly modelProvider?: ModelProvider;
  readonly modelStepProvider?: ModelStepProvider;
};

function runtimeSettingsForPolicy(input: {
  readonly opts: OpenVaultRuntimeOpts;
  readonly policy: CapabilityPolicy;
  readonly resolved: ResolvedRegistry;
}): RuntimeSettings {
  const resolveGrants = input.policy.foundConfig
    ? resolveGrantsFromPolicy(
        input.resolved.registry,
        input.policy,
        input.resolved.processorExtensionIds,
      )
    : defaultResolveGrants(input.resolved.registry);
  const builtProviders = modelProviderFromConfig(
    input.policy.runtime,
    input.opts.vaultPath,
  );
  const modelProvider = input.opts.modelProvider ?? builtProviders?.text;
  const modelStepProvider = builtProviders?.step;

  return Object.freeze({
    resolveGrants,
    capabilityPolicyHash: computeCapabilityPolicyHash(input.policy),
    extensionIdFor: extensionIdForProcessor(
      input.resolved.processorExtensionIds,
    ),
    extensionConfigFor: input.policy.configForExtension,
    externalHandlers: mergeExternalHandlerRegistries(
      input.resolved.externalHandlers,
      input.opts.externalHandlers,
    ),
    ...(modelProvider !== undefined ? { modelProvider } : {}),
    ...(modelStepProvider !== undefined ? { modelStepProvider } : {}),
  });
}

type OperationalState = {
  readonly executionState: ProcessorExecutionState;
  readonly projectionDb: ProjectionDb;
  readonly answersDb: AnswersDb;
  readonly outboxDb: OutboxDb;
  readonly ledgerDb: LedgerDb;
};

async function openOperationalState(input: {
  readonly vaultPath: string;
  readonly extensions: ReadonlyArray<{
    readonly name: string;
    readonly version: string;
  }>;
  readonly processorVersions: ReadonlyArray<{
    readonly id: string;
    readonly version: string;
  }>;
  readonly capabilityPolicyHash: string;
}): Promise<Result<OperationalState, OpenVaultRuntimeError>> {
  const quarantinePath = join(
    input.vaultPath,
    ".dome",
    "state",
    "quarantined.json",
  );
  const quarantineResult = openQuarantineStore({ path: quarantinePath });
  if (!quarantineResult.ok) {
    return err({
      kind: "quarantine-store-open-failed",
      cause: `${quarantineResult.error.kind}: ${quarantineResult.error.cause}`,
    });
  }
  const executionState = quarantineResult.value;

  const projectionResult = await openProjectionDb({
    path: statePath(input.vaultPath, "projection.db"),
    extensionSet: input.extensions,
    processorVersions: input.processorVersions,
    capabilityPolicyHash: input.capabilityPolicyHash,
  });
  if (!projectionResult.ok) {
    return err({
      kind: "projection-db-open-failed",
      cause: projectionResult.error.kind,
    });
  }
  const projectionDb = projectionResult.value.db;

  const answersResult = await openAnswersDb({
    path: statePath(input.vaultPath, "answers.db"),
  });
  if (!answersResult.ok) {
    projectionDb.close();
    return err({
      kind: "answers-db-open-failed",
      cause: answersResult.error.kind,
    });
  }
  const answersDb = answersResult.value.db;

  const outboxResult = await openOutboxDb({
    path: statePath(input.vaultPath, "outbox.db"),
  });
  if (!outboxResult.ok) {
    answersDb.close();
    projectionDb.close();
    return err({
      kind: "outbox-db-open-failed",
      cause: outboxResult.error.kind,
    });
  }
  const outboxDb = outboxResult.value.db;

  const ledgerResult = await openLedgerDb({
    path: statePath(input.vaultPath, "runs.db"),
  });
  if (!ledgerResult.ok) {
    outboxDb.close();
    answersDb.close();
    projectionDb.close();
    return err({
      kind: "ledger-db-open-failed",
      cause: ledgerResult.error.kind,
    });
  }

  return ok(Object.freeze({
    executionState,
    projectionDb,
    answersDb,
    outboxDb,
    ledgerDb: ledgerResult.value.db,
  }));
}

function statePath(vaultPath: string, filename: string): string {
  return join(vaultPath, ".dome", "state", filename);
}

function buildVaultRuntime(input: {
  readonly opts: OpenVaultRuntimeOpts;
  readonly policy: CapabilityPolicy;
  readonly resolved: ResolvedRegistry;
  readonly settings: RuntimeSettings;
  readonly operationalState: OperationalState;
}): VaultRuntime {
  const { opts, policy, resolved, settings, operationalState } = input;
  const {
    projectionDb,
    answersDb,
    outboxDb,
    ledgerDb,
    executionState,
  } = operationalState;

  // `resolveTree` is wired against the live git boundary so the runtime's
  // per-iteration Snapshot construction cannot fail on a throw placeholder.
  // `projection` gives view processors the adopted-state query surface.
  const operationalQueryView = buildOperationalQueryView({
    outbox: outboxDb,
    ledger: ledgerDb,
    executionState,
  });
  const processorRuntime = buildRuntime({
    registry: resolved.registry,
    resolveGrants: settings.resolveGrants,
    extensionIdFor: settings.extensionIdFor,
    extensionConfigFor: settings.extensionConfigFor,
    resolveTree: makeResolveTree(opts.vaultPath),
    ledger: ledgerDb,
    projection: buildProjectionQueryView(projectionDb),
    operational: operationalQueryView,
    pageTypes: resolved.pageTypes,
    executionState,
    executionCap: policy.runtime.engine.executionCap,
    ...(settings.modelProvider !== undefined
      ? { modelProvider: settings.modelProvider }
      : {}),
    ...(settings.modelStepProvider !== undefined
      ? { modelStepProvider: settings.modelStepProvider }
      : {}),
  });

  return Object.freeze({
    path: opts.vaultPath,
    projectionDb,
    answersDb,
    outboxDb,
    ledgerDb,
    extensions: resolved.extensions,
    configuredExtensions: policy.configuredExtensions,
    processorVersions: resolved.processorVersions,
    capabilityPolicyHash: settings.capabilityPolicyHash,
    registry: resolved.registry,
    processorRuntime,
    pageTypes: resolved.pageTypes,
    config: policy.runtime,
    resolveGrants: settings.resolveGrants,
    extensionIdFor: settings.extensionIdFor,
    extensionConfigFor: settings.extensionConfigFor,
    externalHandlers: settings.externalHandlers,
    maintenanceLoops: resolved.maintenanceLoops,
    doctorGrantEntries: resolved.doctorGrantEntries,
    operationalQueryView,
    ...(settings.modelProvider !== undefined
      ? { modelProvider: settings.modelProvider }
      : {}),
    ...(settings.modelStepProvider !== undefined
      ? { modelStepProvider: settings.modelStepProvider }
      : {}),
    close: async () => {
      await processorRuntime.close();
      // Close in reverse-open order. SQLite handles are idempotent under
      // `sqlite3_close_v2`, so a double-close is safe.
      ledgerDb.close();
      outboxDb.close();
      answersDb.close();
      projectionDb.close();
    },
  });
}

// ----- Registry resolution --------------------------------------------------

function modelProviderFromConfig(
  config: RuntimeConfig,
  vaultPath: string,
): { text?: ModelProvider; step?: ModelStepProvider } | undefined {
  const provider = config.modelProvider;
  if (provider === undefined) return undefined;
  switch (provider.kind) {
    case "command":
      return {
        text: buildCommandModelProvider(provider, { cwd: vaultPath }),
        step: buildCommandModelStepProvider(provider, { cwd: vaultPath }),
      };
  }
}

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
  readonly processorExtensionIds: ReadonlyMap<string, string>;
  readonly externalHandlers: ReadonlyMap<string, ExternalHandler>;
  readonly pageTypes: PageTypeRegistry;
  /**
   * The composed maintenance-loop set: the first-party composition registry
   * plus active bundles' manifest-declared loops
   * (`composeMaintenanceLoops`). Status/check read loops from here, never
   * from the static registry, so third-party loops surface automatically.
   */
  readonly maintenanceLoops: ReadonlyArray<MaintenanceLoop>;
  /** Composed doctor grant-entry requirements from active bundles. */
  readonly doctorGrantEntries: ReadonlyArray<ManifestGrantEntryRequirement>;
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
  policy: CapabilityPolicy,
): Promise<Result<ResolvedRegistry, OpenVaultRuntimeError>> {
  if ("registry" in opts) {
    const processorExtensionIds =
      opts.processorExtensionIds ??
      inferProcessorExtensionIds(
        opts.registry,
        opts.extensions.map((e) => e.name),
      );
    if (policy.foundConfig) {
      return activePrebuiltRegistryForPolicy({
        registry: opts.registry,
        extensions: opts.extensions,
        processorVersions: opts.processorVersions,
        processorExtensionIds,
        pageTypes: pageTypeRegistryForPrebuiltOpts(opts, policy),
        policy,
      });
    }
    return ok({
      registry: opts.registry,
      extensions: opts.extensions,
      processorVersions: opts.processorVersions,
      processorExtensionIds,
      externalHandlers: EMPTY_EXTERNAL_HANDLERS,
      maintenanceLoops: FIRST_PARTY_MAINTENANCE_LOOPS,
      doctorGrantEntries: EMPTY_GRANT_ENTRY_REQUIREMENTS,
      pageTypes: pageTypeRegistryForPrebuiltOpts(opts, policy),
    });
  }

  // Auto-load path: walk bundle roots, then compose. Later roots override
  // earlier roots by bundle id.
  const bundlesResult = await loadBundlesFromRoots({
    bundlesRoots: [opts.bundlesRoot, ...(opts.additionalBundlesRoots ?? [])],
    ...(policy.foundConfig
      ? { activeBundleIds: new Set(policy.enabledExtensionIds) }
      : {}),
  });
  if (!bundlesResult.ok) {
    return err({ kind: "bundle-load-failed", cause: bundlesResult.error });
  }
  const bundles = bundlesResult.value;
  const activeBundles = activeBundlesForPolicy(bundles, policy);

  const processors = flattenBundleProcessors(activeBundles);
  const registryResult = buildRegistry(processors);
  if (!registryResult.ok) {
    return err({
      kind: "registry-build-failed",
      cause: registryResult.error,
    });
  }

  const composedLoops = composeMaintenanceLoops(
    activeBundles.flatMap((bundle) => bundle.loops),
  );
  if (!composedLoops.ok) {
    return err({
      kind: "maintenance-loop-conflict",
      cause: composedLoops.error,
    });
  }

  return ok({
    registry: registryResult.value,
    extensions: deriveExtensionList(activeBundles),
    processorVersions: deriveProcessorVersionList(processors),
    processorExtensionIds: deriveProcessorExtensionIds(activeBundles),
    externalHandlers: deriveExternalHandlers(activeBundles, opts.vaultPath),
    pageTypes: buildPageTypeRegistryForBundles(activeBundles),
    maintenanceLoops: composedLoops.value,
    doctorGrantEntries: Object.freeze(
      activeBundles.flatMap((bundle) => bundle.doctorGrantEntries),
    ),
  });
}

function activePrebuiltRegistryForPolicy(input: {
  readonly registry: ProcessorRegistry;
  readonly extensions: ReadonlyArray<{
    readonly name: string;
    readonly version: string;
  }>;
  readonly processorVersions: ReadonlyArray<{
    readonly id: string;
    readonly version: string;
  }>;
  readonly processorExtensionIds: ReadonlyMap<string, string>;
  readonly pageTypes: PageTypeRegistry;
  readonly policy: CapabilityPolicy;
}): Result<ResolvedRegistry, OpenVaultRuntimeError> {
  const processors = input.registry
    .all()
    .filter((processor) =>
      input.policy.isExtensionEnabled(
        input.processorExtensionIds.get(processor.id) ?? processor.id,
      ),
    );
  const registryResult = buildRegistry(processors);
  if (!registryResult.ok) {
    return err({
      kind: "registry-build-failed",
      cause: registryResult.error,
    });
  }

  const activeProcessorIds = new Set(processors.map((processor) => processor.id));
  const activeProcessorExtensionIds = new Map<string, string>();
  for (const processor of processors) {
    const extensionId =
      input.processorExtensionIds.get(processor.id) ?? processor.id;
    activeProcessorExtensionIds.set(processor.id, extensionId);
  }

  return ok({
    registry: registryResult.value,
    extensions: input.extensions.filter((extension) =>
      input.policy.isExtensionEnabled(extension.name),
    ),
    processorVersions: input.processorVersions.filter((processorVersion) =>
      activeProcessorIds.has(processorVersion.id),
    ),
    processorExtensionIds: activeProcessorExtensionIds,
    externalHandlers: EMPTY_EXTERNAL_HANDLERS,
    maintenanceLoops: FIRST_PARTY_MAINTENANCE_LOOPS,
    doctorGrantEntries: EMPTY_GRANT_ENTRY_REQUIREMENTS,
    pageTypes: input.pageTypes,
  });
}

function pageTypeRegistryForPrebuiltOpts(
  opts: OpenVaultRuntimeWithRegistryOpts,
  policy: CapabilityPolicy,
): PageTypeRegistry {
  if (!policy.foundConfig && opts.pageTypes !== undefined) {
    return opts.pageTypes;
  }
  return buildPageTypeRegistryForExtensionPageTypes(
    opts.extensionPageTypes ?? new Map(),
    policy.foundConfig ? policy : null,
  );
}

function activeBundlesForPolicy(
  bundles: ReadonlyArray<LoadedBundle>,
  policy: CapabilityPolicy,
): ReadonlyArray<LoadedBundle> {
  if (!policy.foundConfig) return bundles;
  return Object.freeze(
    bundles.filter((bundle) => policy.isExtensionEnabled(bundle.id)),
  );
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

function deriveProcessorExtensionIds(
  bundles: ReadonlyArray<LoadedBundle>,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const bundle of bundles) {
    for (const processor of bundle.processors) {
      out.set(processor.id, bundle.id);
    }
  }
  return out;
}

/**
 * Compose bundle-discovered external handlers, wrapping each so its
 * `ExternalHandlerInput` carries the absolute vault root. Bundle handlers
 * that run vault-local fetch commands (e.g. `dome.sources`' `sources.fetch`)
 * need the vault root as spawn cwd; the dispatch layer is deliberately
 * vault-layout-agnostic, so the injection happens here at runtime
 * composition. Caller-injected handlers (tests, hosts) are not wrapped.
 */
function deriveExternalHandlers(
  bundles: ReadonlyArray<LoadedBundle>,
  vaultPath: string,
): ReadonlyMap<string, ExternalHandler> {
  const out = new Map<string, ExternalHandler>();
  for (const bundle of bundles) {
    for (const [capability, handler] of bundle.externalHandlers) {
      out.set(capability, (input) => handler({ ...input, vaultPath }));
    }
  }
  return out;
}

function mergeExternalHandlerRegistries(
  discovered: ReadonlyMap<string, ExternalHandler>,
  injected: ExternalHandlerRegistry | undefined,
): ReadonlyMap<string, ExternalHandler> {
  if (injected === undefined) return discovered;
  const out = new Map(discovered);
  for (const [capability, handler] of externalHandlerEntries(injected)) {
    out.set(capability, handler);
  }
  return out;
}

function externalHandlerEntries(
  registry: ExternalHandlerRegistry,
): ReadonlyArray<readonly [string, ExternalHandler]> {
  if (
    typeof (registry as ReadonlyMap<string, ExternalHandler>).entries ===
    "function"
  ) {
    return Object.freeze([
      ...(registry as ReadonlyMap<string, ExternalHandler>).entries(),
    ]);
  }
  return Object.freeze(Object.entries(registry));
}

function buildPageTypeRegistryForBundles(
  bundles: ReadonlyArray<LoadedBundle>,
): PageTypeRegistry {
  const declarations: PageTypeDeclaration[] = [
    ...DEFAULT_PAGE_TYPE_DECLARATIONS,
  ];
  for (const bundle of bundles) {
    declarations.push(...bundle.pageTypes);
  }
  const result = mergePageTypeDeclarations(declarations, {
    enforceKnownTypes: bundles.some((bundle) => bundle.pageTypes.length > 0),
  });
  if (!result.ok) {
    throw new Error(
      `page type collision for '${result.error.name}' between ` +
        `${result.error.firstSource} and ${result.error.secondSource}`,
    );
  }
  return result.value;
}

function buildPageTypeRegistryForExtensionPageTypes(
  extensionPageTypes: ReadonlyMap<string, ReadonlyArray<PageTypeDeclaration>>,
  policy: CapabilityPolicy | null,
): PageTypeRegistry {
  const declarations: PageTypeDeclaration[] = [
    ...DEFAULT_PAGE_TYPE_DECLARATIONS,
  ];
  for (const [extensionId, pageTypes] of extensionPageTypes.entries()) {
    if (policy !== null && !policy.isExtensionEnabled(extensionId)) continue;
    declarations.push(...pageTypes);
  }
  const result = mergePageTypeDeclarations(declarations, {
    enforceKnownTypes: declarations.length > DEFAULT_PAGE_TYPE_DECLARATIONS.length,
  });
  if (!result.ok) {
    throw new Error(
      `page type collision for '${result.error.name}' between ` +
        `${result.error.firstSource} and ${result.error.secondSource}`,
    );
  }
  return result.value;
}

/**
 * Predicate for the registry-orphan GC: a processor is KNOWN (its counter is
 * preserved) when it is in the resolved (enabled) registry OR its bundle is
 * configured at all — a disabled bundle still appears in
 * `policy.configuredExtensions`, so its processors survive (re-enabling finds
 * its history intact). Only a processor whose bundle is neither registered nor
 * configured (genuinely retired/uninstalled) is unknown and gets pruned.
 * Processor ids are bundle-namespaced (`<extensionId>.<name>`), matching the
 * prefix convention in `inferProcessorExtensionIds`.
 */
function isKnownProcessorFor(
  policy: CapabilityPolicy,
  registry: ProcessorRegistry,
): (processorId: string) => boolean {
  const configuredExtensionIds = policy.configuredExtensions.map(
    (status) => status.id,
  );
  return (processorId: string): boolean => {
    if (registry.get(processorId) !== undefined) return true;
    return configuredExtensionIds.some(
      (extensionId) =>
        processorId === extensionId ||
        processorId.startsWith(`${extensionId}.`),
    );
  };
}

function inferProcessorExtensionIds(
  registry: ProcessorRegistry,
  extensionIds: ReadonlyArray<string>,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const sorted = [...extensionIds].sort((a, b) => b.length - a.length);
  for (const processor of registry.all()) {
    const match = sorted.find(
      (extensionId) =>
        processor.id === extensionId || processor.id.startsWith(`${extensionId}.`),
    );
    out.set(processor.id, match ?? processor.id);
  }
  return out;
}

// ----- Runtime seam injections ----------------------------------------------

/**
 * Compatibility fallback for config-less test/dev vaults: grant =
 * declared. Normal vaults use `resolveGrantsFromPolicy`, which reads
 * `.dome/config.yaml`. Keep this function exported for low-level tests
 * that intentionally hand-compose a registry without a vault config.
 *
 * Returned arrays are NOT frozen here — the caller (`buildRuntime`)
 * passes them through to `RunnerResult.granted`, which the engine treats
 * as readonly. Freezing them would prevent test scaffolding that
 * occasionally mutates a granted-set in place; the registry's stored
 * `Processor.capabilities` array is already frozen by `defineProcessor`.
 */
export function defaultResolveGrants(
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

function resolveGrantsFromPolicy(
  registry: ProcessorRegistry,
  policy: CapabilityPolicy,
  processorExtensionIds: ReadonlyMap<string, string>,
): (processorId: string) => ReadonlyArray<Capability> {
  return (processorId: string): ReadonlyArray<Capability> => {
    const p = registry.get(processorId);
    if (p === undefined) {
      throw new Error(
        `openVaultRuntime: resolveGrants asked about unknown processor id '${processorId}'`,
      );
    }
    const extensionId = processorExtensionIds.get(processorId) ?? processorId;
    return policy.grantsForProcessor(extensionId, processorId);
  };
}

/**
 * Compatibility fallback for callers that have no processor → bundle map.
 * `openVaultRuntime` now derives the real map for loaded bundles.
 */
export function defaultExtensionIdFor(processorId: string): string {
  return processorId;
}

function extensionIdForProcessor(
  processorExtensionIds: ReadonlyMap<string, string>,
): (processorId: string) => string {
  return (processorId: string): string =>
    processorExtensionIds.get(processorId) ?? defaultExtensionIdFor(processorId);
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
export function makeResolveTree(
  vaultPath: string,
): (commit: CommitOid) => Promise<TreeOid> {
  return async (commit: CommitOid): Promise<TreeOid> => {
    const result = await readTree({ path: vaultPath, oid: commit });
    return treeOid(result.oid);
  };
}
