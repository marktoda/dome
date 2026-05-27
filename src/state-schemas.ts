// Zod schemas for the two persistent state files under `.dome/state/`. State
// files are derived and rebuildable from markdown (per
// MARKDOWN_IS_SOURCE_OF_TRUTH), so the validation-failure path returns the
// empty-state fallback rather than crashing. Closes the third scar site
// named in docs/wiki/gotchas/boundary-validation-via-zod.md.
//
// Both schemas are colocated here (rather than next to their loaders) because
// the state files are read by multiple call sites — reconcile and the CLI
// (`dome doctor --reset-quarantined-hooks`) both consume `quarantined.json`,
// and a shared schema makes the contract explicit.

import { z } from "zod";

/**
 * One entry in `.dome/state/scheduled.json`. Mirrors the in-file
 * `ScheduledEntry` interface in `src/reconcile.ts` — `interval` names a
 * canonical label (`minutely` / `hourly` / `daily` / `weekly`) and
 * `last_fire` is the ISO 8601 timestamp of the most recent firing (absent
 * until the first reconcile fires).
 */
export const ScheduledEntrySchema = z.object({
  interval: z.string(),
  last_fire: z.string().optional(),
});

/**
 * The full `.dome/state/scheduled.json` shape: a record keyed by handler id
 * mapping to its scheduled entry. Phase 3 of `reconcile` re-derives missing
 * entries from registered handlers, so a corrupted file falls back to `{}`.
 */
export const ScheduledStateSchema = z.record(z.string(), ScheduledEntrySchema);

export type ScheduledEntry = z.infer<typeof ScheduledEntrySchema>;
export type ScheduledState = z.infer<typeof ScheduledStateSchema>;

/**
 * `.dome/state/quarantined.json` shape: a JSON array of handler ids that
 * the dispatcher should refuse to invoke. Missing or corrupted file falls
 * back to `[]` — the next failure quarantines the handler again.
 */
export const QuarantineSchema = z.array(z.string());
export type Quarantine = z.infer<typeof QuarantineSchema>;
