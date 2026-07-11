// dome.agent.garden — one nightly semantic-maintenance loop. Deterministic
// code selects one evidence-backed opportunity; the model investigates it;
// every markdown edit leaves as an owner-reviewed Proposal.

import { diagnosticEffect, type Effect } from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import { resolveTargets } from "../lib/agent-config";
import { runAgentLoop, type AgentRunState } from "../lib/agent-loop";
import { agentIntegrityEffects, finishAgentRun } from "../lib/agent-run-effects";
import { agentPreamble } from "../lib/agent-preamble";
import { withCoreMemory } from "../lib/core-memory";
import { gardenCharter } from "../lib/garden-charter";
import { readGardenDocuments } from "../lib/garden-snapshot";
import { GARDEN_WRITABLE_PATHS, makeGardenTools } from "../lib/garden-tools";
import {
  compileGardeningPlan,
  DEFAULT_GARDEN_TARGETS,
  GARDEN_REASON_PREFIX,
  selectGardeningOpportunity,
  settledGardeningOpportunityIds,
} from "../lib/gardening";
import { resolveModelOverride, withStepModel } from "../lib/model-override";
import { formatDate, localDateParts } from "../../dome.daily/processors/daily-paths";

const MAX_STEPS = 30;
export const MAX_GARDEN_CHANGED_FILES = 30;
export { GARDEN_REASON_PREFIX } from "../lib/gardening";

const garden = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const targets = resolveTargets(
      ctx.extensionConfig,
      "garden_targets",
      DEFAULT_GARDEN_TARGETS,
      GARDEN_WRITABLE_PATHS,
    );
    const today = formatDate(localDateParts(ctx.now()));
    const documents = await readGardenDocuments(ctx.snapshot);
    const settledOpportunityIds = proposalOpportunityIds(ctx);
    const plan = compileGardeningPlan({
      documents,
      today,
      targets: targets.value,
      // One expensive model run per night, selected from the complete current
      // candidate set by a stateless daily rotation.
      limit: Number.MAX_SAFE_INTEGER,
      settledOpportunityIds,
    });
    const selected = selectGardeningOpportunity(plan.opportunities, {
      today,
      strategy: "daily-rotation",
    });
    if (selected === null) return Object.freeze([]);

    const sourceRefs = selected.paths.map((path) => ctx.sourceRef(path));
    const modelOverride = resolveModelOverride(ctx.extensionConfig, "garden");
    const pre = await agentPreamble(
      ctx,
      [
        {
          problem: targets.problem,
          code: "dome.agent.garden-config-invalid",
          sourceRefs,
        },
        {
          problem: modelOverride.problem,
          code: "dome.agent.model-config-invalid",
          sourceRefs,
        },
      ],
      sourceRefs,
    );
    if (pre.kind === "no-model") return Object.freeze([]);

    const state: AgentRunState = {
      edits: new Map(),
      questions: [],
      integrityFlags: [],
    };
    let result;
    try {
      result = await runAgentLoop({
        charter: gardenCharter({
          maxChangedFiles: MAX_GARDEN_CHANGED_FILES,
          opportunity: selected,
        }),
        task: withCoreMemory(
          pre.core.section,
          `Investigate and settle gardening opportunity ${selected.id}: ${selected.summary}`,
        ),
        tools: makeGardenTools({
          readFile: (path) => ctx.snapshot.readFile(path),
          listMarkdownFiles: () => ctx.snapshot.listMarkdownFiles(),
        }),
        step: withStepModel(pre.step, modelOverride.model),
        maxSteps: MAX_STEPS,
        state,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Object.freeze([
        ...pre.effects,
        diagnosticEffect({
          severity: "warning",
          code: "dome.agent.garden-failed",
          message: `Semantic gardening failed (${message}); staged edits were discarded.`,
          sourceRefs,
        }),
      ]);
    }

    // Keep validated split proposals in the same durable opportunity identity
    // scheme as ordinary staged edits.
    if (state.splitProposal) {
      state.splitProposal = {
        ...state.splitProposal,
        reason: `${GARDEN_REASON_PREFIX}${selected.id}: ${state.splitProposal.reason}`,
      };
    }

    return Object.freeze([
      ...pre.effects,
      ...finishAgentRun({
        state,
        stopReason: result.stopReason,
        sourceRefs,
        patchMode: "propose",
        patchReason: `${GARDEN_REASON_PREFIX}${selected.id}`,
        finalText: result.finalText,
        truncatedMessage: `Semantic gardening hit its ${MAX_STEPS}-step budget; review the bounded proposal before applying it.`,
        cap: {
          maxChangedFiles: MAX_GARDEN_CHANGED_FILES,
          code: "dome.agent.garden-overreach",
          message: (count) =>
            `Semantic gardening staged ${count} files (cap ${MAX_GARDEN_CHANGED_FILES}); the run was discarded.`,
        },
        noOp: {
          code: "dome.agent.garden-clean",
          message: (excerpt) => `${selected.id} required no change: ${excerpt}`,
          finalText: result.finalText,
        },
        sourceRef: (path) => ctx.sourceRef(path),
      }),
      ...agentIntegrityEffects(state, (path, stableId) =>
        ctx.sourceRef(path, undefined, stableId)
      ),
    ]);
  },
});

export default garden;

function proposalOpportunityIds(ctx: ProcessorContext): ReadonlySet<string> {
  const proposals = ctx.operational?.proposals?.();
  if (proposals === undefined) return new Set();
  return settledGardeningOpportunityIds(proposals);
}

/** Exported for focused contract tests. */
export function settledGardenOpportunityIds(
  proposals: ReadonlyArray<{
    readonly processorId: string;
    readonly reason: string;
  }>,
): ReadonlySet<string> {
  return settledGardeningOpportunityIds(proposals);
}
