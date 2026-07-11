// Read-only adapter over the same compiler the nightly executor uses.

import { viewEffect, type Effect, type ViewEffect } from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import { formatDate, localDateParts } from "../../dome.daily/processors/daily-paths";
import { resolveTargets } from "../lib/agent-config";
import { readGardenDocuments } from "../lib/garden-snapshot";
import { GARDEN_WRITABLE_PATHS } from "../lib/garden-tools";
import {
  compileGardeningPlan,
  DEFAULT_GARDEN_TARGETS,
  GARDEN_SCHEMA,
  settledGardeningOpportunityIds,
} from "../lib/gardening";

const gardenView = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const documents = await readGardenDocuments(ctx.snapshot);
    const targets = resolveTargets(
      ctx.extensionConfig,
      "garden_targets",
      DEFAULT_GARDEN_TARGETS,
      GARDEN_WRITABLE_PATHS,
    );
    const plan = compileGardeningPlan({
      documents,
      today: formatDate(localDateParts(ctx.now())),
      targets: targets.value,
      limit: 20,
      settledOpportunityIds: settledGardeningOpportunityIds(
        ctx.operational?.proposals?.() ?? [],
      ),
    });
    const effect: ViewEffect = viewEffect({
      name: "dome.agent.garden",
      content: {
        kind: "structured",
        schema: GARDEN_SCHEMA,
        data: {
          ...plan,
          asOfCommit: ctx.snapshot.commit,
          configProblem: targets.problem,
        },
      },
      scope: plan.opportunities.flatMap((item) =>
        item.paths.map((path) => ctx.sourceRef(path))
      ),
    });
    return [effect];
  },
});

export default gardenView;
