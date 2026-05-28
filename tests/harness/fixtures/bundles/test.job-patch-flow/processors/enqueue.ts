// Test fixture: garden processor that enqueues a worker job after seed creation.

import {
  jobEffect,
  type Effect,
} from "../../../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../../../src/core/processor";

const SEED_PATH = "wiki/seed.md";
const WORKER_ID = "test.job-patch-flow.worker";

const processor: Processor = defineProcessor({
  id: "test.job-patch-flow.enqueue",
  version: "0.1.0",
  phase: "garden",
  triggers: [
    { kind: "signal", name: "file.created", pathPattern: SEED_PATH },
  ],
  capabilities: [
    { kind: "job.enqueue", processors: [WORKER_ID] },
  ],
  run: async (
    ctx: ProcessorContext<unknown>,
  ): Promise<ReadonlyArray<Effect>> => {
    if (!ctx.changedPaths.includes(SEED_PATH)) return [];
    return [
      jobEffect({
        processorId: WORKER_ID,
        input: { seedPath: SEED_PATH },
        runAfter: "2026-01-01T00:00:00.000Z",
        idempotencyKey: "test.job-patch-flow.worker:seed",
      }),
    ];
  },
});

export default processor;
