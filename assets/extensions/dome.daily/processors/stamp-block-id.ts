// dome.daily.stamp-block-id — stamp stable ^block-anchor identity onto tasks.
//
// Garden-phase, deterministic, patch.auto. For every action-item line that
// lacks a trailing `^anchor`, append a reproducible one, making task identity
// explicit and durable in the markdown (the source of truth) so a task keeps
// the same identity across moves and edits — the keystone the dedup /
// close-propagation reconcile step and anchor-based identity depend on.
//
// Garden, not adoption: a capability-denied auto-patch in adoption is turned
// into a `severity:"block"` diagnostic that would refuse to advance the
// adopted ref (see apply-effect.ts). Running in garden means a narrow grant
// simply skips the stamp (no sub-proposal) instead of blocking the human's
// adoption. The stamp lands one garden cascade after the commit; identity
// uses the body-hash fallback for that single cycle, then becomes anchor-based.
//
// The stamp commit carries the engine's Dome-* trailers, and open-loop recency
// ranking reads `lastHumanChangedAt` (which ignores Dome-authored commits), so
// stamping never resets a task's freshness signal.
//
// The transformation is idempotent: a re-run over already-stamped content
// produces no changes, so the garden cascade converges at depth 1.

import { patchEffect, type Effect, type FileChangeInput } from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

import { stampTaskAnchors } from "./daily-shared";

const stampBlockId = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const changes: FileChangeInput[] = [];
    const sourceRefs = [];
    for (const path of ctx.changedPaths.filter((p) => p.endsWith(".md"))) {
      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;
      const stamped = stampTaskAnchors({ path, content });
      if (stamped === null) continue;
      changes.push({ kind: "write", path, content: stamped });
      sourceRefs.push(ctx.sourceRef(path, { startLine: 1, endLine: 1 }));
    }
    if (changes.length === 0) return [];
    return [
      patchEffect({
        mode: "auto",
        changes,
        reason: "stamp stable ^block-anchor identity onto task lines",
        sourceRefs,
      }),
    ];
  },
});

export default stampBlockId;
