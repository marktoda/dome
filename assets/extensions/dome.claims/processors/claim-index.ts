// dome.claims.index — project claim lines into facts.
//
// Adoption-phase, deterministic, rebuildable: one `dome.claims.claim` fact
// per claim line, object = canonical JSON {key, value, asOf?}, sourceRef
// carrying the line range and (when stamped) the ^c-anchor as stableId.
// The fact value never includes the anchor — the anchor is identity, and it
// already rides the sourceRef; duplicating it into the value would make the
// first post-stamp adoption a spurious value change.

import { factEffect, type Effect } from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

import { claimsFromMarkdown } from "./claims-shared";
import { CLAIM_PREDICATE, claimFactValue } from "./claim-fact";

const claimIndex = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const effects: Effect[] = [];
    for (const path of ctx.changedPaths.filter((p) => p.endsWith(".md"))) {
      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;
      for (const claim of claimsFromMarkdown(content)) {
        const range = { startLine: claim.line, endLine: claim.line };
        const ref =
          claim.anchor !== null
            ? ctx.sourceRef(path, range, claim.anchor)
            : ctx.sourceRef(path, range);
        effects.push(
          factEffect({
            subject: { kind: "page", path },
            predicate: CLAIM_PREDICATE,
            object: { kind: "string", value: claimFactValue(claim) },
            assertion: "extracted",
            sourceRefs: [ref],
          }),
        );
      }
    }
    return Object.freeze(effects);
  },
});

export default claimIndex;
