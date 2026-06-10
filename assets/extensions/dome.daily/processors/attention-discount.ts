// dome.daily.attention-discount — deterministic attention-discount facts
// (memory-quality M4, dismissal-derived impression discounting).
//
// For each anchored, unsettled open-loop item that the recent dailies'
// generated open-loops blocks have shown, emits one `dome.attention.discount`
// fact carrying { anchor, body, discount, impressions, lastShown }. The
// discount formula and every input are normative in
// docs/wiki/specs/task-lifecycle.md §"Attention discounting".
//
// Rebuild-eligible by construction (`isRebuildEligibleGardenProcessor`):
// garden phase, `execution.class: deterministic`, signal triggers, and only
// read + graph.write capabilities. The derivation uses no clock — the
// reference "today" is the newest scanned daily's date — and no model, so
// `dome rebuild` reproduces every fact from adopted markdown + git history
// (PROJECTIONS_ARE_REBUILDABLE).
//
// Convergent: the fact set is a pure function of the snapshot, and the
// projection sink clears this processor's page facts for every inspected
// path (inspection: all-readable-markdown) before inserting a run's facts —
// settled or vanished items lose their rows (cleanup), unchanged content
// re-emits byte-identical rows (no-op).

import {
  factEffect,
  type Effect,
  type FactEffect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

import {
  ATTENTION_DISCOUNT_PREDICATE,
  attentionDiscountFactValue,
  collectAttentionDiscounts,
} from "./attention-shared";
import { dailyPathSettings } from "./daily-shared";

import { compareStrings } from "../../../../src/core/compare";

// Defense-in-depth (mirrors dome.markdown.page-status): the broker enforces
// the declared `dome.attention.*` namespace; a drifted predicate fails loudly
// at the source instead of being silently rejected.
const REQUIRED_NAMESPACE_PREFIX = "dome.attention.";

const attentionDiscount = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    if (!ATTENTION_DISCOUNT_PREDICATE.startsWith(REQUIRED_NAMESPACE_PREFIX)) {
      throw new Error(
        `dome.daily.attention-discount: predicate '${ATTENTION_DISCOUNT_PREDICATE}' does not start with the declared namespace prefix '${REQUIRED_NAMESPACE_PREFIX}'`,
      );
    }

    const settings = dailyPathSettings(ctx.extensionConfig);
    const discounts = await collectAttentionDiscounts({
      snapshot: ctx.snapshot,
      settings,
    });

    const facts: FactEffect[] = [];
    const entries = [...discounts.values()].sort(
      (a, b) =>
        compareStrings(a.sourcePath, b.sourcePath) ||
        a.line - b.line ||
        compareStrings(a.anchor, b.anchor),
    );
    for (const entry of entries) {
      facts.push(
        factEffect({
          subject: { kind: "page", path: entry.sourcePath },
          predicate: ATTENTION_DISCOUNT_PREDICATE,
          object: { kind: "string", value: attentionDiscountFactValue(entry) },
          assertion: "extracted",
          sourceRefs: [
            ctx.sourceRef(
              entry.sourcePath,
              { startLine: entry.line, endLine: entry.line },
              entry.stableId,
            ),
          ],
        }),
      );
    }
    return Object.freeze(facts);
  },
});

export default attentionDiscount;
