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
// (retryable: true), retries once (PROVIDER_MAX_ATTEMPTS = 2), then
// propagates the failure. The executor records the run as status="failed"
// with the error JSON. Because this is a garden-phase processor, adoption
// still completes (only adoption-phase failures block adoption).
//
// Note: dome.warden.integrity intentionally swallows model errors via
// try/catch (it degrades to a clean no-op when the model is unavailable).
// That resilience is correct for the shipped warden but means it cannot
// demonstrate the "failed run" invariant. A fixture processor that
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
    // runtime retries (PROVIDER_MAX_ATTEMPTS = 2), then propagates. The
    // executor records status="failed". Because this is garden-phase, adoption
    // still completes.
    const tick = await h.tick();
    expect(tick.adopted).toBe(true);

    // Step 3: assert the run is ledgered as failed.
    // The error JSON carries code "model.invoke.provider-failed" — this is
    // the terminal error code after exhausting retries when the provider
    // throws (see src/engine/core/model-invoke.ts callGuardedWithRetry).
    // Adaptation from task sketch: real status is "failed", which matches the
    // sketch expectation. The error code is "model.invoke.provider-failed",
    // not a generic sentinel.
    const failedRun = await h
      .expectLedger({ processorId: PROCESSOR_ID, status: "failed" })
      .toHaveAtLeastOne();
    expect(failedRun.status).toBe("failed");
    expect(failedRun.error).not.toBeNull();
    if (failedRun.error !== null) {
      const parsed = JSON.parse(failedRun.error) as {
        code?: string;
        retryable?: boolean;
      };
      expect(parsed.code).toBe("model.invoke.provider-failed");
    }

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
