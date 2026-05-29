import { expect } from "bun:test";
import { join } from "node:path";

import { capabilityUsesByRun } from "../../../../src/ledger/capability-uses";
import type { RunId } from "../../../../src/engine/runner-contract";
import { scenario } from "../../index";

const FIXTURE_BUNDLE = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.job-patch-flow",
);

scenario(
  {
    name: "effect-routing: JobEffect drains queued worker patch through garden sub-Proposal",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "job" },
      { kind: "effect", effect: "patch" },
      { kind: "capability", capability: "job.enqueue" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "phase", phase: "garden" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: {
      bundles: [{ id: "test.job-patch-flow", root: FIXTURE_BUNDLE }],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  test.job-patch-flow:
    enabled: true
    grant:
      read: ["wiki/seed.md"]
      job.enqueue: ["test.job-patch-flow.worker"]
      patch.auto: ["wiki/**"]
`,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      message: "seed queued job patch flow",
      files: {
        "wiki/seed.md": "# Seed\n\nQueue a worker job.\n",
      },
    });

    const result = await h.tick();
    expect(result.adopted).toBe(true);

    await h.expectFile("wiki/job-output.md").toContain(
      "Created by a queued garden worker.",
    );
    const refs = await h.refs.current();
    if (refs.adopted === null) throw new Error("expected adopted ref");
    expect(result.adoptedAfter).toBe(refs.adopted);

    const enqueuerRun = await h
      .expectLedger({
        processorId: "test.job-patch-flow.enqueue",
        status: "succeeded",
      })
      .toHaveExactlyOne();
    await h
      .expectLedger({
        processorId: "test.job-patch-flow.worker",
        status: "succeeded",
      })
      .toHaveAtLeastOne();

    expect(capabilityUsesByRun(h.ledger, enqueuerRun.id as RunId)).toEqual([
      expect.objectContaining({
        capability: "job.enqueue",
        resource: "test.job-patch-flow.worker",
        outcome: "allowed",
      }),
    ]);
    const workerPatchUses = h.ledger.raw
      .query<
        { capability: string; resource: string | null; outcome: string },
        []
      >(
        `
        SELECT cu.capability, cu.resource, cu.outcome
        FROM capability_uses cu
        JOIN runs r ON r.id = cu.run_id
        WHERE r.processor_id = 'test.job-patch-flow.worker'
          AND cu.capability = 'patch.auto'
        ORDER BY cu.id
        `.trim(),
      )
      .all();
    expect(workerPatchUses).toEqual([
      {
        capability: "patch.auto",
        resource: "wiki/job-output.md",
        outcome: "allowed",
      },
    ]);

    const jobs = h.projection.raw
      .query<{ status: string; attempts: number }, []>(
        "SELECT status, attempts FROM scheduled_jobs WHERE idempotency_key = 'test.job-patch-flow.worker:seed'",
      )
      .all();
    expect(jobs).toEqual([{ status: "succeeded", attempts: 1 }]);
  },
);
