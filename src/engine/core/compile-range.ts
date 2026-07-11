// compileRange: the engine's primitive for "what changed in this Proposal."
// Diffs two commit trees and synthesizes the per-path Signal events that
// adoption-phase processors subscribe to.
//
// See docs/wiki/specs/adoption.md §"Compile range" for the normative
// contract (the CompileRangeResult shape, signal synthesis rules) and
// docs/wiki/specs/processors.md §"Triggers and signals" for the closed
// Signal literal-union.
//
// v1 Phase 2 emits only the four signals derivable purely from a git
// tree diff: `file.created`, `file.modified`, `file.deleted`, and
// `document.changed` (the markdown overlay). The richer taxonomy
// (`frontmatter.changed`, `region.changed`, `link.added`,
// `link.removed`) requires parsing markdown body content and per-blob
// diffs; those are produced by adoption-phase processors in `dome.markdown`
// downstream of compileRange, not by this primitive.
//
// House-style notes (matches src/core/source-ref.ts, src/core/effect.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - Optional fields use `field?: T` (not `T | undefined`) for
//     `exactOptionalPropertyTypes` cleanliness.
//   - Object.freeze chosen over `as const` so misbehaving consumers fail
//     loudly at runtime rather than silently corrupting the result.
//   - Imports limited to the engine layer's boundary set: `node:path`
//     (because this is where git OIDs meet path strings), the single
//     isomorphic-git boundary `../git`, and pure types from `../core/`.

import type { CommitOid } from "../../core/source-ref";
import {
  revisionSourceFor,
  type CompileRangeResult,
  type SignalEvent,
} from "../../revisions/revision-source";

// ----- SignalEvent ----------------------------------------------------------

/**
 * A per-path Signal event. The engine emits these from `compileRange` and
 * routes them to subscribing processors (per processors.md §"Triggers and
 * signals"). The `path` is vault-relative, POSIX-separated.
 */
export type { SignalEvent };

// ----- CompileRangeResult ---------------------------------------------------

/**
 * The result of diffing `base..head`. `changedPaths` is the union of
 * `addedPaths`, `modifiedPaths`, and `deletedPaths` (sorted: added,
 * modified, deleted). `signals` carries the per-path Signal events the
 * engine routes to processors.
 *
 * All arrays and the outer object are frozen — the result is shared across
 * every processor whose triggers match, so accidental mutation would corrupt
 * subsequent processors' inputs.
 */
export type { CompileRangeResult };

// ----- compileRange ---------------------------------------------------------

/**
 * Diff `base..head` in the git repo at `vaultPath` and synthesize the
 * Signal events for adoption-phase routing.
 *
 * - `addedPaths`    — present in head's tree but not in base's tree.
 * - `modifiedPaths` — in both trees with different blob OIDs.
 * - `deletedPaths`  — present in base's tree but not head's tree.
 * - `changedPaths`  — sorted concatenation: added, then modified, then deleted.
 * - `signals`       — per-path Signal events:
 *     - `file.created` for each added path; `document.changed` also for `.md`.
 *     - `file.modified` for each modified path; `document.changed` also for `.md`.
 *     - `file.deleted` for each deleted path.
 *
 * Determinism: per-bucket paths are sorted (lexicographic, ascending) before
 * signal synthesis, so signal order is a deterministic function of `(base,
 * head)`. For a single path, `file.*` precedes the corresponding
 * `document.changed`.
 */
export async function compileRange(opts: {
  vaultPath: string;
  base: CommitOid;
  head: CommitOid;
}): Promise<CompileRangeResult> {
  return revisionSourceFor(opts.vaultPath).diff(opts.base, opts.head);
}
