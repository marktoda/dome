// cli/commands/inspect-columns: curated Column<Row> definitions for
// `dome inspect <subject>`.
//
// Each subject gets 4–6 columns chosen for human readability. Heavy fields
// (raw JSON, full IDs, verbose blobs) are intentionally omitted from the
// table view — they remain accessible via `--json`.
//
// Use `columnsFor(subject)` to get the columns and `hiddenHint(subject)` to
// get a muted footer hint naming what was dropped and how to retrieve it.

import type { Column } from "../presenter";
import { durationMs, relativeTime, usd } from "../presenter";

// We work with generic Row records throughout, as inspect.ts defines
// Row = Record<string, unknown>.
type Row = Record<string, unknown>;

function str(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "-";
}

// source-ref fields are produced by formatSourceRefs(), which joins with ", ".
function sourceRefCell(fieldName: string): (r: Row) => { text: string; tone: "muted" } {
  return (r) => {
    const refs = str(r[fieldName]);
    const first = refs.split(",")[0]?.trim();
    return { text: first && first.length > 0 ? first : "-", tone: "muted" as const };
  };
}

// ---------------------------------------------------------------------------
// processors
// ---------------------------------------------------------------------------

const PROCESSOR_COLUMNS: ReadonlyArray<Column<Row>> = [
  {
    header: "processor",
    get: (r) => ({ text: str(r["processor"]) }),
    priority: 1,
  },
  {
    header: "bundle",
    get: (r) => ({ text: str(r["bundle"]) }),
    priority: 2,
  },
  {
    header: "phase",
    get: (r) => ({ text: str(r["phase"]) }),
    priority: 3,
  },
  {
    header: "triggers",
    get: (r) => ({ text: str(r["triggers"]) }),
    priority: 4,
  },
  {
    header: "model",
    get: (r) => {
      const model = str(r["model"]);
      if (model === "none") return { text: model, tone: "muted" as const };
      if (model === "ready") return { text: "✓ ready", tone: "ok" as const };
      return { text: "○ " + model, tone: "warn" as const };
    },
    priority: 5,
  },
];

const PROCESSOR_HINT =
  "capabilities + grant detail hidden → --json, or --processor <id> for one row";

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

const RUNS_COLUMNS: ReadonlyArray<Column<Row>> = [
  {
    header: "processor",
    get: (r) => ({ text: str(r["processor"]) }),
    priority: 1,
  },
  {
    header: "phase",
    get: (r) => ({ text: str(r["phase"]) }),
    priority: 2,
  },
  {
    header: "status",
    get: (r) => {
      const status = str(r["status"]);
      if (status === "succeeded")
        return { text: status, tone: "ok" as const };
      if (
        status === "failed" ||
        status === "timed_out" ||
        status === "cancelled"
      )
        return { text: status, tone: "err" as const };
      if (status === "running" || status === "queued")
        return { text: status, tone: "muted" as const };
      return { text: status };
    },
    priority: 3,
  },
  {
    header: "when",
    get: (r) => {
      const val = r["started_at"];
      return {
        text:
          typeof val === "string" ? relativeTime(val) : "-",
        tone: "muted" as const,
      };
    },
    priority: 4,
  },
  {
    header: "took",
    get: (r) => {
      const val = r["duration_ms"];
      return {
        text:
          typeof val === "number" ? durationMs(val) : durationMs(null),
        tone: "muted" as const,
      };
    },
    priority: 5,
    align: "right" as const,
  },
];

const RUNS_HINT =
  "run id, proposal, exact timestamp hidden → --json";

// ---------------------------------------------------------------------------
// bundles
// ---------------------------------------------------------------------------

const BUNDLES_COLUMNS: ReadonlyArray<Column<Row>> = [
  {
    header: "bundle",
    get: (r) => ({ text: str(r["bundle"]) }),
    priority: 1,
  },
  {
    header: "status",
    get: (r) => {
      const status = str(r["status"]);
      if (status === "enabled") return { text: status, tone: "ok" as const };
      if (status === "disabled") return { text: status, tone: "muted" as const };
      return { text: status };
    },
    priority: 2,
  },
  {
    header: "model",
    get: (r) => {
      const model = str(r["model"]);
      if (model === "none") return { text: model, tone: "muted" as const };
      if (model === "ready") return { text: "✓ ready", tone: "ok" as const };
      return { text: "○ " + model, tone: "warn" as const };
    },
    priority: 3,
  },
  {
    header: "processors",
    get: (r) => ({
      text: String(typeof r["processors"] === "number" ? r["processors"] : "-"),
      tone: "plain" as const,
    }),
    priority: 4,
    align: "right" as const,
  },
];

const BUNDLES_HINT =
  "version, inventory, phase counts hidden → --json";

