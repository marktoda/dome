import {
  factEffect,
  type Effect,
} from "../../../../../../src/core/effect";
import { defineProcessor } from "../../../../../../src/core/processor";

const SIGNAL_PATH = "wiki/signal-only.md";

export default defineProcessor({
  id: "test.context-signal.emit-open-loop",
  version: "0.1.0",
  phase: "adoption",
  triggers: [
    {
      kind: "signal",
      name: "document.changed",
      pathPattern: SIGNAL_PATH,
    },
    {
      kind: "signal",
      name: "file.created",
      pathPattern: SIGNAL_PATH,
    },
  ],
  capabilities: [
    { kind: "read", paths: [SIGNAL_PATH] },
    { kind: "graph.write", namespaces: ["dome.daily.*"] },
  ],
  async run(ctx): Promise<Effect[]> {
    if (!ctx.changedPaths.includes(SIGNAL_PATH)) return [];
    const body = await ctx.snapshot.readFile(SIGNAL_PATH);
    if (body === null) return [];
    return [
      factEffect({
        subject: { kind: "page", path: SIGNAL_PATH },
        predicate: "dome.daily.open_task",
        object: {
          kind: "string",
          value: "Call Riley about alpha launch readiness",
        },
        assertion: "explicit",
        sourceRefs: [ctx.sourceRef(SIGNAL_PATH)],
      }),
    ];
  },
});
