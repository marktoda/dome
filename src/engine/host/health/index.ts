// engine/host/health: read-only probes for operational recovery surfaces.
//
// Doctor needs one boring substrate read boundary instead of each CLI surface
// hand-assembling outbox, ledger, and quarantine checks. This module performs
// no mutation. Repairs flow through the engine-asks model: findings become
// questions/answers and answer handlers apply the requested mutation.
//
// The module is a directory: types (the finding/report/inputs shapes), report
// (the fold), registry (the probe list + collectHealthReport), inputs (the
// runtime→context builder), and one file per probe concern. This barrel
// preserves the public import surface (`engine/host/health`).
export {
  DEFAULT_ORPHAN_RUN_THRESHOLD_MS,
  DEFAULT_PENDING_OUTBOX_THRESHOLD_MS,
  DEFAULT_RECURRING_OUTBOX_FAILURE_THRESHOLD_MS,
  DEFAULT_RECURRING_TIMEOUT_THRESHOLD,
  DEFAULT_RECURRING_TIMEOUT_WINDOW_MS,
  RECURRING_TIMEOUT_SCAN_LIMIT,
  type HealthFinding,
  type HealthSummary,
  type HealthReport,
  type HealthInputs,
  type ModelProviderProbeInput,
  type GrantEntryKind,
} from "./types";
export { collectHealthReport, collectOperationalSchemaReport } from "./registry";
export { healthInputsFromRuntime } from "./inputs";
export {
  capabilityGrantEntryFindings,
  capabilityGrantStarvationFindings,
} from "./capability";
export {
  dailyPathMismatchFindings,
  sourcesFetchScriptFindings,
  sourcesHandlerTimeoutFindings,
} from "./sources";
export {
  dailyEditionFindings,
  duplicateTaskAnchorCollisions,
  duplicateTaskAnchorFindings,
  markdownFilesForTaskAnchorScan,
  type TaskAnchorCollision,
  type TaskAnchorOccurrence,
  type TaskAnchorScanFile,
} from "./daily";
export {
  recurringOutboxFailureFindings,
  unreadableQuestionBacklogFindings,
} from "./outbox";
export {
  LEDGER_SIZE_WARNING_BYTES,
  ledgerOversizedFinding,
  recurringTimeoutFindings,
} from "./operational";
