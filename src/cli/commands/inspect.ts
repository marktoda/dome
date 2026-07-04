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
//   - `patches`     → `queryPatchRecords(ledger, { limit })`
//   - `facts`       → `queryFactRecords(projection)`
//   - `diagnostics` → `queryDiagnostics(projection)`
//   - `questions`   → `queryQuestionRecords(projection)`
//   - `outbox`      → `queryOutbox(outbox)`
//   - `quarantine`  → `executionState.quarantines()`
//   - `bundles`     → configured/loaded extension bundle summary
//   - `processors`  → loaded processor/automation summary
//   - `cost`        → `aggregateCostUsdByProcessor(ledger)` — spend report
//                     over the run ledger's `cost_usd` (`--days N`,
//                     default 7). Unlike the other subjects this does NOT
//                     open the vault runtime: it opens runs.db read-only
//                     and mirrors `dome log`'s refuse-to-scaffold posture
//                     (a vault without a ledger gets a clean zero table,
//                     not a freshly created database file).
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
//   - `--processor` filters diagnostics and patch provenance because those
//     subjects are processor-attributed operational rows.
//
// Renamed from the pre-recut `dome doctor --show <subject>` in the v1.0
// CLI surface recut (per cli.md §"dome inspect"). The previous
// `dome doctor` namespace is reserved for the v1.x health-check verb;
// this surface is the read half.

import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import { compareStrings } from "../../core/compare";
import type {
  DiagnosticEffect,
  FactEffect,
  NodeRef,
} from "../../core/effect";
import type {
  Capability,
  Processor,
  ProcessorPhase,
  Trigger,
} from "../../core/processor";
import { openVaultRuntime, type VaultRuntime } from "../../engine/host/vault-runtime";
import { emitRuntimeOpenFailure } from "../command-error";
import {
  loadBundleManifestSummaryFromRoots,
  type BundleManifestSummary,
  type LoadBundlesError,
} from "../../extensions/loader";
import { queryPatchRecords } from "../../ledger/capability-uses";
import { openLedgerDb, type LedgerDb } from "../../ledger/db";
import {
  aggregateCostUsdByProcessor,
  queryRuns,
  startOfLocalDay,
  type ProcessorCostRow,
} from "../../ledger/runs";
import {
  queryDiagnosticRecords,
  type DiagnosticsFilter,
} from "../../projections/diagnostics";
import {
  queryFactRecords,
  type FactRecordFilter,
} from "../../projections/facts";
import { queryQuestionRecords } from "../../projections/questions";
import { queryOutbox } from "../../outbox/dispatch";
import { resolveVaultPath } from "../../surface/resolve-vault";

import { resolveBundleRoots, type ResolvedBundleRoots } from "./sync-shared";

import {
  formatSourceRefs,
  summarizeDiagnosticEffects,
  type DiagnosticSeverity,
  type DiagnosticSummary,
} from "../../surface/diagnostic-summary";
import { formatJson } from "../../surface/format";
import {
  headline,
  kv,
  paint,
  resolveCaps,
  section,
  table,
  usd,
  type KvRow,
} from "../presenter";
import { parsePositiveIntegerValue } from "../parse-options";
import {
  columnsFor,
  DIAGNOSTIC_SUMMARY_COLUMNS,
  hiddenHint,
  hiddenHintForDiagnosticSummary,
} from "./inspect-columns";

// ----- Constants ------------------------------------------------------------

const DEFAULT_LIMIT = 20;
const DEFAULT_COST_DAYS = 7;
const VALID_SUBJECTS = new Set<string>([
  "bundles",
  "processors",
  "runs",
  "patches",
  "facts",
  "diagnostics",
  "questions",
  "outbox",
  "quarantine",
  "cost",
]);

