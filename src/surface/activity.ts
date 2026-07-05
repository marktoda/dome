// surface/activity: the collector behind `dome log` — the vault's activity
// view, read straight from git history joined with the run ledger.
//
// Per NO_ACCRETING_REGISTRIES, the activity log is not a file agents append
// to (log.md is frozen history); it is a render over the two surfaces that
// already record everything:
//
//   - git commits — every adopted change, human or engine. Engine commits
//     carry the Dome-Run / Dome-Extension trailers per
//     ENGINE_COMMITS_CARRY_DOME_TRAILERS, and their bodies carry the
//     PatchEffect's narrative reason (src/engine/core/apply-patch.ts).
//   - runs.db — the run ledger. The Dome-Run trailer equals `runs.id`, the
//     dual-surface join key (docs/wiki/specs/run-ledger.md).
//
// CLI-native posture (the `dome status` stance): no runtime lock, no
// Proposal, read-only. Git spawning stays inside src/git.ts
// (`logWithTrailers`); the ledger join goes through src/ledger's existing
// open/query surface. A vault whose runs.db does not exist yet (or fails to
// open) still renders — engine entries simply carry `run: null`.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { DOME_TRAILER_KEYS } from "../engine-commit";
import { logWithTrailers, type TrailerLogEntry } from "../git";
import { openLedgerDb, type LedgerDb } from "../ledger/db";
import { getRun, type RunId, type RunRow, type RunStatus } from "../ledger/runs";
import { resolveVaultPath } from "./resolve-vault";

/** Default window when the caller does not pass `limit`. */
const DEFAULT_ACTIVITY_LIMIT = 30;

// ----- Public types ---------------------------------------------------------

/** Ledger facts joined onto an engine entry via the Dome-Run trailer. */
export type ActivityRunInfo = {
  readonly status: RunStatus;
  readonly durationMs: number | null;
  readonly costUsd: number | null;
};

export type ActivityEntry = {
  readonly sha: string;
  /** ISO-8601 committer timestamp. */
  readonly when: string;
  /** "engine" iff the commit carries a non-empty Dome-Run trailer. */
  readonly author: "engine" | "human";
  readonly subject: string;
  /** Commit body with the Dome-* trailer block stripped; "" when none. */
  readonly body: string;
  readonly runId: string | null;
  readonly extensionId: string | null;
  /** Run-ledger join; null for human commits and unmatched/unjoinable runs. */
  readonly run: ActivityRunInfo | null;
};

export type BuildActivityLogOptions = {
  readonly vault?: string | undefined;
  /** Lower time bound; anything `git log --since` accepts. */
  readonly since?: string | undefined;
  /** Keep only engine entries from this processor/extension id. */
  readonly processor?: string | undefined;
  /** Case-insensitive substring filter over subject + body. */
  readonly grep?: string | undefined;
  /** Maximum entries returned (default 30). */
  readonly limit?: number | undefined;
};

// ----- buildActivityLog -----------------------------------------------------

/**
 * Collect the newest-first activity entries for a vault. Shared by the
 * `dome log` CLI verb; adapters (MCP/HTTP) can adopt it later — that is why
 * it lives in src/surface/ rather than under src/cli/.
 */
export async function buildActivityLog(
  options: BuildActivityLogOptions = {},
): Promise<ReadonlyArray<ActivityEntry>> {
  const vaultPath = resolveVaultPath(options.vault);
  const limit = options.limit ?? DEFAULT_ACTIVITY_LIMIT;
  const postFiltered =
    options.processor !== undefined || options.grep !== undefined;

  // `--limit` maps to git's `-n` only when no post-filter runs; a filtered
  // read walks the (since-bounded) history so filters see past the first
  // `limit` commits. Deliberate scope cut: no pagination beyond this.
  const commits = await logWithTrailers({
    path: vaultPath,
    ...(postFiltered ? {} : { limit }),
    ...(options.since !== undefined ? { since: options.since } : {}),
  });

  const ledger = await openLedgerReadOnly(vaultPath);
  try {
    const joined = commits.map((commit) => joinEntry(commit, ledger));
    const filtered = joined.filter((row) =>
      matchesProcessor(row, options.processor) && matchesGrep(row, options.grep)
    );
    return Object.freeze(filtered.slice(0, limit).map((row) => row.entry));
  } finally {
    ledger?.close();
  }
}

// ----- internals ------------------------------------------------------------

type JoinedRow = {
  readonly entry: ActivityEntry;
  /** Full ledger row kept for filtering; not exposed on the entry. */
  readonly runRow: RunRow | null;
};

/**
 * Open runs.db for the join, tolerating its absence. `openLedgerDb` would
 * create a fresh file (CLI-native commands must not scaffold state in a
 * vault they only read), so a missing file short-circuits to "no join";
 * an open refusal (schema mismatch) degrades the same way.
 */
async function openLedgerReadOnly(vaultPath: string): Promise<LedgerDb | null> {
  const path = join(vaultPath, ".dome", "state", "runs.db");
  if (!existsSync(path)) return null;
  const result = await openLedgerDb({ path });
  return result.ok ? result.value.db : null;
}

function joinEntry(commit: TrailerLogEntry, ledger: LedgerDb | null): JoinedRow {
  const runId = commit.domeRun;
  const runRow =
    runId === null || ledger === null ? null : getRun(ledger, runId as RunId);
  return Object.freeze({
    entry: Object.freeze({
      sha: commit.sha,
      when: commit.at,
      author: runId === null ? ("human" as const) : ("engine" as const),
      subject: commit.subject,
      body: stripDomeTrailers(commit.body),
      runId,
      extensionId: commit.domeExtension,
      run:
        runRow === null
          ? null
          : Object.freeze({
              status: runRow.status,
              durationMs: runRow.durationMs,
              costUsd: runRow.costUsd,
            }),
    }),
    runRow,
  });
}

/**
 * `--processor <id>` keeps engine entries only, matched against the joined
 * ledger row's processor id, the Dome-Extension trailer, or the commit
 * subject (engine(applyPatch) subjects carry the processor id verbatim).
 */
function matchesProcessor(row: JoinedRow, processor: string | undefined): boolean {
  if (processor === undefined) return true;
  if (row.entry.author !== "engine") return false;
  return (
    row.runRow?.processorId === processor ||
    row.entry.extensionId === processor ||
    row.entry.subject.includes(processor)
  );
}

function matchesGrep(row: JoinedRow, grep: string | undefined): boolean {
  if (grep === undefined) return true;
  const needle = grep.toLowerCase();
  return (
    row.entry.subject.toLowerCase().includes(needle) ||
    row.entry.body.toLowerCase().includes(needle)
  );
}

/**
 * Drop the Dome-* trailer lines from a commit body (`%b` includes them).
 * Targeted at exactly the trailer keys composeCommitMessage writes
 * (DOME_TRAILER_KEYS) — prose paragraphs that merely mention "Dome-Run:"
 * mid-line survive.
 *
 * Also drop the hosted assistant's attribution trailer (src/assistant/write.ts
 * AGENT_TRAILER_KEY = "Dome-Agent"). Kept as a literal — activity.ts is core
 * and must not import the assistant layer — and deliberately out of DOME_TRAILER_KEYS
 * so it never affects engine/human commit classification.
 */
const DOME_TRAILER_LINE = new RegExp(`^(?:${[...DOME_TRAILER_KEYS, "Dome-Agent"].join("|")}):`);

function stripDomeTrailers(body: string): string {
  return body
    .split("\n")
    .filter((line) => !DOME_TRAILER_LINE.test(line))
    .join("\n")
    .trim();
}