// ---------------------------------------------------------------------------
// diagnostics
// ---------------------------------------------------------------------------

const DIAGNOSTICS_COLUMNS: ReadonlyArray<Column<Row>> = [
  {
    header: "severity",
    get: (r) => {
      const sev = str(r["severity"]);
      if (sev === "block" || sev === "error")
        return { text: sev, tone: "err" as const };
      if (sev === "warning") return { text: sev, tone: "warn" as const };
      if (sev === "info") return { text: sev, tone: "info" as const };
      return { text: sev };
    },
    priority: 1,
  },
  {
    header: "code",
    get: (r) => ({ text: str(r["code"]) }),
    priority: 2,
  },
  {
    header: "message",
    get: (r) => ({ text: str(r["message"]) }),
    priority: 3,
  },
  {
    header: "source",
    get: sourceRefCell("source_refs"),
    priority: 4,
  },
];

const DIAGNOSTICS_HINT =
  "processor, run, proposal, adopted commit hidden → --json";

// ---------------------------------------------------------------------------
// facts
// ---------------------------------------------------------------------------

const FACTS_COLUMNS: ReadonlyArray<Column<Row>> = [
  {
    header: "predicate",
    get: (r) => ({ text: str(r["predicate"]) }),
    priority: 1,
  },
  {
    header: "subject",
    get: (r) => ({ text: str(r["subject"]) }),
    priority: 2,
  },
  {
    header: "object",
    get: (r) => ({ text: str(r["object"]) }),
    priority: 3,
  },
  {
    header: "source",
    get: sourceRefCell("source_refs"),
    priority: 4,
  },
];

const FACTS_HINT =
  "assertion, confidence, processor, run, adopted commit hidden → --json";

// ---------------------------------------------------------------------------
// patches
// ---------------------------------------------------------------------------

const PATCHES_COLUMNS: ReadonlyArray<Column<Row>> = [
  {
    header: "processor",
    get: (r) => ({ text: str(r["processor"]) }),
    priority: 1,
  },
  {
    header: "path",
    get: (r) => ({ text: str(r["paths"]) }),
    priority: 2,
  },
  {
    header: "capability",
    get: (r) => ({ text: str(r["capability"]) }),
    priority: 3,
  },
  {
    header: "status",
    get: (r) => {
      const status = str(r["status"]);
      if (status === "succeeded") return { text: status, tone: "ok" as const };
      if (status === "failed") return { text: status, tone: "err" as const };
      return { text: status };
    },
    priority: 4,
  },
  {
    header: "outcome",
    get: (r) => ({ text: str(r["outcome"]) }),
    priority: 5,
  },
];

const PATCHES_HINT =
  "run id, commit hashes, effect hashes, timestamps hidden → --json";

// ---------------------------------------------------------------------------
// questions
// ---------------------------------------------------------------------------

const QUESTIONS_COLUMNS: ReadonlyArray<Column<Row>> = [
  {
    header: "status",
    get: (r) => {
      const status = str(r["status"]);
      if (status === "answered") return { text: status, tone: "ok" as const };
      if (status === "open") return { text: status, tone: "warn" as const };
      return { text: status };
    },
    priority: 1,
  },
  {
    header: "processor",
    get: (r) => ({ text: str(r["processor"]) }),
    priority: 2,
  },
  {
    header: "question",
    get: (r) => ({ text: str(r["question"]) }),
    priority: 3,
  },
  {
    header: "source",
    get: sourceRefCell("source_refs"),
    priority: 4,
  },
];

const QUESTIONS_HINT =
  "full id, options, metadata, answer, timestamps hidden → --json";

// ---------------------------------------------------------------------------
// outbox
// ---------------------------------------------------------------------------

const OUTBOX_COLUMNS: ReadonlyArray<Column<Row>> = [
  {
    header: "capability",
    get: (r) => ({ text: str(r["capability"]) }),
    priority: 1,
  },
  {
    header: "status",
    get: (r) => {
      const status = str(r["status"]);
      if (status === "succeeded" || status === "dispatched")
        return { text: status, tone: "ok" as const };
      if (status === "failed") return { text: status, tone: "err" as const };
      if (status === "pending") return { text: status, tone: "muted" as const };
      return { text: status };
    },
    priority: 2,
  },
  {
    header: "attempts",
    get: (r) => ({
      text: String(typeof r["attempts"] === "number" ? r["attempts"] : "-"),
    }),
    priority: 3,
    align: "right" as const,
  },
  {
    header: "when",
    get: (r) => {
      const val = r["enqueued_at"];
      return {
        text: typeof val === "string" ? relativeTime(val) : "-",
        tone: "muted" as const,
      };
    },
    priority: 4,
  },
];

const OUTBOX_HINT =
  "full id, next_attempt_at, last_error hidden → --json";