/** JSON envelope schema for `dome inspect cost --json`. */
export const INSPECT_COST_SCHEMA = "dome.inspect.cost/v1";
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
  readonly predicate?: string | undefined;
  readonly subjectKind?: string | undefined;
  readonly subjectId?: string | undefined;
  readonly model?: boolean | undefined;
  readonly days?: string | number | boolean | undefined;
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
      "dome inspect: subject is required. Subjects: bundles, processors, runs, patches, facts, diagnostics, questions, outbox, quarantine, cost.",
    );
    return 64;
  }
  if (!VALID_SUBJECTS.has(subject)) {
    console.error(
      `dome inspect: unknown subject '${subject}'. Available: bundles, processors, runs, patches, facts, diagnostics, questions, outbox, quarantine, cost.`,
    );
    return 64;
  }

  const vaultPath = resolveVaultPath(options.vault);

  const limit = parseLimit(options.limit, defaultLimitForSubject(subject));
  if (limit === null) {
    console.error("dome inspect: --limit must be a positive integer.");
    return 64;
  }
  if (options.days !== undefined && subject !== "cost") {
    console.error("dome inspect: --days is only valid for the cost subject.");
    return 64;
  }
  const days = parsePositiveIntegerValue(options.days, DEFAULT_COST_DAYS);
  if (days === null) {
    console.error("dome inspect: --days must be a positive integer.");
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
  const factOptions = parseFactOptions({
    subject,
    ...(options.predicate !== undefined ? { predicate: options.predicate } : {}),
    ...(options.subjectKind !== undefined
      ? { subjectKind: options.subjectKind }
      : {}),
    ...(options.subjectId !== undefined ? { subjectId: options.subjectId } : {}),
  });
  if (factOptions.ok === false) {
    console.error(factOptions.message);
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

  // The spend report is ledger-only — no runtime open, no scaffolding.
  if (subject === "cost") {
    return runInspectCost({
      vaultPath,
      days,
      limit,
      json: options.json === true,
    });
  }

  const bundleRoots = resolveBundleRoots({
    vaultPath,
    bundlesRoot: options.bundlesRoot,
  });
  const runtimeResult = await openVaultRuntime({ vaultPath, ...bundleRoots });
  if (!runtimeResult.ok) {
    return emitRuntimeOpenFailure({
      command: "inspect",
      json: options.json === true,
      errorKind: runtimeResult.error.kind,
    });
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
        factOptions: factOptions.value,
        processorFilter: options.processor,
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
      printTextResult(subject, result, vaultPath);
    }
    return 0;
  } finally {
    await runtime.close();
  }
}

// ----- cost subject ----------------------------------------------------------
//
// `dome inspect cost [--days N]` — the spend report. Ledger-only: the
// other subjects open the vault runtime (which initializes the
// operational databases), but a spend *read* must not scaffold state in
// a vault it only observes, so this path mirrors `dome log`'s
// refuse-to-scaffold ledger open (src/surface/activity.ts): a missing
// runs.db short-circuits to a clean zero report.

const DAY_MS = 24 * 60 * 60 * 1000;

type CostSubtotal = {
  readonly runs: number;
  readonly total_cost_usd: number;
  readonly today_cost_usd: number;
};

type CostExtensionRow = CostSubtotal & { readonly extension: string };
type CostProcessorReportRow = CostExtensionRow & { readonly processor: string };

type CostReport = {
  readonly days: number;
  readonly since: string;
  readonly today: string;
  readonly processors: ReadonlyArray<CostProcessorReportRow>;
  readonly extensions: ReadonlyArray<CostExtensionRow>;
  readonly total: CostSubtotal;
};

type CostLedgerOpen =
  | { readonly kind: "open"; readonly db: LedgerDb }
  | { readonly kind: "absent" }
  | { readonly kind: "error"; readonly message: string };

async function runInspectCost(opts: {
  readonly vaultPath: string;
  readonly days: number;
  readonly limit: number;
  readonly json: boolean;
}): Promise<number> {
  const ledger = await openCostLedgerReadOnly(opts.vaultPath);
  if (ledger.kind === "error") {
    console.error(
      `dome inspect cost: state read failed. The run ledger may be corrupt: ${ledger.message}`,
    );
    return 1;
  }

  const now = new Date();
  const sinceIso = new Date(now.getTime() - opts.days * DAY_MS).toISOString();
  const todayIso = startOfLocalDay(now).toISOString();

  let rows: ReadonlyArray<ProcessorCostRow> = [];
  if (ledger.kind === "open") {
    try {
      rows = aggregateCostUsdByProcessor(ledger.db, { sinceIso, todayIso });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `dome inspect cost: state read failed. The operational database may be corrupt: ${msg}`,
      );
      return 1;
    } finally {
      ledger.db.close();
    }
  }

  const report = buildCostReport({
    days: opts.days,
    since: sinceIso,
    today: todayIso,
    rows,
    limit: opts.limit,
  });
  if (opts.json) {
    console.log(formatJson({ schema: INSPECT_COST_SCHEMA, ...report }));
  } else {
    printCostText(report, opts.vaultPath);
  }
  return 0;
}

