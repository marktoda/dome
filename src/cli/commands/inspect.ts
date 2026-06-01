// cli/commands/inspect: the `dome inspect <subject>` command.
//
// Per [[wiki/specs/cli]] §"dome inspect <subject>", `dome inspect` is the
// read-only view over the operational substrate. It opens the runtime
// (so the operational databases are initialized) but does not submit a
// Proposal, does not invoke any processor, and does not mutate state.
//
// v1.0 ships subjects backed by existing runtime/query surfaces:
//
//   - `runs`        → `queryRuns(ledger, { limit })`
//   - `diagnostics` → `queryDiagnostics(projection)`
//   - `questions`   → `queryQuestionRecords(projection)`
//   - `outbox`      → `queryOutbox(outbox)`
//   - `quarantine`  → `executionState.quarantines()`
//   - `bundles`     → configured/loaded extension bundle summary
//   - `processors`  → loaded processor/automation summary
//
// Exit codes:
//   - 0 always on a clean read — including empty result sets.
//   - 1 on runtime-open failure.
//   - 64 on usage error (unknown subject, missing positional).
//
// House-style notes:
//   - `--limit N` caps the row or summary group count. Operational row
//     subjects default to 20; bounded metadata subjects (`bundles` and
//     `processors`) default to the full loaded runtime set. The cap is
//     applied at the SQL layer for `runs`; for the projection / outbox /
//     metadata surfaces it is applied post-fetch via array slicing.
//   - `diagnostics --summary` groups unresolved diagnostics by severity/code
//     so noisy real vaults have a first-glance triage view.
//   - `--json` emits structured rows.
//   - `--model` filters the bounded bundle/processor metadata surfaces to
//     model-capable entries, so a vault can answer "which automations can use
//     an LLM?" without scanning the full table by hand.
//
// Renamed from the pre-recut `dome doctor --show <subject>` in the v1.0
// CLI surface recut (per cli.md §"dome inspect"). The previous
// `dome doctor` namespace is reserved for the v1.x health-check verb;
// this surface is the read half.

import { resolve } from "node:path";

import type {
  Capability,
  Processor,
  ProcessorPhase,
  Trigger,
} from "../../core/processor";
import { openVaultRuntime, type VaultRuntime } from "../../engine/vault-runtime";
import {
  loadBundleManifestSummaryFromRoots,
  type BundleManifestSummary,
  type LoadBundlesError,
} from "../../extensions/loader";
import { queryRuns } from "../../ledger/runs";
import {
  queryDiagnostics,
  type DiagnosticsFilter,
} from "../../projections/diagnostics";
import { queryQuestionRecords } from "../../projections/questions";
import { queryOutbox } from "../../outbox/dispatch";

import { resolveBundleRoots, type ResolvedBundleRoots } from "./sync-shared";

import {
  formatSourceRefs,
  summarizeDiagnosticEffects,
  type DiagnosticSeverity,
  type DiagnosticSummary,
} from "../diagnostic-summary";
import { formatJson, formatTable } from "../format";
import { parsePositiveIntegerValue } from "../parse-options";

// ----- Constants ------------------------------------------------------------

const DEFAULT_LIMIT = 20;
const VALID_SUBJECTS = new Set<string>([
  "bundles",
  "processors",
  "runs",
  "diagnostics",
  "questions",
  "outbox",
  "quarantine",
]);
const VALID_DIAGNOSTIC_SEVERITIES = new Set([
  "info",
  "warning",
  "error",
  "block",
] as const);

export type RunInspectOptions = {
  readonly subject?: string | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly limit?: string | number | boolean | undefined;
  readonly json?: boolean | undefined;
  readonly summary?: boolean | undefined;
  readonly severity?: string | undefined;
  readonly code?: string | undefined;
  readonly processor?: string | undefined;
  readonly model?: boolean | undefined;
};

// ----- runInspect --------------------------------------------------------------

/**
 * Execute `dome inspect <subject>`. Returns the exit code.
 *
 * Subject comes from Commander's required positional argument. No flag-based
 * subject is accepted; the previous `--show <subject>` spelling is retired
 * in the recut.
 */
