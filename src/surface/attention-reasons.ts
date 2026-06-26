// surface/attention-reasons: the closed `dome status` attention vocabulary.
//
// `dome status` raises a stable set of attention reason codes. They are emitted
// in one place (`statusAttention` in surface/status.ts), bucketed for next-step
// routing (`nextActionsForStatus` in surface/next-actions.ts), and painted as
// signal rows (`attentionSignalEntries` in cli/commands/status.ts). Before this
// module they were bare string literals at all three sites against an untyped
// `ReadonlyArray<string>`, so the emitter and its consumers could silently
// drift — the painter's catch-all branch existed precisely because the compiler
// could not prove coverage.
//
// `StatusReason` closes that vocabulary. The snapshot still serializes
// `attention` as a JSON string array (every member is a string literal, so the
// wire shape is byte-identical and the documented `dome status --json` contract
// is unchanged); the union just lets the compiler tie emitter and consumers
// together. Adding or removing a code is now a compile error at every consumer
// that must react — the CLI's `SLOT_BY_REASON` is a `Record<StatusReason, …>`,
// so a new code with no display slot fails the build by construction.
//
// The sync vocabulary (`syncAttention` in cli/commands/sync.ts) is deliberately
// NOT closed here: the sync error path emits a dynamic `error.replace(/-/g,"_")`
// code that cannot be enumerated, and the sync footer joins codes without any
// per-code branch, so there is no exhaustive consumer to protect.

/**
 * The closed set of `dome status` attention reason codes, in emission order
 * (see `statusAttention`). Serialized as plain strings in the status snapshot.
 */
export type StatusReason =
  | "adopted_ref_diverged"
  | "sync_needed"
  | "projection_stale"
  | "dirty_modified"
  | "dirty_untracked"
  | "pending_runs"
  | "failed_runs"
  | "serve_stale"
  | "service_not_loaded"
  | "model_provider_unreachable"
  | "diagnostics"
  | "questions"
  | "outbox_pending"
  | "outbox_failed"
  | "quarantined"
  | "capture_loop_inactive";
