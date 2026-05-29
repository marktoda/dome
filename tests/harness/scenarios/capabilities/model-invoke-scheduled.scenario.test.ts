import { expect } from "bun:test";
import { join } from "node:path";

import { capabilityUsesByRun } from "../../../../src/ledger/capability-uses";
import type { RunId } from "../../../../src/ledger/runs";
import { scenario } from "../../index";

const FIXTURE_BUNDLE = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.model-invoke-flow",
);

const PROCESSOR_ID = "test.model-invoke-flow.scheduled";

const modelProviderState: {
  calls: number;
  prompts: string[];
  models: Array<string | null>;
} = {
  calls: 0,
  prompts: [],
  models: [],
};

const budgetProviderState: {
  calls: number;
} = {
  calls: 0,
};

scenario(
  {
    name: "capabilities: scheduled model.invoke runs during in-sync operational drain",
    tags: [
      { kind: "group", group: "capabilities" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "capability", capability: "model.invoke" },
      { kind: "phase", phase: "garden" },
      { kind: "trigger", trigger: "schedule" },
    ],
    harness: {
      bundles: [{ id: "test.model-invoke-flow", root: FIXTURE_BUNDLE }],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  test.model-invoke-flow:
    enabled: true
    grant:
      model.invoke:
        modelAllowlist: ["test-model"]
`,
      },
      modelProvider: async (request) => {
        const globalState = modelProviderState;
        globalState.calls += 1;
        globalState.prompts.push(request.prompt);
        globalState.models.push(request.model ?? null);
        if (globalState.calls === 1) {
          return { text: "not-json", costUsd: 0.125 };
        }
        return { text: "{\"ok\":true}", costUsd: 0.25 };
      },
    },
  },
  async (h) => {
    modelProviderState.calls = 0;
    modelProviderState.prompts = [];
    modelProviderState.models = [];

    const seed = await h.tick();
    expect(seed.adopted).toBe(true);
    expect(modelProviderState.calls).toBe(1);

    const failed = await h
      .expectLedger({ processorId: PROCESSOR_ID, status: "failed" })
      .toHaveExactlyOne();
    expect(JSON.parse(failed.error ?? "{}").code).toBe(
      "model.output.invalid-json",
    );
    await h
      .expectProjection()
      .diagnostics({ code: "model.output.invalid-json", severity: "error" })
      .toHaveCount(1);

    await h.advance(60_000);
    const inSync = await h.tick();
    expect(inSync.hadDrift).toBe(false);
    expect(modelProviderState.calls).toBe(2);
    await h
      .expectProjection()
      .diagnostics({ code: "test.model.invoke.ok", severity: "info" })
      .toHaveCount(1);

    await h.advance(60_000);
    const drained = await h.drainOperationalWork();
    expect(drained.scheduler.fired.map((fire) => fire.processorId)).toContain(
      PROCESSOR_ID,
    );
    expect(modelProviderState.calls).toBe(3);
    await h
      .expectLedger({ processorId: PROCESSOR_ID, status: "succeeded" })
      .toHaveCount(2);

    expect(modelProviderState.prompts).toEqual([
      "Return JSON: {\"ok\": true}",
      "Return JSON: {\"ok\": true}",
      "Return JSON: {\"ok\": true}",
    ]);
    expect(modelProviderState.models).toEqual([
      "test-model",
      "test-model",
      "test-model",
    ]);

    const costRows = h.ledger.raw
      .query<{ status: string; cost_usd: number | null }, [string]>(
        `
        SELECT status, cost_usd
        FROM runs
        WHERE processor_id = ?
        ORDER BY started_at ASC
        `.trim(),
      )
      .all(PROCESSOR_ID);
    expect(costRows).toEqual([
      { status: "failed", cost_usd: 0.125 },
      { status: "succeeded", cost_usd: 0.25 },
      { status: "succeeded", cost_usd: 0.25 },
    ]);

    const runIds = h.ledger.raw
      .query<{ id: string }, [string]>(
        `
        SELECT id
        FROM runs
        WHERE processor_id = ?
        ORDER BY started_at ASC
        `.trim(),
      )
      .all(PROCESSOR_ID);
    const usesByRun = runIds.map((row) =>
      capabilityUsesByRun(h.ledger, row.id as RunId),
    );
    expectOnlyModelInvokeUse(usesByRun[0] ?? [], "allowed");
    expectOnlyModelInvokeUse(usesByRun[1] ?? [], "allowed");
    expectOnlyModelInvokeUse(usesByRun[2] ?? [], "allowed");
  },
);

scenario(
  {
    name: "capabilities: model.invoke daily budget denial is visible",
    tags: [
      { kind: "group", group: "capabilities" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "capability", capability: "model.invoke" },
      { kind: "phase", phase: "garden" },
      { kind: "trigger", trigger: "schedule" },
    ],
    harness: {
      bundles: [{ id: "test.model-invoke-flow", root: FIXTURE_BUNDLE }],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  test.model-invoke-flow:
    enabled: true
    grant:
      model.invoke:
        modelAllowlist: ["test-model"]
        maxDailyCostUsd: 0.25
`,
      },
      modelProvider: async () => {
        budgetProviderState.calls += 1;
        return { text: "{\"ok\":true}", costUsd: 0.25 };
      },
    },
  },
  async (h) => {
    budgetProviderState.calls = 0;

    const seed = await h.tick();
    expect(seed.adopted).toBe(true);
    expect(budgetProviderState.calls).toBe(1);
    await h
      .expectLedger({ processorId: PROCESSOR_ID, status: "succeeded" })
      .toHaveExactlyOne();

    await h.advance(60_000);
    const drained = await h.drainOperationalWork();
    expect(drained.scheduler.fired.map((fire) => fire.processorId)).toContain(
      PROCESSOR_ID,
    );
    expect(budgetProviderState.calls).toBe(1);

    const denied = await h
      .expectLedger({ processorId: PROCESSOR_ID, status: "failed" })
      .toHaveExactlyOne();
    expect(JSON.parse(denied.error ?? "{}")).toMatchObject({
      code: "model.invoke.denied",
      retryable: false,
    });
    await h
      .expectProjection()
      .diagnostics({ code: "model.invoke.denied", severity: "error" })
      .toContainMessage("daily cost budget exceeded");

    const costRows = h.ledger.raw
      .query<{ status: string; cost_usd: number | null }, [string]>(
        `
        SELECT status, cost_usd
        FROM runs
        WHERE processor_id = ?
        ORDER BY started_at ASC
        `.trim(),
      )
      .all(PROCESSOR_ID);
    expect(costRows).toEqual([
      { status: "succeeded", cost_usd: 0.25 },
      { status: "failed", cost_usd: null },
    ]);

    const runIds = h.ledger.raw
      .query<{ id: string }, [string]>(
        `
        SELECT id
        FROM runs
        WHERE processor_id = ?
        ORDER BY started_at ASC
        `.trim(),
      )
      .all(PROCESSOR_ID);
    const usesByRun = runIds.map((row) =>
      capabilityUsesByRun(h.ledger, row.id as RunId),
    );
    expectOnlyModelInvokeUse(usesByRun[0] ?? [], "allowed");
    expectOnlyModelInvokeUse(usesByRun[1] ?? [], "denied");
  },
);

function expectOnlyModelInvokeUse(
  rows: ReadonlyArray<unknown>,
  outcome: "allowed" | "denied",
): void {
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual(expect.objectContaining({
    capability: "model.invoke",
    resource: "test-model",
    outcome,
  }));
}
