// engine/core/adoption-status: the read-only adoption cursor snapshot.
//
// One cheap-git-reads answer to "where is the compiler relative to my
// branch?" — the shared substance behind `dome status`'s git section and the
// public `vault.getAdoptionStatus()` surface ([[wiki/specs/sdk-surface]]
// §"Engine control"). No runtime, no SQLite: branch + HEAD + adopted ref +
// ancestry walks only, so any surface can poll it without opening databases.

import { getAdoptedRef, getCurrentBranch } from "../../adopted-ref";
import { countCommitsSince, currentSha, isAncestor } from "../../git";
import type { CommitOid } from "../../core/source-ref";

/**
 * Resolve the latest adopted commit: prefer the optional live cursor callback
 * (`currentAdopted`) when present, else fall back to the `adopted` ref passed
 * at call construction. Shared by every garden/operational site that re-reads
 * the adoption cursor inside a loop or after a sub-proposal spawn.
 */
export function resolveCurrentAdopted(
  currentAdopted: (() => CommitOid) | undefined,
  adopted: CommitOid,
): CommitOid {
  return currentAdopted?.() ?? adopted;
}

export type AdoptionStatus = {
  /** Current branch name; null on detached HEAD. */
  readonly branch: string | null;
  /** Branch tip commit; null when the repo has no commits. */
  readonly head: string | null;
  /** `refs/dome/adopted/<branch>`; null until the first sync initializes it. */
  readonly adopted: string | null;
  /** True when HEAD differs from the adopted ref (including uninitialized). */
  readonly syncNeeded: boolean;
  /**
   * Commits on `adopted..head`. Null when either cursor is missing (no
   * commits yet, detached HEAD, or uninitialized adopted ref).
   */
  readonly pendingCommits: number | null;
  /**
   * True when the adopted ref is initialized but no longer an ancestor of
   * HEAD (history rewrite). See [[wiki/gotchas/adopted-ref-divergence]].
   */
  readonly diverged: boolean;
};

/** Collect the adoption cursor snapshot for a vault via cheap git reads. */
export async function collectAdoptionStatus(
  vaultPath: string,
): Promise<AdoptionStatus> {
  const branch = await getCurrentBranch(vaultPath);
  const head = await currentSha(vaultPath);
  const adopted =
    branch === null ? null : await getAdoptedRef(vaultPath, branch);

  return Object.freeze({
    branch,
    head,
    adopted,
    syncNeeded: branch !== null && head !== null && head !== adopted,
    pendingCommits: await countPendingCommits({ vaultPath, head, adopted }),
    diverged: await isAdoptedDiverged({ vaultPath, head, adopted }),
  });
}

/** Commits on `adopted..head`; null when either cursor is missing. */
export async function countPendingCommits(opts: {
  readonly vaultPath: string;
  readonly head: string | null;
  readonly adopted: string | null;
}): Promise<number | null> {
  if (opts.head === null) return null;
  if (opts.adopted === null) return null;
  return countCommitsSince({
    path: opts.vaultPath,
    ancestor: opts.adopted,
    descendant: opts.head,
  });
}

/** True when adopted is initialized but not an ancestor of HEAD. */
export async function isAdoptedDiverged(opts: {
  readonly vaultPath: string;
  readonly head: string | null;
  readonly adopted: string | null;
}): Promise<boolean> {
  if (opts.head === null || opts.adopted === null) return false;
  if (opts.head === opts.adopted) return false;
  return !(await isAncestor({
    path: opts.vaultPath,
    ancestor: opts.adopted,
    descendant: opts.head,
  }));
}
