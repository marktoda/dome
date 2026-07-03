// engine/host/run-ledger-retention-cache: the persisted last-pruned
// timestamp for the automatic run-ledger retention policy.
//
// `runCompilerHostTick` (src/engine/host/compiler-host.ts) applies retention
// once per host startup (cache absent) and at most once per 24h thereafter
// (cache stale). This is the same "small versioned JSON beside the
// operational SQLite files" pattern as
// `model-provider-probe-cache.ts` — the timestamp carries no audit value of
// its own (only "did we already run this recently"), so a missing or
// corrupt cache degrades to "never pruned" (run it now) rather than an
// error. Lives in `<vault>/.dome/state/`, the vault's gitignored derived
// operational-state directory — same class as quarantined.json and the
// serve heartbeat, safe to delete, rebuilt by the next tick.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

const CACHE_SCHEMA = "dome.ledger.retention-cache/v1";

export type RunLedgerRetentionCache = {
  readonly schema: typeof CACHE_SCHEMA;
  /** ISO timestamp of the last time the retention policy actually ran. */
  readonly lastPrunedAt: string;
};

const RetentionCacheSchema = z.object({
  schema: z.literal(CACHE_SCHEMA),
  lastPrunedAt: z.string(),
});

function cachePath(vaultPath: string): string {
  return join(vaultPath, ".dome", "state", "run-ledger-retention.json");
}

/**
 * Read the cached last-prune timestamp. Returns `null` when the cache is
 * absent, unreadable, or malformed.
 */
export function readRunLedgerRetentionCache(
  vaultPath: string,
): RunLedgerRetentionCache | null {
  const path = cachePath(vaultPath);
  if (!existsSync(path)) return null;
  try {
    const parsed = RetentionCacheSchema.safeParse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    if (!parsed.success) return null;
    return Object.freeze({
      schema: CACHE_SCHEMA,
      lastPrunedAt: parsed.data.lastPrunedAt,
    });
  } catch {
    return null;
  }
}

/**
 * Persist the prune timestamp. Best-effort: a write failure is non-fatal —
 * the retention run itself already happened, and the next tick simply
 * treats the cache as absent and tries again.
 */
export function writeRunLedgerRetentionCache(
  vaultPath: string,
  prunedAt: Date,
): void {
  try {
    mkdirSync(join(vaultPath, ".dome", "state"), { recursive: true });
    const payload: RunLedgerRetentionCache = {
      schema: CACHE_SCHEMA,
      lastPrunedAt: prunedAt.toISOString(),
    };
    writeFileSync(cachePath(vaultPath), `${JSON.stringify(payload, null, 2)}\n`);
  } catch {
    // Best-effort derived state; the retention run itself already happened.
  }
}

/** 24 hours, in milliseconds — the default re-run interval. */
export const RUN_LEDGER_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * True when retention should run now: never run before (cache absent or
 * corrupt), or the last run is at least `intervalMs` in the past. This is
 * "once at host startup [cache absent on the first tick] and at most once
 * per 24h thereafter."
 */
export function runLedgerRetentionDue(
  cache: RunLedgerRetentionCache | null,
  now: Date,
  intervalMs: number = RUN_LEDGER_RETENTION_INTERVAL_MS,
): boolean {
  if (cache === null) return true;
  const last = new Date(cache.lastPrunedAt).getTime();
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= intervalMs;
}