/**
 * Open runs.db for the spend read, tolerating its absence. `openLedgerDb`
 * would create a fresh file (CLI-native reads must not scaffold state),
 * so a missing file short-circuits to the zero report; an open refusal
 * (schema mismatch / corrupt file) is a hard error — unlike `dome log`'s
 * garnish join, the ledger IS this subject's data.
 */
async function openCostLedgerReadOnly(
  vaultPath: string,
): Promise<CostLedgerOpen> {
  const path = join(vaultPath, ".dome", "state", "runs.db");
  if (!existsSync(path)) return { kind: "absent" };
  const result = await openLedgerDb({ path });
  if (!result.ok) return { kind: "error", message: result.error.kind };
  return { kind: "open", db: result.value.db };
}

function buildCostReport(opts: {
  readonly days: number;
  readonly since: string;
  readonly today: string;
  readonly rows: ReadonlyArray<ProcessorCostRow>;
  readonly limit: number;
}): CostReport {
  const processors = opts.rows.slice(0, opts.limit).map((row) =>
    Object.freeze({
      processor: row.processorId,
      extension: extensionIdForProcessor(row.processorId),
      runs: row.runs,
      total_cost_usd: row.totalCostUsd,
      today_cost_usd: row.todayCostUsd,
    }),
  );

  // Subtotals and the grand total aggregate over ALL rows, not the
  // `--limit` slice — a truncated table must not understate spend.
  const byExtension = new Map<
    string,
    { runs: number; total: number; today: number }
  >();
  let totalRuns = 0;
  let totalCost = 0;
  let todayCost = 0;
  for (const row of opts.rows) {
    const extension = extensionIdForProcessor(row.processorId);
    const acc = byExtension.get(extension) ?? { runs: 0, total: 0, today: 0 };
    acc.runs += row.runs;
    acc.total += row.totalCostUsd;
    acc.today += row.todayCostUsd;
    byExtension.set(extension, acc);
    totalRuns += row.runs;
    totalCost += row.totalCostUsd;
    todayCost += row.todayCostUsd;
  }
  const extensions = [...byExtension.entries()]
    .map(([extension, acc]) =>
      Object.freeze({
        extension,
        runs: acc.runs,
        total_cost_usd: acc.total,
        today_cost_usd: acc.today,
      }),
    )
    .sort((a, b) =>
      a.total_cost_usd === b.total_cost_usd
        ? compareStrings(a.extension, b.extension)
        : b.total_cost_usd - a.total_cost_usd,
    );

  return Object.freeze({
    days: opts.days,
    since: opts.since,
    today: opts.today,
    processors: Object.freeze(processors),
    extensions: Object.freeze(extensions),
    total: Object.freeze({
      runs: totalRuns,
      total_cost_usd: totalCost,
      today_cost_usd: todayCost,
    }),
  });
}

/**
 * Ledger rows carry no extension column; subtotals group by the
 * processor id's parent namespace (`dome.agent.ingest` → `dome.agent`),
 * which equals the bundle id for every first-party bundle. An undotted
 * id groups under itself.
 */
function extensionIdForProcessor(processorId: string): string {
  const lastDot = processorId.lastIndexOf(".");
  return lastDot <= 0 ? processorId : processorId.slice(0, lastDot);
}

