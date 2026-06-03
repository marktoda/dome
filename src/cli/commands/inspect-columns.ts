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
import { durationMs, relativeTime } from "../presenter";

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

// ---------------------------------------------------------------------------
// processors
// ---------------------------------------------------------------------------

const PROCESSOR_COLUMNS: ReadonlyArray<Column<Row>> = [
  {
    header: "PROCESSOR",
    get: (r) => ({ text: str(r["processor"]) }),
    priority: 1,
  },
  {
    header: "BUNDLE",
    get: (r) => ({ text: str(r["bundle"]) }),
    priority: 2,
  },
  {
    header: "PHASE",
    get: (r) => ({ text: str(r["phase"]) }),
    priority: 3,
  },
  {
    header: "TRIGGERS",
    get: (r) => ({ text: str(r["triggers"]) }),
    priority: 4,
  },
  {
    header: "MODEL",
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
    header: "PROCESSOR",
    get: (r) => ({ text: str(r["processor"]) }),
    priority: 1,
  },
  {
    header: "PHASE",
    get: (r) => ({ text: str(r["phase"]) }),
    priority: 2,
  },
  {
    header: "STATUS",
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
    header: "WHEN",
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
    header: "TOOK",
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
    header: "BUNDLE",
    get: (r) => ({ text: str(r["bundle"]) }),
    priority: 1,
  },
  {
    header: "STATUS",
    get: (r) => {
      const status = str(r["status"]);
      if (status === "enabled") return { text: status, tone: "ok" as const };
      if (status === "disabled") return { text: status, tone: "muted" as const };
      return { text: status };
    },
    priority: 2,
  },
  {
    header: "MODEL",
    get: (r) => {
      const model = str(r["model"]);
      if (model === "none") return { text: model, tone: "muted" as const };
      if (model === "ready") return { text: "✓ ready", tone: "ok" as const };
      return { text: "○ " + model, tone: "warn" as const };
    },
    priority: 3,
  },
  {
    header: "PROCESSORS",
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
    header: "SEVERITY",
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
    header: "CODE",
    get: (r) => ({ text: str(r["code"]) }),
    priority: 2,
  },
  {
    header: "MESSAGE",
    get: (r) => ({ text: str(r["message"]) }),
    priority: 3,
  },
  {
    header: "SOURCE",
    get: (r) => {
      const refs = str(r["source_refs"]);
      // source_refs is a semicolon-separated list; take the first one
      const first = refs.split(";")[0]?.trim() ?? "-";
      return { text: first, tone: "muted" as const };
    },
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
    header: "PREDICATE",
    get: (r) => ({ text: str(r["predicate"]) }),
    priority: 1,
  },
  {
    header: "SUBJECT",
    get: (r) => ({ text: str(r["subject"]) }),
    priority: 2,
  },
  {
    header: "OBJECT",
    get: (r) => ({ text: str(r["object"]) }),
    priority: 3,
  },
  {
    header: "SOURCE",
    get: (r) => {
      const refs = str(r["source_refs"]);
      const first = refs.split(";")[0]?.trim() ?? "-";
      return { text: first, tone: "muted" as const };
    },
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
    header: "PROCESSOR",
    get: (r) => ({ text: str(r["processor"]) }),
    priority: 1,
  },
  {
    header: "PATH",
    get: (r) => ({ text: str(r["paths"]) }),
    priority: 2,
  },
  {
    header: "CAPABILITY",
    get: (r) => ({ text: str(r["capability"]) }),
    priority: 3,
  },
  {
    header: "STATUS",
    get: (r) => {
      const status = str(r["status"]);
      if (status === "succeeded") return { text: status, tone: "ok" as const };
      if (status === "failed") return { text: status, tone: "err" as const };
      return { text: status };
    },
    priority: 4,
  },
  {
    header: "OUTCOME",
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
    header: "STATUS",
    get: (r) => {
      const status = str(r["status"]);
      if (status === "answered") return { text: status, tone: "ok" as const };
      if (status === "open") return { text: status, tone: "warn" as const };
      return { text: status };
    },
    priority: 1,
  },
  {
    header: "PROCESSOR",
    get: (r) => ({ text: str(r["processor"]) }),
    priority: 2,
  },
  {
    header: "QUESTION",
    get: (r) => ({ text: str(r["question"]) }),
    priority: 3,
  },
  {
    header: "SOURCE",
    get: (r) => {
      const refs = str(r["source_refs"]);
      const first = refs.split(";")[0]?.trim() ?? "-";
      return { text: first, tone: "muted" as const };
    },
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
    header: "CAPABILITY",
    get: (r) => ({ text: str(r["capability"]) }),
    priority: 1,
  },
  {
    header: "STATUS",
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
    header: "ATTEMPTS",
    get: (r) => ({
      text: String(typeof r["attempts"] === "number" ? r["attempts"] : "-"),
    }),
    priority: 3,
    align: "right" as const,
  },
  {
    header: "WHEN",
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
    header: "PROCESSOR",
    get: (r) => ({ text: str(r["processor"]) }),
    priority: 1,
  },
  {
    header: "PHASE",
    get: (r) => ({ text: str(r["phase"]) }),
    priority: 2,
  },
  {
    header: "FAILURES",
    get: (r) => ({
      text: String(typeof r["failures"] === "number" ? r["failures"] : "-"),
    }),
    priority: 3,
    align: "right" as const,
  },
  {
    header: "REASON",
    get: (r) => ({ text: str(r["reason"]) }),
    priority: 4,
  },
  {
    header: "WHEN",
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
    default:
      return "";
  }
}