export async function runInspect(
  options: RunInspectOptions = {},
): Promise<number> {
  const subject = options.subject;
  if (typeof subject !== "string" || subject.length === 0) {
    console.error(
      "dome inspect: subject is required. Subjects: bundles, processors, runs, diagnostics, questions, outbox, quarantine.",
    );
    return 64;
  }
  if (!VALID_SUBJECTS.has(subject)) {
    console.error(
      `dome inspect: unknown subject '${subject}'. Available: bundles, processors, runs, diagnostics, questions, outbox, quarantine.`,
    );
    return 64;
  }

  const vaultPath = resolve(options.vault ?? process.cwd());

  const limit = parseLimit(options.limit, defaultLimitForSubject(subject));
  if (limit === null) {
    console.error("dome inspect: --limit must be a positive integer.");
    return 64;
  }
  const diagnosticOptions = parseDiagnosticOptions({
    subject,
    ...(options.summary !== undefined ? { summary: options.summary } : {}),
    ...(options.severity !== undefined ? { severity: options.severity } : {}),
    ...(options.code !== undefined ? { code: options.code } : {}),
    ...(options.processor !== undefined ? { processor: options.processor } : {}),
  });
  if (diagnosticOptions.ok === false) {
    console.error(diagnosticOptions.message);
    return 64;
  }
  if (
    options.model === true &&
    subject !== "bundles" &&
    subject !== "processors"
  ) {
    console.error(
      "dome inspect: --model is only valid for the bundles and processors subjects.",
    );
    return 64;
  }

  const bundleRoots = resolveBundleRoots({
    vaultPath,
    bundlesRoot: options.bundlesRoot,
  });
  const runtimeResult = await openVaultRuntime({ vaultPath, ...bundleRoots });
  if (!runtimeResult.ok) {
    console.error(
      `dome inspect: openVaultRuntime failed (${runtimeResult.error.kind}). Run \`dome init\` first to initialize the vault.`,
    );
    return 1;
  }
  const runtime = runtimeResult.value;

  try {
    const bundleInventory =
      subject === "bundles"
        ? await collectBundleManifestInventory(runtime, bundleRoots)
        : new Map();
    let result: InspectResult;
    try {
      result = collectInspectResult({
        subject,
        runtime,
        limit,
        bundleInventory,
        modelOnly: options.model === true,
        diagnosticOptions: diagnosticOptions.value,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `dome inspect ${subject}: state read failed. The operational database may be corrupt: ${msg}`,
      );
      return 1;
    }
    if (options.json === true) {
      console.log(formatJson(jsonForResult(result)));
    } else {
      printTextResult(subject, result);
    }
    return 0;
  } finally {
    await runtime.close();
  }
}

// ----- internals ------------------------------------------------------------

type Row = Record<string, unknown>;
type BundleManifestInventoryEntry =
  | {
      readonly kind: "manifest";
      readonly summary: BundleManifestSummary;
    }
  | {
      readonly kind: "missing";
    }
  | {
      readonly kind: "error";
      readonly message: string;
    };
type BundleManifestInventory = ReadonlyMap<string, BundleManifestInventoryEntry>;
type ParsedDiagnosticOptions = {
  readonly summary: boolean;
  readonly filter: DiagnosticsFilter;
  readonly code?: string;
};
type ParseDiagnosticOptionsResult =
  | { readonly ok: true; readonly value: ParsedDiagnosticOptions | null }
  | { readonly ok: false; readonly message: string };

type InspectResult =
  | { readonly kind: "rows"; readonly rows: ReadonlyArray<Row> }
  | { readonly kind: "diagnostic-summary"; readonly summary: DiagnosticSummary };

/**
 * Dispatch on the subject. Each branch queries the relevant surface and
 * projects to a flat `Record<string, unknown>` shape suitable for table
 * rendering (no nested objects in the displayed columns).
 *
 * The subject is already narrowed to one of the four valid strings.
 */
function collectInspectResult(opts: {
  readonly subject: string;
  readonly runtime: VaultRuntime;
  readonly limit: number;
  readonly bundleInventory: BundleManifestInventory;
  readonly modelOnly: boolean;
  readonly diagnosticOptions: ParsedDiagnosticOptions | null;
}): InspectResult {
  if (
    opts.subject === "diagnostics" &&
    opts.diagnosticOptions?.summary === true
  ) {
    return {
      kind: "diagnostic-summary",
      summary: summarizeDiagnostics(
        opts.runtime,
        opts.limit,
        opts.diagnosticOptions,
      ),
    };
  }
  return {
    kind: "rows",
    rows: collectRows(
      opts.subject,
      opts.runtime,
      opts.limit,
      opts.bundleInventory,
      opts.modelOnly,
      opts.diagnosticOptions,
    ),
  };
}

function collectRows(
  subject: string,
  runtime: VaultRuntime,
  limit: number,
  bundleInventory: BundleManifestInventory,
  modelOnly: boolean,
  diagnosticOptions: ParsedDiagnosticOptions | null,
): ReadonlyArray<Row> {
  switch (subject) {
    case "bundles": {
      const processors = runtime.registry.all();
      const rows = collectBundleRows(runtime, processors, bundleInventory);
      return filterModelRows(rows, modelOnly).slice(0, limit);
    }
    case "processors": {
      const rows = runtime.registry.all().map((processor) => {
        const grantedCapabilities = runtime.resolveGrants(processor.id);
        return {
          processor: processor.id,
          bundle: runtime.extensionIdFor(processor.id),
          version: processor.version,
          phase: processor.phase,
          triggers: formatTriggerKinds(processor.triggers),
          commands: formatCommandTriggers(processor.triggers),
          capabilities: formatCapabilityKinds(processor.capabilities),
          bundle_grants: formatCapabilityKinds(grantedCapabilities),
          execution: processor.execution?.class ?? "default",
          model: formatModelStatus({
            declared: processor.capabilities.some(
              (capability) => capability.kind === "model.invoke",
            ),
            granted: grantedCapabilities.some(
              (capability) => capability.kind === "model.invoke",
            ),
            providerConfigured: runtime.modelProvider !== undefined,
          }),
        };
      });
      return filterModelRows(rows, modelOnly).slice(0, limit);
    }
    case "runs": {
      const runs = queryRuns(runtime.ledgerDb, { limit });
      return runs.map((r) => ({
        id: r.id,
        processor: r.processorId,
        phase: r.phase,
        status: r.status,
        started_at: r.startedAt,
        duration_ms: r.durationMs,
        proposal: r.proposalId,
      }));
    }
    case "diagnostics": {
      const all = filteredDiagnostics(runtime, diagnosticOptions);
      return all.slice(0, limit).map((d) => ({
        severity: d.severity,
        code: d.code,
        message: d.message,
        source_refs: formatSourceRefs(d.sourceRefs),
      }));
    }
    case "questions": {
      const all = queryQuestionRecords(runtime.projectionDb);
      return all.slice(0, limit).map((q) => ({
        id: q.id,
        status: q.answeredAt === null ? "open" : "answered",
        question: q.effect.question,
        options: q.effect.options ?? "-",
        answer: q.answer ?? "-",
        asked_at: q.askedAt,
        answered_at: q.answeredAt ?? "-",
        idempotency_key: q.effect.idempotencyKey,
      }));
    }
    case "outbox": {
      const all = queryOutbox(runtime.outboxDb);
      return all.slice(0, limit).map((o) => ({
        id: o.id,
        capability: o.capability,
        status: o.status,
        attempts: o.attempts,
        enqueued_at: o.enqueuedAt,
        next_attempt_at: o.nextAttemptAt,
        last_error: o.lastError,
      }));
    }
    case "quarantine": {
      const all = runtime.processorRuntime.executionState.quarantines();
      return all.slice(0, limit).map((q) => ({
        phase: q.key.phase,
        processor: q.key.processorId,
        version: q.key.processorVersion,
        trigger_hash: q.key.triggerHash,
        quarantine_id: q.quarantineId,
        failures: q.consecutiveRetryableFailures,
        quarantined_at: q.quarantinedAt.toISOString(),
        reason: q.reason,
      }));
    }
    default:
      // Unreachable — VALID_SUBJECTS guard above enforces this.
      return [];
  }
}

function filterModelRows(
  rows: ReadonlyArray<Row>,
  modelOnly: boolean,
): ReadonlyArray<Row> {
  if (!modelOnly) return rows;
  return rows.filter((row) => {
    if (typeof row.model_processors === "number") {
      return row.model_processors > 0;
    }
    return typeof row.model === "string" && row.model !== "none";
  });
}

function summarizeDiagnostics(
  runtime: VaultRuntime,
  limit: number,
  diagnosticOptions: ParsedDiagnosticOptions,
): DiagnosticSummary {
  const diagnostics = filteredDiagnostics(runtime, diagnosticOptions);
  return summarizeDiagnosticEffects(diagnostics, limit);
}

function filteredDiagnostics(
  runtime: VaultRuntime,
  diagnosticOptions: ParsedDiagnosticOptions | null,
): ReturnType<typeof queryDiagnostics> {
  const diagnostics = queryDiagnostics(
    runtime.projectionDb,
    diagnosticOptions?.filter,
  );
  const code = diagnosticOptions?.code;
  if (code === undefined) return diagnostics;
  return Object.freeze(diagnostics.filter((d) => d.code === code));
}

function jsonForResult(
  result: InspectResult,
): ReadonlyArray<Row> | DiagnosticSummary {
  return result.kind === "rows" ? result.rows : result.summary;
}

function printTextResult(subject: string, result: InspectResult): void {
  if (result.kind === "rows") {
    console.log(`dome inspect ${subject}:`);
    console.log(formatTable(result.rows));
    return;
  }
  console.log("dome inspect diagnostics summary:");
  console.log(
    `total ${result.summary.total} | groups ${result.summary.shown_groups}/${result.summary.group_count}`,
  );
  console.log(formatTable(result.summary.groups));
}

function parseDiagnosticOptions(opts: {
  readonly subject: string;
  readonly summary?: boolean;
  readonly severity?: string;
  readonly code?: string;
  readonly processor?: string;
}): ParseDiagnosticOptionsResult {
  const hasDiagnosticOption =
    opts.summary === true ||
    opts.severity !== undefined ||
    opts.code !== undefined ||
    opts.processor !== undefined;
  if (!hasDiagnosticOption) {
    return { ok: true, value: null };
  }
  if (opts.subject !== "diagnostics") {
    return {
      ok: false,
      message:
        "dome inspect: --summary, --severity, --code, and --processor are only valid for the diagnostics subject.",
    };
  }

  let severity: DiagnosticSeverity | undefined;
  if (opts.severity !== undefined) {
    if (!isDiagnosticSeverity(opts.severity)) {
      return {
        ok: false,
        message:
          "dome inspect diagnostics: --severity must be one of info, warning, error, block.",
      };
    }
    severity = opts.severity;
  }

  return {
    ok: true,
    value: {
      summary: opts.summary === true,
      filter: {
        ...(severity !== undefined ? { severity } : {}),
        ...(opts.processor !== undefined ? { processorId: opts.processor } : {}),
      },
      ...(opts.code !== undefined ? { code: opts.code } : {}),
    },
  };
}

function isDiagnosticSeverity(value: string): value is DiagnosticSeverity {
  return VALID_DIAGNOSTIC_SEVERITIES.has(value as DiagnosticSeverity);
}

function defaultLimitForSubject(subject: string): number {
  if (subject === "bundles" || subject === "processors") {
    return Number.MAX_SAFE_INTEGER;
  }
  return DEFAULT_LIMIT;
}

async function collectBundleManifestInventory(
  runtime: VaultRuntime,
  roots: ResolvedBundleRoots,
): Promise<BundleManifestInventory> {
  const loadedBundleIds = new Set(
    runtime.extensions.map((extension) => extension.name),
  );
  const entries = new Map<string, BundleManifestInventoryEntry>();
  for (const status of runtime.configuredExtensions) {
    if (loadedBundleIds.has(status.id)) continue;
    const result = await loadBundleManifestSummaryFromRoots({
      bundleId: status.id,
      bundlesRoots: [roots.bundlesRoot, ...(roots.additionalBundlesRoots ?? [])],
    });
    if (!result.ok) {
      entries.set(status.id, {
        kind: "error",
        message: formatBundleManifestError(result.error),
      });
      continue;
    }
    if (result.value === null) {
      entries.set(status.id, { kind: "missing" });
      continue;
    }
    entries.set(status.id, {
      kind: "manifest",
      summary: result.value,
    });
  }
  return entries;
}

function collectBundleRows(
  runtime: VaultRuntime,
  processors: ReadonlyArray<Processor<unknown>>,
  inventory: BundleManifestInventory,
): ReadonlyArray<Row> {
  const rowsByBundle = new Map<string, Row>();
  for (const extension of runtime.extensions) {
    rowsByBundle.set(extension.name, bundleRow({
      runtime,
      processors,
      bundleId: extension.name,
      enabled: true,
      loaded: true,
      version: extension.version,
    }));
  }

  if (runtime.configuredExtensions.length === 0) {
    return Object.freeze([...rowsByBundle.values()]);
  }

  const rows: Row[] = [];
  for (const status of runtime.configuredExtensions) {
    rows.push(
      rowsByBundle.get(status.id) ??
        bundleRow({
          runtime,
          processors,
          bundleId: status.id,
          enabled: status.enabled,
          loaded: false,
          ...inventoryEntryForRow(inventory.get(status.id)),
        }),
    );
  }

  for (const [bundleId, row] of rowsByBundle) {
    if (!runtime.configuredExtensions.some((status) => status.id === bundleId)) {
      rows.push(row);
    }
  }

  return Object.freeze(rows);
}

function bundleRow(opts: {
  readonly runtime: VaultRuntime;
  readonly processors: ReadonlyArray<Processor<unknown>>;
  readonly bundleId: string;
  readonly enabled: boolean;
  readonly loaded: boolean;
  readonly inventory?: BundleManifestInventoryEntry;
  readonly version?: string;
}): Row {
  const bundleProcessors = opts.loaded
    ? opts.processors.filter(
        (processor) =>
          opts.runtime.extensionIdFor(processor.id) === opts.bundleId,
      )
    : [];
  const manifestProcessors =
    opts.inventory?.kind === "manifest" ? opts.inventory.summary.processors : [];
  const processorMetadata = opts.loaded ? bundleProcessors : manifestProcessors;
  const modelProcessors = processorMetadata.filter(hasModelCapability);
  const phaseCounts = countProcessorPhases(processorMetadata);
  return {
    bundle: opts.bundleId,
    status: opts.enabled ? "enabled" : "disabled",
    loaded: opts.loaded,
    inventory: inventoryLabel(opts),
    inventory_error: inventoryError(opts.inventory),
    version: opts.version ?? manifestVersion(opts.inventory),
    processors: processorMetadata.length,
    adoption: phaseCounts.adoption,
    garden: phaseCounts.garden,
    view: phaseCounts.view,
    scheduled: processorMetadata.filter((processor) =>
      processor.triggers.some((trigger) => trigger.kind === "schedule"),
    ).length,
    command_views: processorMetadata.filter((processor) =>
      processor.triggers.some((trigger) => trigger.kind === "command"),
    ).length,
    model_processors: modelProcessors.length,
    model: formatBundleModelStatus({
      enabled: opts.enabled,
      modelProcessorCount: modelProcessors.length,
      modelGranted: opts.loaded
        ? modelProcessors.some((processor) =>
            runtimeGrantsAllowModel(opts.runtime, processor.id),
          )
        : false,
      providerConfigured: opts.runtime.modelProvider !== undefined,
    }),
  };
}

function inventoryEntryForRow(
  inventory: BundleManifestInventoryEntry | undefined,
):
  | { readonly inventory: BundleManifestInventoryEntry }
  | Record<string, never> {
  return inventory === undefined ? {} : { inventory };
}

function countProcessorPhases(
  processors: ReadonlyArray<ProcessorMetadata>,
): {
  readonly adoption: number;
  readonly garden: number;
  readonly view: number;
} {
  let adoption = 0;
  let garden = 0;
  let view = 0;
  for (const processor of processors) {
    if (processor.phase === "adoption") adoption += 1;
    if (processor.phase === "garden") garden += 1;
    if (processor.phase === "view") view += 1;
  }
  return { adoption, garden, view };
}

type ProcessorMetadata = {
  readonly phase: ProcessorPhase;
  readonly triggers: ReadonlyArray<Trigger>;
  readonly capabilities: ReadonlyArray<Capability>;
};

function hasModelCapability(processor: ProcessorMetadata): boolean {
  return processor.capabilities.some(
    (capability) => capability.kind === "model.invoke",
  );
}

function runtimeGrantsAllowModel(
  runtime: VaultRuntime,
  processorId: string,
): boolean {
  return runtime.resolveGrants(processorId).some(
    (capability) => capability.kind === "model.invoke",
  );
}

function formatBundleModelStatus(opts: {
  readonly enabled: boolean;
  readonly modelProcessorCount: number;
  readonly modelGranted: boolean;
  readonly providerConfigured: boolean;
}): string {
  if (opts.modelProcessorCount === 0) return "none";
  if (!opts.enabled) {
    return opts.providerConfigured
      ? "disabled-provider-configured"
      : "disabled-no-provider";
  }
  if (!opts.modelGranted) return "declared-ungranted";
  if (!opts.providerConfigured) return "granted-no-provider";
  return "ready";
}

function inventoryLabel(opts: {
  readonly loaded: boolean;
  readonly inventory?: BundleManifestInventoryEntry;
}): string {
  if (opts.loaded) return "loaded";
  if (opts.inventory?.kind === "manifest") return "manifest";
  if (opts.inventory?.kind === "error") return "manifest-error";
  return "configured";
}

function manifestVersion(
  inventory: BundleManifestInventoryEntry | undefined,
): string {
  return inventory?.kind === "manifest" ? inventory.summary.version : "-";
}

function inventoryError(
  inventory: BundleManifestInventoryEntry | undefined,
): string {
  return inventory?.kind === "error" ? inventory.message : "-";
}

function formatBundleManifestError(error: LoadBundlesError): string {
  switch (error.kind) {
    case "manifest-read-failed":
      return `manifest-read-failed: ${error.cause}`;
    case "manifest-invalid":
      return `manifest-invalid: ${error.cause.kind}`;
    case "manifest-id-mismatch":
      return `manifest-id-mismatch: expected ${error.bundleDir}, got ${error.manifestId}`;
    default:
      return error.kind;
  }
}

function formatTriggerKinds(triggers: ReadonlyArray<Trigger>): string {
  return formatUnique(triggers.map((trigger) => trigger.kind));
}

function formatCommandTriggers(triggers: ReadonlyArray<Trigger>): string {
  const commands = triggers.flatMap((trigger) =>
    trigger.kind === "command" ? [trigger.name] : [],
  );
  return commands.length === 0 ? "-" : formatUnique(commands);
}

function formatCapabilityKinds(capabilities: ReadonlyArray<Capability>): string {
  return formatUnique(capabilities.map((capability) => capability.kind));
}

function formatModelStatus(opts: {
  readonly declared: boolean;
  readonly granted: boolean;
  readonly providerConfigured: boolean;
}): string {
  if (!opts.declared) return "none";
  if (!opts.granted) return "declared-ungranted";
  if (!opts.providerConfigured) return "granted-no-provider";
  return "ready";
}

function formatUnique(values: ReadonlyArray<string>): string {
  return [...new Set(values)].sort().join(",");
}

/**
 * Parse the `--limit` flag. Returns the default when absent, the parsed
 * integer when valid, or `null` on a malformed value (caller treats as
 * usage error).
 */
function parseLimit(
  raw: string | number | boolean | undefined,
  fallback: number,
): number | null {
  return parsePositiveIntegerValue(raw, fallback);
}