function printCostText(report: CostReport, vaultPath: string): void {
  const caps = resolveCaps();
  const context = basename(vaultPath);
  const lines: string[] = [];
  const status =
    report.processors.length === 0
      ? { tone: "muted" as const, label: `no spend in ${report.days}d` }
      : {
          tone: "plain" as const,
          label: `${report.days}d · ${usd(report.total.total_cost_usd)}`,
        };
  lines.push(headline({ cmd: "inspect cost", context }, status, caps));
  if (report.processors.length === 0) {
    console.log(lines.join("\n"));
    return;
  }
  lines.push("");
  lines.push(
    ...table(
      report.processors as ReadonlyArray<Record<string, unknown>>,
      columnsFor("cost"),
      caps,
    ),
  );
  if (report.extensions.length > 0) {
    lines.push(
      ...section(
        "Extensions",
        kv(
          report.extensions.map((ext) => ({
            label: ext.extension,
            value: `${usd(ext.total_cost_usd)} · today ${usd(ext.today_cost_usd)} · ${ext.runs} runs`,
          })),
          caps,
        ),
        caps,
      ),
    );
  }
  lines.push(
    ...section(
      "Total",
      kv(
        [
          { label: "window", value: usd(report.total.total_cost_usd) },
          { label: "today", value: usd(report.total.today_cost_usd) },
          { label: "runs", value: String(report.total.runs) },
        ],
        caps,
      ),
      caps,
    ),
  );
  const hint = hiddenHint("cost");
  if (hint.length > 0) {
    lines.push("");
    lines.push(`  ${paint(hint, "muted", caps)}`);
  }
  console.log(lines.join("\n"));
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
type ParseFactOptionsResult =
  | { readonly ok: true; readonly value: FactRecordFilter | null }
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
  readonly factOptions: FactRecordFilter | null;
  readonly processorFilter: string | undefined;
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
      opts.factOptions,
      opts.processorFilter,
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
  factOptions: FactRecordFilter | null,
  processorFilter: string | undefined,
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
          grant_scopes: formatCapabilityScopes(grantedCapabilities),
          grant_details: capabilityGrantDetails(grantedCapabilities),
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
    case "patches": {
      const patches = queryPatchRecords(runtime.ledgerDb, {
        limit,
        ...(processorFilter !== undefined
          ? { processorId: processorFilter }
          : {}),
      });
      return patches.map((patch) => ({
        id: patch.id,
        run: patch.runId,
        processor: patch.processorId,
        phase: patch.phase,
        status: patch.status,
        capability: patch.capability,
        outcome: patch.outcome,
        paths: patch.resource ?? "-",
        input: shortOid(patch.inputCommit),
        output: patch.outputCommit === null ? "-" : shortOid(patch.outputCommit),
        effect_hashes: patch.effectHashes.length,
        started_at: patch.startedAt,
        finished_at: patch.finishedAt ?? "-",
        recorded_at: patch.recordedAt,
      }));
    }
    case "facts": {
      const all = queryFactRecords(runtime.projectionDb, factOptions ?? {});
      return all.slice(0, limit).map((fact) => ({
        id: fact.id,
        subject: formatNodeRef(fact.effect.subject),
        predicate: fact.effect.predicate,
        object: formatFactObject(fact.effect.object),
        assertion: fact.effect.assertion,
        confidence: fact.effect.confidence ?? "-",
        processor: fact.processorId,
        run: fact.runId,
        adopted: fact.adoptedCommit,
        written_at: fact.writtenAt,
        source_refs: formatSourceRefs(fact.effect.sourceRefs),
      }));
    }
    case "diagnostics": {
      const all = filteredDiagnosticRecords(runtime, diagnosticOptions);
      return all.slice(0, limit).map((d) => ({
        id: d.id,
        severity: d.effect.severity,
        code: d.effect.code,
        message: d.effect.message,
        processor: d.processorId,
        run: d.runId ?? "-",
        proposal: d.proposalId ?? "-",
        adopted: d.adoptedCommit,
        written_at: d.writtenAt,
        source_refs: formatSourceRefs(d.effect.sourceRefs),
      }));
    }
    case "questions": {
      const all = queryQuestionRecords(runtime.projectionDb);
      return all.slice(0, limit).map((q) => ({
        id: q.id,
        status: q.answeredAt === null ? "open" : "answered",
        question: q.effect.question,
        options: q.effect.options ?? "-",
        metadata: q.effect.metadata ?? "-",
        processor: q.processorId,
        run: q.runId,
        adopted: q.adoptedCommit,
        source_refs: formatSourceRefs(q.effect.sourceRefs),
        answer: q.answer ?? "-",
        asked_at: q.askedAt,
        answered_at: q.answeredAt ?? "-",
        answered_by: q.answeredBy ?? "-",
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
): ReadonlyArray<DiagnosticEffect> {
  return Object.freeze(
    filteredDiagnosticRecords(runtime, diagnosticOptions).map(
      (record) => record.effect,
    ),
  );
}

function filteredDiagnosticRecords(
  runtime: VaultRuntime,
  diagnosticOptions: ParsedDiagnosticOptions | null,
): ReturnType<typeof queryDiagnosticRecords> {
  const diagnostics = queryDiagnosticRecords(
    runtime.projectionDb,
    diagnosticOptions?.filter,
  );
  const code = diagnosticOptions?.code;
  if (code === undefined) return diagnostics;
  return Object.freeze(
    diagnostics.filter((record) => record.effect.code === code),
  );
}

function jsonForResult(
  result: InspectResult,
): ReadonlyArray<Row> | DiagnosticSummary {
  return result.kind === "rows" ? result.rows : result.summary;
}

function printTextResult(subject: string, result: InspectResult, vaultPath: string): void {
  const caps = resolveCaps();
  const context = basename(vaultPath);
  const lines: string[] = [];
  if (result.kind === "rows") {
    const rowCount = result.rows.length;
    const rowStatus =
      rowCount === 0
        ? { tone: "muted" as const, label: "no rows" }
        : { tone: "plain" as const, label: `${rowCount} rows` };
    lines.push(headline({ cmd: `inspect ${subject}`, context }, rowStatus, caps));
    if (rowCount === 0) {
      console.log(lines.join("\n"));
      return;
    }
    lines.push("");
    lines.push(
      ...table(result.rows as ReadonlyArray<Record<string, unknown>>, columnsFor(subject), caps),
    );
    const hint = hiddenHint(subject);
    if (hint.length > 0) {
      lines.push("");
      lines.push(`  ${paint(hint, "muted", caps)}`);
    }
    console.log(lines.join("\n"));
    return;
  }
  // diagnostic-summary mode
  lines.push(
    headline({ cmd: "inspect diagnostics", context }, { tone: "plain", label: "summary" }, caps),
  );
  const summaryKvRows: KvRow[] = [
    { label: "total", value: String(result.summary.total) },
    {
      label: "groups",
      value: `${result.summary.shown_groups}/${result.summary.group_count}`,
    },
  ];
  lines.push(...section("Summary", kv(summaryKvRows, caps), caps));
  // Render summary groups via dedicated summary column set
  const summaryGroupRows = result.summary.groups.map((g) => ({
    severity: g.severity,
    code: g.code,
    count: g.count,
    first_source_refs: g.first_source_refs,
  }));
  lines.push("");
  lines.push(
    ...table(summaryGroupRows, DIAGNOSTIC_SUMMARY_COLUMNS, caps),
  );
  const summaryHint = hiddenHintForDiagnosticSummary();
  if (summaryHint.length > 0) {
    lines.push("");
    lines.push(`  ${paint(summaryHint, "muted", caps)}`);
  }
  console.log(lines.join("\n"));
}

function parseDiagnosticOptions(opts: {
  readonly subject: string;
  readonly summary?: boolean;
  readonly severity?: string;
  readonly code?: string;
  readonly processor?: string;
}): ParseDiagnosticOptionsResult {
  const hasDiagnosticOnlyOption =
    opts.summary === true ||
    opts.severity !== undefined ||
    opts.code !== undefined;
  const hasDiagnosticOption =
    hasDiagnosticOnlyOption || opts.processor !== undefined;
  if (!hasDiagnosticOption) {
    return { ok: true, value: null };
  }
  if (hasDiagnosticOnlyOption && opts.subject !== "diagnostics") {
    return {
      ok: false,
      message:
        "dome inspect: --summary, --severity, and --code are only valid for the diagnostics subject.",
    };
  }
  if (
    opts.processor !== undefined &&
    opts.subject !== "diagnostics" &&
    opts.subject !== "patches"
  ) {
    return {
      ok: false,
      message:
        "dome inspect: --processor is only valid for the diagnostics and patches subjects.",
    };
  }
  if (opts.subject !== "diagnostics") {
    return { ok: true, value: null };
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

function parseFactOptions(opts: {
  readonly subject: string;
  readonly predicate?: string;
  readonly subjectKind?: string;
  readonly subjectId?: string;
}): ParseFactOptionsResult {
  const hasFactOption =
    opts.predicate !== undefined ||
    opts.subjectKind !== undefined ||
    opts.subjectId !== undefined;
  if (!hasFactOption) {
    return { ok: true, value: null };
  }
  if (opts.subject !== "facts") {
    return {
      ok: false,
      message:
        "dome inspect: --predicate, --subject-kind, and --subject-id are only valid for the facts subject.",
    };
  }
  if (opts.subjectKind !== undefined && !isFactSubjectKind(opts.subjectKind)) {
    return {
      ok: false,
      message:
        "dome inspect facts: --subject-kind must be one of page, task, entity.",
    };
  }
  if (
    (opts.subjectKind === undefined) !== (opts.subjectId === undefined)
  ) {
    return {
      ok: false,
      message:
        "dome inspect facts: --subject-kind and --subject-id must be provided together.",
    };
  }

  const filter: FactRecordFilter = {
    ...(opts.predicate !== undefined ? { predicate: opts.predicate } : {}),
    ...(opts.subjectKind !== undefined && opts.subjectId !== undefined
      ? {
          subjectKind: opts.subjectKind,
          subjectId: opts.subjectId,
        }
      : {}),
  };
  return {
    ok: true,
    value: Object.keys(filter).length === 0 ? null : filter,
  };
}

function isDiagnosticSeverity(value: string): value is DiagnosticSeverity {
  return VALID_DIAGNOSTIC_SEVERITIES.has(value as DiagnosticSeverity);
}

function isFactSubjectKind(
  value: string,
): value is NonNullable<FactRecordFilter["subjectKind"]> {
  return value === "page" || value === "task" || value === "entity";
}

function defaultLimitForSubject(subject: string): number {
  // cost is a bounded aggregation (one row per cost-bearing processor),
  // so like the metadata subjects it defaults to the full set.
  if (subject === "bundles" || subject === "processors" || subject === "cost") {
    return Number.MAX_SAFE_INTEGER;
  }
  return DEFAULT_LIMIT;
}

function formatNodeRef(ref: NodeRef): string {
  if (ref.kind === "page") return `page:${ref.path}`;
  if (ref.kind === "task") return `task:${ref.stableId}`;
  return `entity:${ref.name}`;
}

function formatFactObject(object: FactEffect["object"]): string {
  if (object.kind === "string") return object.value;
  if (object.kind === "number") return String(object.value);
  if (object.kind === "date") return object.value;
  return formatNodeRef(object);
}

function shortOid(oid: string): string {
  return oid.slice(0, 12);
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
    case "bundle-not-found":
      return `bundle-not-found: ${error.bundleIds.join(", ")}`;
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

function formatCapabilityScopes(capabilities: ReadonlyArray<Capability>): string {
  const scopes = capabilities.flatMap(capabilityScopeLabels);
  return scopes.length === 0 ? "-" : scopes.sort().join("; ");
}

type CapabilityGrantDetail = {
  readonly kind: Capability["kind"];
  readonly scope: string;
  readonly values: ReadonlyArray<string>;
};

function capabilityGrantDetails(
  capabilities: ReadonlyArray<Capability>,
): ReadonlyArray<CapabilityGrantDetail> {
  return Object.freeze(
    capabilities
      .flatMap((capability) =>
        capabilityScopeDetails(capability).map((detail) =>
          Object.freeze(detail)
        )
      )
      .sort((a, b) =>
        a.kind < b.kind
          ? -1
          : a.kind > b.kind
            ? 1
            : a.scope < b.scope
              ? -1
              : a.scope > b.scope
                ? 1
                : 0
      ),
  );
}

function capabilityScopeLabels(capability: Capability): ReadonlyArray<string> {
  return capabilityScopeDetails(capability).map((detail) =>
    detail.values.length === 0
      ? detail.kind
      : `${detail.kind}:${detail.values.join(",")}`
  );
}

function capabilityScopeDetails(
  capability: Capability,
): ReadonlyArray<CapabilityGrantDetail> {
  switch (capability.kind) {
    case "read":
    case "patch.propose":
    case "patch.auto":
    case "owns.path":
    case "search.write":
      return [grantDetail(capability.kind, "paths", capability.paths)];
    case "graph.write":
      return [grantDetail(capability.kind, "namespaces", capability.namespaces)];
    case "model.invoke":
      return [
        ...(capability.maxDailyCostUsd === undefined
          ? []
          : [
              grantDetail(capability.kind, "maxDailyCostUsd", [
                String(capability.maxDailyCostUsd),
              ]),
            ]),
        ...(capability.modelAllowlist === undefined
          ? []
          : [
              grantDetail(
                capability.kind,
                "modelAllowlist",
                capability.modelAllowlist,
              ),
            ]),
      ];
    case "external":
      return [grantDetail(capability.kind, "capability", [capability.capability])];
    case "outbox.read":
      return [grantDetail(capability.kind, "statuses", capability.statuses ?? [])];
    case "outbox.recover":
    case "quarantine.recover":
    case "run.recover":
      return [grantDetail(capability.kind, "actions", capability.actions)];
    case "run.read":
      return [grantDetail(capability.kind, "statuses", capability.statuses ?? [])];
    case "question.ask":
    case "quarantine.read":
    case "questions.read":
      return [grantDetail(capability.kind, "all", [])];
  }
}

function grantDetail(
  kind: Capability["kind"],
  scope: string,
  values: ReadonlyArray<string>,
): CapabilityGrantDetail {
  return Object.freeze({
    kind,
    scope,
    values: Object.freeze([...values].sort()),
  });
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
