// Test fixture: queues a future worker that edits vault page-type config.

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
const WORKER_ID = "test.page-type-job-flow.worker";

const processor: Processor = defineProcessor({
  id: "test.page-type-job-flow.enqueue",
  version: "0.1.0",
  phase: "garden",
  triggers: [
    { kind: "signal", name: "file.created", pathPattern: SEED_PATH },
  ],
  capabilities: [
    { kind: "read", paths: [SEED_PATH] },
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
        runAfter: "2026-01-01T00:01:00.000Z",
        idempotencyKey: "test.page-type-job-flow.worker:seed",
      }),
    ];
  },
});

export default processor;
