import {
  factEffect,
  type Effect,
} from "../../../../../../src/core/effect";
import { defineProcessor } from "../../../../../../src/core/processor";

export default defineProcessor({
  id: "test.garden-rebuild-facts.emit",
  version: "0.1.0",
  phase: "garden",
  execution: { class: "deterministic" },
  triggers: [
    {
      kind: "signal",
      name: "document.changed",
      pathPattern: "wiki/*.md",
    },
    {
      kind: "signal",
      name: "file.created",
      pathPattern: "wiki/*.md",
    },
  ],
  capabilities: [
    { kind: "read", paths: ["wiki/*.md"] },
    {
      kind: "graph.write",
      namespaces: ["test.garden_rebuild.*"],
    },
  ],
  async run(ctx): Promise<Effect[]> {
    const effects: Effect[] = [];
    for (const path of ctx.changedPaths) {
      const body = await ctx.snapshot.readFile(path);
      if (body === null || !body.includes("garden-rebuild")) continue;
      effects.push(
        factEffect({
          subject: { kind: "page", path },
          predicate: "test.garden_rebuild.seen",
          object: { kind: "string", value: "yes" },
          assertion: "explicit",
          sourceRefs: [ctx.sourceRef(path)],
        }),
      );
    }
    return effects;
  },
});
