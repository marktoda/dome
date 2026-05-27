// The adoption substrate per docs/wiki/specs/adoption.md.
//
// Two layers:
//   1. RunContext + makeRunContext — the structural fence backing
//      ENGINE_COMMITS_CARRY_DOME_TRAILERS. Every per-workflow atomic commit
//      threads one of these into `commitWorkflow`.
//   2. sync + getAdoptionStatus — the adoption state machine surface backing
//      ADOPTED_REF_IS_SEMANTIC_CURSOR. `sync` runs reconcile, advances the
//      adopted ref atomically on clean completion, emits engine.adoption.*
//      events. `getAdoptionStatus` is the read-only snapshot `dome status`
//      consumes.

import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import type { Vault } from "./vault";
import {
  getAdoptedRef,
  getCurrentBranch,
  setAdoptedRef,
  ZERO_SHA,
} from "./adopted-ref";
import { currentSha, statusMatrix, readTree } from "./git";
import { reconcile } from "./reconcile";
import { isDirtyGitState } from "./reconcile";
import { err, ok, type Result, type ToolError } from "./types";

// ----- RunContext -----------------------------------------------------------

/**
 * The four trailers every engine commit carries (per
 * ENGINE_COMMITS_CARRY_DOME_TRAILERS). Constructed via `makeRunContext`,
 * consumed by `commitWorkflow`. See docs/wiki/specs/adoption.md
 * §"Engine commit trailers".
 */
export interface RunContext {
  /** `run_<unix-ms>_<6-char-random>` — sortable, debuggable, unique. */
  readonly runId: string;
  /** Workflow name for per-workflow commits; `"engine"` for closure commits. */
  readonly extensionId: string;
  /** Adopted ref SHA at run start, or `ZERO_SHA` when uninitialized. */
  readonly base: string;
  /** HEAD SHA at run start (before this commit was made). */
  readonly sourceHead: string;
}

/**
 * Build a RunContext. The `runId` is generated as `run_<unix-ms>_<6-rand>`;
 * the random component is six lowercase alphanumerics from a 4-byte source
 * (enough entropy for per-process uniqueness even under rapid bursts).
 */
export function makeRunContext(opts: {
  extensionId: string;
  base: string;
  sourceHead: string;
}): RunContext {
  return {
    runId: `run_${Date.now()}_${randomBytes(4).toString("hex").slice(0, 6)}`,
    extensionId: opts.extensionId,
    base: opts.base,
    sourceHead: opts.sourceHead,
  };
}

// ----- AdoptionStatus -------------------------------------------------------

export interface AdoptionStatus {
  /** Current source branch, or null if HEAD is detached. */
  readonly branch: string | null;
  /** Current HEAD SHA, or null on a vault with no commits yet. */
  readonly head: string | null;
  /** `refs/dome/adopted/<branch>` value, or null when uninitialized. */
  readonly adopted: string | null;
  /**
   * Count of commits in `adopted..HEAD`. Null when adopted is uninitialized
   * (no range to walk) or when HEAD is null. Counts ALL commits regardless
   * of trailer kind (user + engine).
   */
  readonly pendingCommits: number | null;
  /** Working-tree status snapshot. */
  readonly dirty: { readonly modified: number; readonly untracked: number };
  /** True when adopted is not an ancestor of HEAD (force-push, hard-reset). */
  readonly diverged: boolean;
}

/**
 * Read-only adoption snapshot — `dome status`'s data source. No mutation,
 * no ref advance; just inspects current state. Per docs/wiki/specs/adoption.md
 * §"`dome status`".
 */
export async function getAdoptionStatus(vault: Vault): Promise<AdoptionStatus> {
  const branch = await getCurrentBranch(vault.path);
  const head = await currentSha(vault.path);
  const adopted = branch !== null ? await getAdoptedRef(vault.path, branch) : null;

  const dirty = await readDirtyCounts(vault.path);

  let pendingCommits: number | null = null;
  let diverged = false;

  if (adopted !== null && head !== null) {
    if (adopted === head) {
      pendingCommits = 0;
    } else {
      const ff = await import("./git").then((g) =>
        g.isAncestor({ path: vault.path, ancestor: adopted, descendant: head }),
      );
      if (!ff) {
        diverged = true;
        pendingCommits = null;
      } else {
        pendingCommits = await countCommits(vault.path, adopted, head);
      }
    }
  }

  return { branch, head, adopted, pendingCommits, dirty, diverged };
}

