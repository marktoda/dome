// dome.claims.stamp — stamp stable ^c-anchor identity onto claim lines.
//
// Garden-phase, deterministic, patch.auto — garden, not adoption, for the
// same reason as dome.daily.stamp-block-id: a capability-denied auto-patch
// in adoption becomes a severity:"block" diagnostic that refuses to advance
// the adopted ref; in garden a narrow grant simply skips the stamp. The
// transformation is idempotent, so the garden cascade converges at depth 1.

import {
  patchEffect,
  type Effect,
  type FileChangeInput,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

import { stampClaimAnchors } from "./claims-shared";

const stampAnchor = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const changes: FileChangeInput[] = [];
    const sourceRefs = [];
    for (const path of ctx.changedPaths.filter((p) => p.endsWith(".md"))) {
      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;
      const stamped = stampClaimAnchors({ path, content });
      if (stamped === null) continue;
      changes.push({ kind: "write", path, content: stamped });
      sourceRefs.push(ctx.sourceRef(path, { startLine: 1, endLine: 1 }));
    }
    if (changes.length === 0) return [];
    return [
      patchEffect({
        mode: "auto",
        changes,
        reason: "stamp stable ^c-anchor identity onto claim lines",
        sourceRefs,
      }),
    ];
  },
});

export default stampAnchor;
