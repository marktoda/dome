// Smoke tests for src/processors/registry.ts: buildRegistry validation,
// query operations (get / byPhase / all / size), error variants, and the
// frozen handle.

import { describe, test, expect } from "bun:test";
import { buildRegistry } from "../../src/processors/registry";
import {
  defineProcessor,
  type Processor,
  type ProcessorPhase,
  type Trigger,
} from "../../src/core/processor";

function makeProcessor(opts: {
  id: string;
  phase?: ProcessorPhase;
  hasTriggers?: boolean;
  triggers?: ReadonlyArray<Trigger>;
}): Processor {
  const triggers =
    opts.triggers !== undefined
      ? opts.triggers
      : opts.hasTriggers === false
        ? []
        : [{ kind: "path" as const, pattern: "wiki/**/*.md" }];

  return defineProcessor({
    id: opts.id,
    version: "0.0.1",
    phase: opts.phase ?? "adoption",
    triggers,
    capabilities: [],
    run: async () => [],
  });
}

describe("buildRegistry — happy paths", () => {
  test("empty input → ok, size 0, empty all() and byPhase()", () => {
    const r = buildRegistry([]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.size).toBe(0);
    expect(r.value.all()).toEqual([]);
    expect(r.value.byPhase("adoption")).toEqual([]);
    expect(r.value.byPhase("garden")).toEqual([]);
    expect(r.value.byPhase("view")).toEqual([]);
  });

  test("two distinct ids → ok; get() returns each; byPhase partitions correctly", () => {
    const a = makeProcessor({ id: "bundle.a:proc", phase: "adoption" });
    const g = makeProcessor({ id: "bundle.g:proc", phase: "garden" });
    const r = buildRegistry([a, g]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.size).toBe(2);
    expect(r.value.get("bundle.a:proc")).toBe(a);
    expect(r.value.get("bundle.g:proc")).toBe(g);
    expect(r.value.get("missing")).toBeUndefined();
    expect(r.value.byPhase("adoption")).toEqual([a]);
    expect(r.value.byPhase("garden")).toEqual([g]);
    expect(r.value.byPhase("view")).toEqual([]);
  });

  test("all() returns processors sorted alphabetically by id", () => {
    const c = makeProcessor({ id: "c.proc" });
    const a = makeProcessor({ id: "a.proc" });
    const b = makeProcessor({ id: "b.proc" });
    const r = buildRegistry([c, a, b]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.all().map((p) => p.id);
    expect(ids).toEqual(["a.proc", "b.proc", "c.proc"]);
  });

  test("byPhase('adoption') only returns adoption-phase processors", () => {
    const aA = makeProcessor({ id: "a.adopt", phase: "adoption" });
    const aG = makeProcessor({ id: "a.garden", phase: "garden" });
    const aV = makeProcessor({ id: "a.view", phase: "view" });
    const r = buildRegistry([aV, aG, aA]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.byPhase("adoption").map((p) => p.id)).toEqual(["a.adopt"]);
    expect(r.value.byPhase("garden").map((p) => p.id)).toEqual(["a.garden"]);
    expect(r.value.byPhase("view").map((p) => p.id)).toEqual(["a.view"]);
  });
});

describe("buildRegistry — error variants", () => {
  test("duplicate id → err 'duplicate-processor-id' carrying the conflict list", () => {
    const dupId = "dome.intake:extract";
    const a = makeProcessor({ id: dupId });
    const b = makeProcessor({ id: dupId });
    const r = buildRegistry([a, b]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("duplicate-processor-id");
    if (r.error.kind !== "duplicate-processor-id") return;
    expect(r.error.id).toBe(dupId);
    expect(r.error.processors).toEqual([dupId]);
  });

  test("duplicate view command names → err 'duplicate-command-trigger'", () => {
    const a = makeProcessor({
      id: "bundle.a.query",
      phase: "view",
      triggers: [{ kind: "command", name: "query" }],
    });
    const b = makeProcessor({
      id: "bundle.b.query",
      phase: "view",
      triggers: [{ kind: "command", name: "query" }],
    });
    const r = buildRegistry([a, b]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("duplicate-command-trigger");
    if (r.error.kind !== "duplicate-command-trigger") return;
    expect(r.error.commandName).toBe("query");
    expect(r.error.processors).toEqual(["bundle.a.query", "bundle.b.query"]);
  });

  test("duplicate command triggers inside one view processor are rejected", () => {
    const p = makeProcessor({
      id: "bundle.query",
      phase: "view",
      triggers: [
        { kind: "command", name: "query" },
        { kind: "command", name: "query" },
      ],
    });
    const r = buildRegistry([p]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("duplicate-command-trigger");
    if (r.error.kind !== "duplicate-command-trigger") return;
    expect(r.error.commandName).toBe("query");
    expect(r.error.processors).toEqual(["bundle.query"]);
  });

  test("empty triggers → err 'processor-no-triggers'", () => {
    const p = makeProcessor({ id: "test.no-triggers", hasTriggers: false });
    const r = buildRegistry([p]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("processor-no-triggers");
    if (r.error.kind !== "processor-no-triggers") return;
    expect(r.error.id).toBe("test.no-triggers");
  });

  test("invalid phase → err 'processor-invalid-phase'", () => {
    // Force an invalid phase via cast — the static type forbids this, the
    // defensive runtime check defends against untyped manifest deserialization.
    const bogus = {
      id: "test.bogus-phase",
      version: "0.0.1",
      phase: "garbage" as unknown as ProcessorPhase,
      triggers: [{ kind: "path", pattern: "wiki/**" } as const],
      capabilities: [],
      run: async () => [],
    } satisfies Processor;
    const r = buildRegistry([bogus]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("processor-invalid-phase");
    if (r.error.kind !== "processor-invalid-phase") return;
    expect(r.error.id).toBe("test.bogus-phase");
    expect(r.error.phase).toBe("garbage");
  });
});

describe("buildRegistry — frozen handle", () => {
  test("returned registry handle is frozen (mutation throws in strict mode / is rejected)", () => {
    const r = buildRegistry([makeProcessor({ id: "a.proc" })]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.isFrozen(r.value)).toBe(true);
  });

  test("all() returns the same instance across calls (memoized)", () => {
    const r = buildRegistry([
      makeProcessor({ id: "a.proc" }),
      makeProcessor({ id: "b.proc" }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.all()).toBe(r.value.all());
    expect(Object.isFrozen(r.value.all())).toBe(true);
  });
});