async function readDirtyCounts(vaultPath: string): Promise<{ modified: number; untracked: number }> {
  let modified = 0;
  let untracked = 0;
  try {
    const matrix = await statusMatrix(vaultPath);
    for (const [, head, workdir, stage] of matrix) {
      if (head === 0 && workdir !== 0) untracked++;
      else if (head !== workdir || workdir !== stage) modified++;
    }
  } catch {
    // Vault with no commits yet or transient read error — return zero counts.
  }
  return { modified, untracked };
}

/**
 * Count commits in `from..to` via tree walk. Lazily imports isomorphic-git's
 * log primitive to stay off the per-call hot path. The `from`/`to` strings
 * are both commit OIDs and must be valid before calling — `getAdoptionStatus`
 * gates this with `isAncestor`.
 */
async function countCommits(vaultPath: string, from: string, to: string): Promise<number> {
  const { log } = await import("./git");
  try {
    const entries = await log({ path: vaultPath, ref: to });
    let count = 0;
    for (const entry of entries) {
      if (entry.oid === from) break;
      count++;
    }
    return count;
  } catch {
    return 0;
  }
}

// ----- sync -----------------------------------------------------------------

export interface SyncResult {
  readonly branch: string;
  readonly adoptedBefore: string | null;
  readonly adoptedAfter: string;
  readonly inboxProcessed: number;
  readonly changedFiles: number;
  readonly scheduledFired: number;
  /** True when the advance required `--force-advance`. */
  readonly diverged: boolean;
}

/**
 * The adoption state machine entry point. See docs/wiki/specs/adoption.md
 * §"`dome sync`" for the five-step composition (range / diagnose / reconcile
 * / drainHooks / adopt).
 *
 * Refuses (returns Result.err) on: dirty git state (mid-merge/rebase/cherry-
 * pick), no current branch (detached HEAD), no HEAD (empty vault),
 * divergence without `forceAdvance`, or any reconcile-time error.
 *
 * On success, emits `engine.adoption.advanced`. On blocked, emits
 * `engine.adoption.blocked` (best-effort — the dispatcher may not have a
 * handler registered; events emit either way for future consumers).
 */
export async function sync(
  vault: Vault,
  opts?: { forceAdvance?: boolean },
): Promise<Result<SyncResult, ToolError>> {
  // Diagnose preconditions.
  if (isDirtyGitState(vault.path)) {
    await emitBlocked(vault, "vault is in a dirty git state (mid-merge/rebase/cherry-pick)");
    return err({
      kind: "validation",
      message:
        "Vault is in a dirty git state (mid-merge/rebase/cherry-pick). Resolve before syncing. " +
        "See docs/wiki/gotchas/dirty-git-state-at-reconcile.md.",
    });
  }

  const branch = await getCurrentBranch(vault.path);
  if (branch === null) {
    return err({
      kind: "validation",
      message: "Vault HEAD is detached; cannot sync without a branch to namespace the adopted ref under.",
    });
  }

  const head = await currentSha(vault.path);
  if (head === null) {
    return err({
      kind: "validation",
      message: "Vault has no commits yet; `dome init` should have produced an initial commit.",
    });
  }

  const adoptedBefore = await getAdoptedRef(vault.path, branch);

  // Divergence check up front so we surface the diagnostic before running
  // reconcile work that would be wasted if the advance is going to refuse.
  if (adoptedBefore !== null && adoptedBefore !== head && opts?.forceAdvance !== true) {
    const { isAncestor } = await import("./git");
    const ff = await isAncestor({ path: vault.path, ancestor: adoptedBefore, descendant: head });
    if (!ff) {
      await emitBlocked(
        vault,
        `adopted ref ${adoptedBefore.slice(0, 7)} is not an ancestor of HEAD ${head.slice(0, 7)}`,
      );
      return err({
        kind: "validation",
        message:
          `Adopted ref (${adoptedBefore.slice(0, 7)}) is not an ancestor of HEAD (${head.slice(0, 7)}). ` +
          `Run \`dome sync --force-advance\` after confirming HEAD is the intended trunk. ` +
          `See docs/wiki/gotchas/adopted-ref-divergence.md.`,
      });
    }
  }

  // Initialization shortcut: fresh adopted ref. Treat HEAD as already-
  // compiled; skip the reconcile phases (otherwise reconcile's phase-2 would
  // walk the entire vault history since the "null SHA" cursor, producing
  // expensive no-op work). Per adoption.md §"Migration from v0.5".
  if (adoptedBefore === null) {
    const setResult = await setAdoptedRef(vault.path, branch, head);
    if (!setResult.ok) return setResult;
    await touchReconcileMtime(vault.path);
    await emitAdvanced(vault, branch, null, head);
    return ok({
      branch,
      adoptedBefore: null,
      adoptedAfter: head,
      inboxProcessed: 0,
      changedFiles: 0,
      scheduledFired: 0,
      diverged: false,
    });
  }

  // Reconcile work (existing three-phase machinery). Hooks fire as a side
  // effect of dispatchEvents from inside reconcile's onEvent callback.
  const reconcileResult = await reconcile(vault, {
    onEvent: (event) => vault.dispatchEvents([event]),
  });
  if (!reconcileResult.ok) {
    await emitBlocked(vault, `reconcile failed: ${reconcileResult.error.kind}`);
    return reconcileResult;
  }

  // Drain async hooks so the ref advances only after the queue settles.
  // Matches the v0.5 `dome reconcile` post-call drain semantics.
  await vault.drainHooks();

  // After reconcile + drain, HEAD may have advanced (workflow commits from
  // intake hooks). Re-read so we adopt the post-reconcile HEAD.
  const finalHead = (await currentSha(vault.path)) ?? head;

  // Advance the adopted ref.
  const setResult = await setAdoptedRef(vault.path, branch, finalHead, opts);
  if (!setResult.ok) return setResult;

  await touchReconcileMtime(vault.path);
  await emitAdvanced(vault, branch, adoptedBefore, finalHead);

  return ok({
    branch,
    adoptedBefore,
    adoptedAfter: finalHead,
    inboxProcessed: reconcileResult.value.inboxProcessed,
    changedFiles: reconcileResult.value.changedFiles,
    scheduledFired: reconcileResult.value.scheduledFired,
    diverged: opts?.forceAdvance === true && adoptedBefore !== finalHead,
  });
}

