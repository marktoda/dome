// Smoke tests for src/core/processor.ts: the static-data boundary schemas
// (TriggerSchema, CapabilitySchema, ProcessorPhaseSchema, SignalSchema) and
// the `defineProcessor` type-narrowing identity helper.

import { describe, test, expect } from "bun:test";
import {
  CapabilitySchema,
  ExecutionPolicyRequestSchema,
  ProcessorPhaseSchema,
  SignalSchema,
  TriggerSchema,
  defineProcessor,
  type Processor,
} from "../../src/core/processor";

describe("defineProcessor", () => {
  test("returns a frozen processor", () => {
    const p: Processor = defineProcessor({
      id: "test.smoke",
      version: "0.0.1",
      phase: "adoption",
      triggers: [{ kind: "path", pattern: "wiki/**/*.md" }],
      capabilities: [],
      run: async () => [],
    });
    expect(Object.isFrozen(p)).toBe(true);
  });

  test("is a type-narrowing identity (input shape passes through unchanged)", () => {
    const input = {
      id: "test.identity",
      version: "0.0.1",
      phase: "view" as const,
      triggers: [],
      capabilities: [],
      run: async () => [],
    };
    const p = defineProcessor(input);
    expect(p.id).toBe(input.id);
    expect(p.version).toBe(input.version);
    expect(p.phase).toBe(input.phase);
  });

  test("defineProcessor preserves execution metadata", () => {
    const p = defineProcessor({
      id: "test.execution",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "signal", name: "file.created" }],
      capabilities: [],
      execution: {
        class: "llm",
        timeoutMs: 600_000,
        modelCallTimeoutMs: 180_000,
      },
      run: async () => [],
    });

    expect(p.execution?.class).toBe("llm");
    expect(p.execution?.timeoutMs).toBe(600_000);
  });
});

describe("TriggerSchema (discriminated union)", () => {
  test("parses a SignalTrigger", () => {
    const t = TriggerSchema.parse({
      kind: "signal",
      name: "file.created",
      pathPattern: "wiki/**",
    });
    expect(t.kind).toBe("signal");
  });

  test("parses a PathTrigger", () => {
    const t = TriggerSchema.parse({ kind: "path", pattern: "wiki/**/*.md" });
    expect(t.kind).toBe("path");
  });

  test("parses a ScheduleTrigger", () => {
    const t = TriggerSchema.parse({ kind: "schedule", cron: "0 0 * * *" });
    expect(t.kind).toBe("schedule");
  });

  test("parses an AnswerTrigger", () => {
    const t = TriggerSchema.parse({
      kind: "answer",
      idempotencyKeyPrefix: "dome.intake.",
    });
    expect(t.kind).toBe("answer");
  });

  test("parses a CommandTrigger", () => {
    const t = TriggerSchema.parse({ kind: "command", name: "doctor" });
    expect(t.kind).toBe("command");
  });
});

describe("CapabilitySchema (discriminated union, 10 kinds)", () => {
  test("read", () => {
    expect(CapabilitySchema.parse({ kind: "read", paths: ["wiki/**"] }).kind).toBe("read");
  });

  test("patch.propose", () => {
    expect(
      CapabilitySchema.parse({ kind: "patch.propose", paths: ["wiki/**"] }).kind,
    ).toBe("patch.propose");
  });

  test("patch.auto", () => {
    expect(
      CapabilitySchema.parse({ kind: "patch.auto", paths: ["wiki/**"] }).kind,
    ).toBe("patch.auto");
  });

  test("owns.region", () => {
    expect(
      CapabilitySchema.parse({ kind: "owns.region", regionIds: ["index"] }).kind,
    ).toBe("owns.region");
  });

  test("owns.path", () => {
    expect(
      CapabilitySchema.parse({ kind: "owns.path", paths: ["index.md"] }).kind,
    ).toBe("owns.path");
  });

  test("graph.write", () => {
    expect(
      CapabilitySchema.parse({ kind: "graph.write", namespaces: ["dome.tasks"] }).kind,
    ).toBe("graph.write");
  });

  test("question.ask", () => {
    expect(
      CapabilitySchema.parse({ kind: "question.ask", namespaces: ["dome.intake"] }).kind,
    ).toBe("question.ask");
  });

  test("job.enqueue", () => {
    expect(
      CapabilitySchema.parse({ kind: "job.enqueue", processors: ["dome.worker.*"] }).kind,
    ).toBe("job.enqueue");
  });

  test("model.invoke", () => {
    expect(CapabilitySchema.parse({ kind: "model.invoke" }).kind).toBe("model.invoke");
  });

  test("external", () => {
    expect(
      CapabilitySchema.parse({ kind: "external", capability: "calendar.write" }).kind,
    ).toBe("external");
  });
});

describe("ProcessorPhaseSchema + SignalSchema", () => {
  test("ProcessorPhaseSchema rejects an unknown phase string", () => {
    expect(() => ProcessorPhaseSchema.parse("invalid")).toThrow();
  });

  test("SignalSchema rejects an unknown signal name", () => {
    expect(() => SignalSchema.parse("file.exploded")).toThrow();
  });
});

describe("ExecutionPolicyRequestSchema", () => {
  test("parses valid execution metadata", () => {
    const parsed = ExecutionPolicyRequestSchema.parse({
      class: "llm",
      timeoutMs: 600_000,
      modelCallTimeoutMs: 180_000,
    });

    expect(parsed.class).toBe("llm");
    expect(parsed.timeoutMs).toBe(600_000);
  });

  test("rejects unknown keys and invalid numeric values", () => {
    expect(() =>
      ExecutionPolicyRequestSchema.parse({
        class: "background",
        timeoutMs: 0,
      }),
    ).toThrow();
    expect(() =>
      ExecutionPolicyRequestSchema.parse({
        class: "background",
        timeoutMs: 120_000,
        extra: true,
      }),
    ).toThrow();
  });

  test("rejects processor-level retry metadata", () => {
    expect(() =>
      ExecutionPolicyRequestSchema.parse({
        class: "background",
        maxAttempts: 2,
      }),
    ).toThrow();
    expect(() =>
      ExecutionPolicyRequestSchema.parse({
        class: "background",
        retryBudgetMs: 1_000,
      }),
    ).toThrow();
  });
});
