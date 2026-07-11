// scenarios/effect-routing/model-provider-failure.scenario.test.ts
//
// A model-provider outage must degrade cleanly: the garden run fails and is
// ledgered, no patch lands from the failed run, and the vault keeps adopting.
// Pins the e2e contract behind
// docs/wiki/specs/processor-execution.md §model failures.
//
// Uses the test.model-write-provenance fixture: a signal-triggered garden
// processor that calls ctx.modelInvoke.structured() and propagates any error
// (no try/catch around the model call). When the injected modelProvider
// throws, the runtime wraps the error in "model.invoke.provider-failed"
// (retryable: true) and, after exhausting retries per the retry budget in
// docs/wiki/specs/processor-execution.md, propagates the failure. The
// executor records the run as status="failed" with the error JSON. Because
// this is a garden-phase processor, adoption still completes (only
// adoption-phase failures block adoption).
//
// Note: the shipped model-class agents (e.g. dome.agent.garden)
// intentionally swallow model errors via try/catch (they degrade to a clean
// no-op when the model is unavailable). That resilience is correct but means
// they cannot demonstrate the "failed run" invariant. A fixture processor that
// propagates the error is the right vehicle for this scenario.

import { expect } from "bun:test";
import { join } from "node:path";

import { scenario } from "../../index";

const FIXTURE_BUNDLE = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.model-write-provenance",
);

const PROCESSOR_ID = "test.model-write-provenance.emit";
const OUTPUT_PATH = "wiki/generated/model-write.md";

scenario(
  {
    name: "effect-routing: model provider failure → failed run, stable vault",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "phase", phase: "garden" },
      { kind: "capability", capability: "model.invoke" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: {
      bundles: [{ id: "test.model-write-provenance", root: FIXTURE_BUNDLE }],
      modelProvider: async () => {
        throw new Error("simulated provider outage");
      },
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  test.model-write-provenance:
    enabled: true
    grant:
      read: ["inbox/raw/**"]
      patch.auto: ["wiki/generated/**"]
      model.invoke:
        modelAllowlist: ["test-model"]
`,
      },
    },
  },
  async (h) => {
    // Step 0: seed tick — adopts the initial commit; no inbox files yet so
    // the processor does not fire.
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    // Step 1: commit a file that triggers the processor (file.created on
    // inbox/raw/*.md).
    await h.userCommit({
      files: { "inbox/raw/capture.md": "# Capture\n\nA note to process.\n" },
      message: "add capture",
    });

    // Step 2: tick — the processor fires, calls model.invoke, provider throws,
    // runtime exhausts its retry budget (docs/wiki/specs/processor-execution.md),
    // then propagates. The executor records status="failed". Because this is
    // garden-phase, adoption still completes.
    const tick = await h.tick();
    expect(tick.adopted).toBe(true);

    // Step 3: assert the run is ledgered as failed.
    // The error JSON carries code "model.invoke.provider-failed" — the
    // terminal error code after exhausting retries when the provider throws.
    const failedRun = await h
      .expectLedger({ processorId: PROCESSOR_ID, status: "failed" })
      .toHaveExactlyOne();
    expect(JSON.parse(failedRun.error ?? "{}")).toMatchObject({
      code: "model.invoke.provider-failed",
      retryable: true,
    });

    // No succeeded runs (the provider always throws).
    await h
      .expectLedger({ processorId: PROCESSOR_ID, status: "succeeded" })
      .toHaveCount(0);

    // Step 4: no patch landed — the processor never reached patchEffect
    // because the model call threw first.
    await h.expectFile(OUTPUT_PATH).toBeAbsent();

    // Step 5: the vault keeps working — a follow-up commit still adopts cleanly.
    await h.userCommit({
      files: { "inbox/raw/second.md": "# Second\n\nAnother note.\n" },
      message: "add second capture",
    });
    const next = await h.tick();
    expect(next.adopted).toBe(true);
  },
);