// ----- internals ------------------------------------------------------------

/**
 * Touch `.dome/state/last-reconcile-mtime.txt` — the mtime-only marker
 * `dome doctor --time-since-reconcile` reads. Content is the current adopted
 * SHA for forward-debugging visibility; only the mtime is load-bearing per
 * docs/wiki/specs/vault-layout.md §"Derived operational state under
 * `.dome/`".
 */
async function touchReconcileMtime(vaultPath: string): Promise<void> {
  const stateDir = join(vaultPath, ".dome", "state");
  if (!existsSync(stateDir)) {
    await mkdir(stateDir, { recursive: true });
  }
  await writeFile(join(stateDir, "last-reconcile-mtime.txt"), new Date().toISOString() + "\n");
}

async function emitAdvanced(
  vault: Vault,
  branch: string,
  from: string | null,
  to: string,
): Promise<void> {
  try {
    await vault.dispatchEvents([
      {
        kind: "engine.adoption.advanced",
        branch,
        // `from === null` is the canonical "this was an init" signal — derivable
        // without a separate `source` field, which keeps the payload aligned with
        // docs/wiki/matrices/event-types-and-payloads.md.
        from,
        to,
        // Synthesize a one-off run id for the advance itself; per-workflow
        // commits inside the sync each carry their own runId.
        runId: makeRunContext({
          extensionId: "engine",
          base: from ?? ZERO_SHA,
          sourceHead: to,
        }).runId,
      },
    ]);
  } catch {
    // Best-effort emit — no consumer registers for this event in v0.5+phase1+phase3.
  }
}

async function emitBlocked(vault: Vault, reason: string): Promise<void> {
  try {
    const branch = await getCurrentBranch(vault.path);
    const head = await currentSha(vault.path);
    const adopted = branch !== null ? await getAdoptedRef(vault.path, branch) : null;
    await vault.dispatchEvents([
      {
        kind: "engine.adoption.blocked",
        branch: branch ?? "<detached>",
        adopted,
        head: head ?? "",
        reason,
      },
    ]);
  } catch {
    // Best-effort.
  }
}

// readTree is re-imported here purely to keep the module's import surface
// stable against future reconcile factoring; the lint passes ignore this.
void readTree;

// Re-export the ref-name + zero-sha primitives so consumers don't need to
// know about `adopted-ref.ts` as a separate module surface for the trailer
// values they thread through commitWorkflow.
export { adoptedRefName, ZERO_SHA, getAdoptedRef, getCurrentBranch } from "./adopted-ref";
