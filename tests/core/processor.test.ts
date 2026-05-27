// Smoke tests for src/core/processor.ts: the static-data boundary schemas
// (TriggerSchema, CapabilitySchema, ProcessorPhaseSchema, SignalSchema) and
// the `defineProcessor` type-narrowing identity helper.

import { describe, test, expect } from "bun:test";
import {
  CapabilitySchema,
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

  test("parses a CommandTrigger", () => {
    const t = TriggerSchema.parse({ kind: "command", name: "doctor" });
    expect(t.kind).toBe("command");
  });
});

describe("CapabilitySchema (discriminated union, 8 kinds)", () => {
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
