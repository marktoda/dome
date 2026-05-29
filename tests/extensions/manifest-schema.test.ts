import { describe, expect, test } from "bun:test";

import { parseManifest } from "../../src/extensions/manifest-schema";

const baseProcessor = {
  id: "test.proc",
  version: "0.0.1",
  phase: "garden",
  triggers: [{ kind: "signal", name: "file.created" }],
  capabilities: [],
  module: "./processors/proc.ts",
};

describe("parseManifest — execution metadata", () => {
  test("accepts garden answer triggers", () => {
    const result = parseManifest({
      id: "test.bundle",
      version: "0.0.1",
      processors: [
        {
          ...baseProcessor,
          triggers: [{ kind: "answer", idempotencyKeyPrefix: "test." }],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.processors[0]?.triggers[0]?.kind).toBe("answer");
  });

  test("rejects view answer triggers", () => {
    const result = parseManifest({
      id: "test.bundle",
      version: "0.0.1",
      processors: [
        {
          ...baseProcessor,
          phase: "view",
          triggers: [{ kind: "answer" }],
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("phase-trigger-mismatch");
    if (result.error.kind !== "phase-trigger-mismatch") return;
    expect(result.error.phase).toBe("view");
    expect(result.error.trigger).toBe("answer");
  });

  test("accepts garden llm execution metadata", () => {
    const result = parseManifest({
      id: "test.bundle",
      version: "0.0.1",
      processors: [
        {
          ...baseProcessor,
          execution: {
            class: "llm",
            timeoutMs: 600_000,
            modelCallTimeoutMs: 180_000,
          },
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.processors[0]?.execution?.class).toBe("llm");
  });

  test("rejects adoption llm execution metadata", () => {
    const result = parseManifest({
      id: "test.bundle",
      version: "0.0.1",
      processors: [
        {
          ...baseProcessor,
          phase: "adoption",
          execution: { class: "llm", timeoutMs: 600_000 },
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("execution-policy-mismatch");
    if (result.error.kind !== "execution-policy-mismatch") return;
    expect(result.error.processorId).toBe("test.proc");
    expect(result.error.phase).toBe("adoption");
    expect(result.error.executionClass).toBe("llm");
  });

  test("rejects processor-level retry metadata", () => {
    const result = parseManifest({
      id: "test.bundle",
      version: "0.0.1",
      processors: [
        {
          ...baseProcessor,
          execution: {
            class: "background",
            maxAttempts: 2,
          },
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid-shape");
  });

  test("rejects adoption model.invoke capability", () => {
    const result = parseManifest({
      id: "test.bundle",
      version: "0.0.1",
      processors: [
        {
          ...baseProcessor,
          phase: "adoption",
          capabilities: [{ kind: "model.invoke", maxDailyCostUsd: 1 }],
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("capability-phase-mismatch");
    if (result.error.kind !== "capability-phase-mismatch") return;
    expect(result.error.processorId).toBe("test.proc");
    expect(result.error.phase).toBe("adoption");
    expect(result.error.capability).toBe("model.invoke");
  });
});
