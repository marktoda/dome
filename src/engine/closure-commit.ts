// closure-commit: the engine's named entry point for the adoption loop's
// closure step. When the fixed-point adoption loop has accumulated engine-
// driven patches against the candidate tree, the close step lands them as a
// single commit carrying the four Dome-* trailers with
// `Dome-Extension: engine`.
//
// See docs/wiki/specs/adoption.md §"Close" + §"Engine commit trailers" for
// the normative contract, and
// docs/wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS.md for the
// structural fence this function helps uphold (every engine commit carries
// the four trailers; `commitWorkflow` is the single chokepoint).
//
// This file is a pure dispatcher. It owns no decision about *when* to commit
// (the adoption loop in `adopt.ts` decides that based on whether the
// candidate diverged from `P.head` during the loop); it owns only *how*: it
// constructs the engine-extension RunContext and hands it to `commitWorkflow`
// with the touched paths.
//
// `closure-commit` carries more imports than its engine-layer siblings
// (compile-range, capability-broker, apply-effect) by design — it is the
// engine layer's git boundary. The other engine files are pure
// types-and-routing; this one calls into `commitWorkflow`, the engine-commit
// chokepoint.
//
// House-style notes (matches src/engine/compile-range.ts,
// src/engine/capability-broker.ts, src/engine/apply-effect.ts):
//   - Banner cites the normative spec section + the structural invariant.
//   - Imports tight: pure types from `../core/source-ref` (CommitOid),
//     `../run-context` (makeRunContext + ENGINE_EXTENSION_ID), `../vault`
//     (Vault type only), and `../workflow-commit` (commitWorkflow — the
//     engine-commit chokepoint per ENGINE_COMMITS_CARRY_DOME_TRAILERS).
//   - JSDoc on the public function only; the file banner carries the prose.

import { commitOid, type CommitOid } from "../core/source-ref";
import { ENGINE_EXTENSION_ID, makeRunContext } from "../run-context";
import type { Vault } from "../vault";
import { commitWorkflow } from "../workflow-commit";

// ----- makeClosureCommit ----------------------------------------------------

/**
 * Land the adoption loop's accumulated engine-driven patches as a single
 * closure commit. The four Dome-* trailers are appended by `commitWorkflow`;
 * `Dome-Extension` is set to the well-known `engine` value per
 * adoption.md §"Engine commit trailers".
 *
 * Returns `null` when:
 *   - `touchedPaths` is empty (the loop reached fixed point without
 *     engine-driven writes, so no closure commit is needed); or
 *   - `vault.config.git.auto_commit_workflows` is `false` (the vault has
 *     disabled engine-driven commits; `commitWorkflow` returns `""` in this
 *     case and callers handle the skip uniformly).
 *
 * Otherwise returns the new commit OID.
 *
 * @param opts.vault         The vault whose repo receives the commit.
 * @param opts.base          `refs/dome/adopted/<branch>` SHA at loop start;
 *                           becomes the `Dome-Base` trailer. Use `ZERO_SHA`
 *                           when the adopted ref was uninitialized.
 * @param opts.sourceHead    HEAD SHA at loop start (before any engine
 *                           commits); becomes the `Dome-Source-Head` trailer.
 * @param opts.touchedPaths  The paths the engine wrote during the loop. An
 *                           empty array short-circuits to `null`.
 * @param opts.proposalId    The originating Proposal's id; the commit subject
 *                           is `adopt: proposal <first-12-chars>`.
 */
export async function makeClosureCommit(opts: {
  readonly vault: Vault;
  readonly base: CommitOid;
  readonly sourceHead: CommitOid;
  readonly touchedPaths: ReadonlyArray<string>;
  readonly proposalId: string;
}): Promise<CommitOid | null> {
  // Empty touched paths → fixed point reached without engine writes. No
  // closure commit is meaningful; the caller advances the adopted ref
  // directly to the proposal head.
  if (opts.touchedPaths.length === 0) {
    return null;
  }

  // Auto-commit disabled → caller's "skip commit" path. `commitWorkflow`
  // returns "" in this case; we surface that as `null` uniformly with the
  // empty-paths case so callers branch on a single sentinel.
  if (!opts.vault.config.git.auto_commit_workflows) {
    return null;
  }

  const runContext = makeRunContext({
    extensionId: ENGINE_EXTENSION_ID,
    base: opts.base,
    sourceHead: opts.sourceHead,
  });

  const sha = await commitWorkflow(opts.vault, {
    verb: "adopt",
    subject: `proposal ${opts.proposalId.slice(0, 12)}`,
    touchedPaths: opts.touchedPaths,
    runContext,
  });

  // Defense in depth: `commitWorkflow` returns "" when auto-commit is off,
  // which we already short-circuited above. If a future change to that
  // function ever returns "" for another reason, surface it as `null` here
  // rather than propagating an empty string upstream.
  if (sha === "") {
    return null;
  }

  return commitOid(sha);
}
