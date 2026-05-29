// The adopted-ref substrate per ADOPTED_REF_IS_SEMANTIC_CURSOR. Three
// exported functions and one constant; the write side (`setAdoptedRef`) is
// internal to the `src/engine/adopt.ts` chokepoint and intentionally not
// re-exported from `src/index.ts`.
//
// See docs/wiki/specs/adoption.md §"The adopted ref" for the normative shape.

import { readRef, writeRef, isAncestor, currentBranch } from "./git";
import { err, ok, type Result, type ToolError } from "./types";

/**
 * Compose the ref name for a branch. One ref per source branch:
 * `refs/dome/adopted/main`, `refs/dome/adopted/feature-x`, etc.
 */
export function adoptedRefName(branch: string): string {
  return `refs/dome/adopted/${branch}`;
}

/**
 * The all-zeros SHA used as the `Dome-Base` trailer value when the adopted
 * ref is uninitialized at run start. Matches git's convention for "no
 * previous value" in reflog entries and ref-update hooks.
 */
export const ZERO_SHA = "0000000000000000000000000000000000000000";

/**
 * Read the current branch the vault is on. Returns null if HEAD is detached
 * (no associated branch). Re-exports `currentBranch` from `src/git.ts` under
 * the spec-named symbol for downstream consumers.
 */
export async function getCurrentBranch(vaultPath: string): Promise<string | null> {
  return currentBranch(vaultPath);
}

/**
 * Read `refs/dome/adopted/<branch>`. Returns null when the ref doesn't
 * exist (the "uninitialized" signal — the first `dome sync` initializes it).
 * If `branch` is omitted, the current branch is resolved first.
 */
export async function getAdoptedRef(vaultPath: string, branch?: string): Promise<string | null> {
  const b = branch ?? (await getCurrentBranch(vaultPath));
  if (b === null) return null;
  return readRef({ path: vaultPath, ref: adoptedRefName(b) });
}

/**
 * Advance the adopted ref to `sha`. Fast-forward-only by default: refuses
 * (`adopted-ref-divergence` ToolError) if the current ref value is not an
 * ancestor of `sha`. The `forceAdvance: true` opt-out accepts any new
 * commit for internal recovery call sites and tests. V1 deliberately does
 * not expose a user-facing force-advance command; divergent histories are
 * resolved by repairing git history before running `dome sync` again.
 *
 * INTERNAL — not re-exported from `src/index.ts`. The only legitimate
 * callers are `src/engine/adopt.ts`'s adoption loop (which runs the full adoption
 * state machine before advancing) and tests. Plugin and consumer-shell code
 * reaches the adopted ref via `getAdoptedRef` (read) and `sync` (advance as
 * part of the loop); there is no public write path.
 *
 * Initialization (current ref absent) is allowed unconditionally and is
 * treated as a fast-forward from the all-zeros base.
 */
export async function setAdoptedRef(
  vaultPath: string,
  branch: string,
  sha: string,
  opts?: { forceAdvance?: boolean },
): Promise<Result<{ from: string | null; to: string }, ToolError>> {
  const refName = adoptedRefName(branch);
  const current = await readRef({ path: vaultPath, ref: refName });

  if (current === null) {
    // Initialization — no ancestor to check.
    await writeRef({ path: vaultPath, ref: refName, value: sha });
    return ok({ from: null, to: sha });
  }

  if (current === sha) {
    // No-op advance — adopted already at the target.
    return ok({ from: current, to: sha });
  }

  if (opts?.forceAdvance !== true) {
    const ff = await isAncestor({ path: vaultPath, ancestor: current, descendant: sha });
    if (!ff) {
      return err({
        kind: "validation",
        message:
          `adopted ref ${refName} (${current.slice(0, 7)}) is not an ancestor of ${sha.slice(0, 7)}; ` +
          `repair git history so the adopted ref is in HEAD's ancestry, then run \`dome sync\` again. ` +
          `See docs/wiki/gotchas/adopted-ref-divergence.md.`,
      });
    }
  }

  await writeRef({ path: vaultPath, ref: refName, value: sha });
  return ok({ from: current, to: sha });
}
