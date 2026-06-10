// dome.markdown.core-size — core memory size budget.
//
// The vault-root `core.md` page is the owner's always-loaded core memory:
// every dome.agent run prepends it to the agent's task context, so it is a
// per-run context line-item, not a junk drawer. This deterministic lint
// warns when the page exceeds the ~6,000-character budget — split details
// into wiki pages and keep only the always-relevant summary here.
//
// Scope: the literal top-level `core.md` only. A vault configuring a custom
// `extensions.dome.agent.config.core_path` forgoes this lint — dome.markdown
// deliberately does not read dome.agent's config (the simplest honest
// contract; see docs/wiki/specs/vault-layout.md §"core.md"). The structural
// floor lives in dome.agent itself: injection hard-caps at 20,000 chars.

import {
  diagnosticEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

const CORE_PATH = "core.md";
export const CORE_SIZE_BUDGET_CHARS = 6_000;
const CODE_CORE_OVERSIZE = "dome.markdown.core-oversize";

const coreSize = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    if (!ctx.changedPaths.includes(CORE_PATH)) return [];

    const content = await ctx.snapshot.readFile(CORE_PATH);
    if (content === null) return [];
    if (content.length <= CORE_SIZE_BUDGET_CHARS) return [];

    return [
      diagnosticEffect({
        severity: "warning",
        code: CODE_CORE_OVERSIZE,
        message:
          `core.md is ${content.length} characters (budget ${CORE_SIZE_BUDGET_CHARS}) — ` +
          "core memory must stay small enough to load everywhere; " +
          "split details into wiki pages.",
        sourceRefs: [ctx.sourceRef(CORE_PATH)],
      }),
    ];
  },
});

export default coreSize;