// ---------------------------------------------------------------------------
// quarantine
// ---------------------------------------------------------------------------

const QUARANTINE_COLUMNS: ReadonlyArray<Column<Row>> = [
  {
    header: "processor",
    get: (r) => ({ text: str(r["processor"]) }),
    priority: 1,
  },
  {
    header: "phase",
    get: (r) => ({ text: str(r["phase"]) }),
    priority: 2,
  },
  {
    header: "failures",
    get: (r) => ({
      text: String(typeof r["failures"] === "number" ? r["failures"] : "-"),
    }),
    priority: 3,
    align: "right" as const,
  },
  {
    header: "reason",
    get: (r) => ({ text: str(r["reason"]) }),
    priority: 4,
  },
  {
    header: "when",
    get: (r) => {
      const val = r["quarantined_at"];
      return {
        text: typeof val === "string" ? relativeTime(val) : "-",
        tone: "muted" as const,
      };
    },
    priority: 5,
  },
];

const QUARANTINE_HINT =
  "trigger hash, quarantine id, version hidden → --json";

// ---------------------------------------------------------------------------
// cost
// ---------------------------------------------------------------------------

function usdCell(fieldName: string): (r: Row) => { text: string } {
  return (r) => {
    const value = r[fieldName];
    return { text: typeof value === "number" ? usd(value) : "-" };
  };
}

const COST_COLUMNS: ReadonlyArray<Column<Row>> = [
  {
    header: "processor",
    get: (r) => ({ text: str(r["processor"]) }),
    priority: 1,
  },
  {
    header: "runs",
    get: (r) => ({
      text: String(typeof r["runs"] === "number" ? r["runs"] : "-"),
    }),
    priority: 2,
    align: "right" as const,
  },
  {
    header: "total",
    get: usdCell("total_cost_usd"),
    priority: 3,
    align: "right" as const,
  },
  {
    header: "today",
    get: usdCell("today_cost_usd"),
    priority: 4,
    align: "right" as const,
  },
];

const COST_HINT =
  "window bounds + full precision → --json; per-run rows → dome inspect runs";

// ---------------------------------------------------------------------------
// diagnostic-summary (groups table)
// ---------------------------------------------------------------------------

export const DIAGNOSTIC_SUMMARY_COLUMNS: ReadonlyArray<Column<Row>> = [
  {
    header: "severity",
    get: (r) => {
      const sev = str(r["severity"]);
      if (sev === "block" || sev === "error")
        return { text: sev, tone: "err" as const };
      if (sev === "warning") return { text: sev, tone: "warn" as const };
      if (sev === "info") return { text: sev, tone: "info" as const };
      return { text: sev };
    },
    priority: 1,
  },
  {
    header: "code",
    get: (r) => ({ text: str(r["code"]) }),
    priority: 2,
  },
  {
    header: "count",
    get: (r) => ({
      text: String(typeof r["count"] === "number" ? r["count"] : "-"),
    }),
    priority: 3,
    align: "right" as const,
  },
  {
    header: "source",
    get: sourceRefCell("first_source_refs"),
    priority: 4,
  },
];

const DIAGNOSTIC_SUMMARY_HINT =
  "first_message hidden → --json";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function columnsFor(subject: string): ReadonlyArray<Column<Row>> {
  switch (subject) {
    case "processors":
      return PROCESSOR_COLUMNS;
    case "runs":
      return RUNS_COLUMNS;
    case "bundles":
      return BUNDLES_COLUMNS;
    case "diagnostics":
      return DIAGNOSTICS_COLUMNS;
    case "facts":
      return FACTS_COLUMNS;
    case "patches":
      return PATCHES_COLUMNS;
    case "questions":
      return QUESTIONS_COLUMNS;
    case "outbox":
      return OUTBOX_COLUMNS;
    case "quarantine":
      return QUARANTINE_COLUMNS;
    case "cost":
      return COST_COLUMNS;
    default:
      return [];
  }
}

export function hiddenHint(subject: string): string {
  switch (subject) {
    case "processors":
      return PROCESSOR_HINT;
    case "runs":
      return RUNS_HINT;
    case "bundles":
      return BUNDLES_HINT;
    case "diagnostics":
      return DIAGNOSTICS_HINT;
    case "facts":
      return FACTS_HINT;
    case "patches":
      return PATCHES_HINT;
    case "questions":
      return QUESTIONS_HINT;
    case "outbox":
      return OUTBOX_HINT;
    case "quarantine":
      return QUARANTINE_HINT;
    case "cost":
      return COST_HINT;
    default:
      return "";
  }
}

export function hiddenHintForDiagnosticSummary(): string {
  return DIAGNOSTIC_SUMMARY_HINT;
}
