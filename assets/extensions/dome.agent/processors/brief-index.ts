// dome.agent.brief-index — adoption-phase extractor that reads the
// dome.agent.brief:today block from an adopted daily note and emits a
// dome.agent.brief fact (plain text + sourceRef).
//
// The today view (CB-T8) reads this fact to populate its brief field without
// re-parsing markdown. The cross-bundle contract is a FACT, not a markdown
// string consumed by another extension.
//
// Pattern mirrors dome.daily/processors/task-index.ts.

import { factEffect, type Effect } from "../../../../src/core/effect";
import { stripWikilinks } from "../../../../src/core/wikilink";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import { extractGeneratedBlockBody } from "../../../../src/core/generated-block";
import { TODAY_BLOCK } from "../lib/brief-shared";

/** The predicate under which the brief text is published to the graph. */
export const BRIEF_FACT_PREDICATE = "dome.agent.brief";

/**
 * A stable id for the brief-index source ref anchored to `path`. Uses the
 * owner:block pair as a suffix so the id survives block-body edits but
 * changes if the owner or block slug changes.
 */
function briefStableId(path: string): string {
  return `brief-index:${path}:${TODAY_BLOCK.owner}:${TODAY_BLOCK.block}`;
}


const briefIndex = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const effects: Effect[] = [];
    for (const path of ctx.changedPaths) {
      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;

      const body = extractGeneratedBlockBody(
        content,
        TODAY_BLOCK.owner,
        TODAY_BLOCK.block,
      );
      if (body === null) continue;

      const value = stripWikilinks(body);
      if (value.length === 0) continue;

      const ref = ctx.sourceRef(path, undefined, briefStableId(path));
      effects.push(
        factEffect({
          subject: { kind: "page", path },
          predicate: BRIEF_FACT_PREDICATE,
          object: { kind: "string", value },
          assertion: "extracted",
          sourceRefs: [ref],
        }),
      );
    }
    return Object.freeze(effects);
  },
});

export default briefIndex;
