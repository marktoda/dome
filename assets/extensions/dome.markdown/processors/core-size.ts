// dome.markdown.core-size — core memory size budget.
//
// The vault-root `core.md` page is the owner's always-loaded core memory:
// every dome.agent run prepends it to the agent's task context, so it is a
// per-run context line-item, not a junk drawer. This deterministic lint
// warns when the page exceeds the ~6,000-character budget — split details
// into wiki pages and keep only the always-relevant summary here.
//
// Budget ladder (two coordinated constants, deliberately ~3x apart):
//   - 6,000 chars (CORE_SIZE_BUDGET_CHARS, here) — the SOFT budget: an
//     advisory warning, well below the hard cap so the owner has runway.
//   - 20,000 chars (dome.agent lib/core-memory.ts CORE_MEMORY_MAX_CHARS) —
//     the HARD floor: core memory is truncated at injection so a runaway page
//     cannot eat the loop's context budget. Keep the soft budget below it.
//
// Scope: the literal top-level `core.md` only. A vault configuring a custom
// `extensions.dome.agent.config.core_path` forgoes this lint — by design.
// dome.markdown cannot read dome.agent's config namespace without breaking
// per-bundle config isolation, and coupling the two bundles to honor a custom
// path is not worth it for a soft advisory (the 20k hard cap still applies at
// injection regardless of path). If configurable core paths ever become
// common, the right move is to relocate this lint into dome.agent, which owns
// `core.md` and resolves `core_path`. See docs/wiki/specs/vault-layout.md
// §"core.md".

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
