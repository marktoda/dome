// Smoke tests for src/processors/context.ts: makeProcessorContext factory
// — frozen context, snapshot-bound sourceRef, capability token branding,
// optional modelInvoke handling, proposal pass-through.

import { describe, test, expect } from "bun:test";
import { makeProcessorContext } from "../../src/processors/context";
import type { ProcessorContextInput } from "../../src/processors/context";
import { commitOid } from "../../src/core/source-ref";
import { treeOid, type ModelInvokeFn, type Snapshot } from "../../src/core/processor";
import { makeManualProposal } from "../../src/core/proposal";

const COMMIT = commitOid("abc123");
const TREE = treeOid("def456");

const snapshot: Snapshot = Object.freeze({
  commit: COMMIT,
  tree: TREE,
  // Stub read closures — the context factory tests don't exercise them; the
  // runtime tests cover the live wiring against the git boundary.
  readFile: async (_path: string): Promise<string | null> => null,
  listMarkdownFiles: async (): Promise<ReadonlyArray<string>> => [],
  getFileInfo: async () => null,
});

function baseInput<TInput>(overrides: Partial<ProcessorContextInput<TInput>> & {
  input: TInput;
}): ProcessorContextInput<TInput> {
  return {
    snapshot,
    changedPaths: ["wiki/x.md"],
    proposal: null,
    runId: "run-1",
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("makeProcessorContext — shape and freezing", () => {
  test("returns a frozen ProcessorContext", () => {
    const ctx = makeProcessorContext(baseInput({ input: { kind: "test" } }));
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  test("ctx.sourceRef(path) returns a SourceRef with commit === snapshot.commit", () => {
    const ctx = makeProcessorContext(baseInput({ input: null }));
    const ref = ctx.sourceRef("wiki/x.md");
    expect(ref.commit).toBe(COMMIT);
    expect(ref.path as string).toBe("wiki/x.md");
    expect(ref.range).toBeUndefined();
  });

  test("ctx.sourceRef(path, range) includes the range in the result", () => {
    const ctx = makeProcessorContext(baseInput({ input: null }));
    const ref = ctx.sourceRef("wiki/x.md", { startLine: 1, endLine: 5 });
    expect(ref.commit).toBe(COMMIT);
    expect(ref.path as string).toBe("wiki/x.md");
    expect(ref.range).toEqual({ startLine: 1, endLine: 5 });
  });
});

describe("makeProcessorContext — capability token", () => {
  test("ctx.capabilities is the opaque CapabilityToken brand", () => {
    const ctx = makeProcessorContext(baseInput({ input: null }));
    // The brand check: the structurally-opaque token carries `__brand: 'CapabilityToken'`.
    const token = ctx.capabilities as unknown as { readonly __brand: string };
    expect(token.__brand).toBe("CapabilityToken");
  });

  test("the capability token is frozen (cannot be forged via mutation)", () => {
    const ctx = makeProcessorContext(baseInput({ input: null }));
    expect(Object.isFrozen(ctx.capabilities)).toBe(true);
  });
});

describe("makeProcessorContext — optional modelInvoke", () => {
  test("when modelInvoke is omitted from input, ctx.modelInvoke is undefined", () => {
    const ctx = makeProcessorContext(baseInput({ input: null }));
    expect(ctx.modelInvoke).toBeUndefined();
    // exactOptionalPropertyTypes-clean: no `modelInvoke` key on the object.
    expect("modelInvoke" in ctx).toBe(false);
  });

  test("when modelInvoke is supplied, ctx.modelInvoke is the same function", () => {
    const fn = Object.assign(async () => "ok", {
      structured: async <T,>() => null as T,
    }) as ModelInvokeFn;
    const ctx = makeProcessorContext(baseInput({ input: null, modelInvoke: fn }));
    expect(ctx.modelInvoke).toBe(fn);
  });
});

describe("makeProcessorContext — proposal pass-through", () => {
  test("ctx.proposal is preserved when null", () => {
    const ctx = makeProcessorContext(baseInput({ input: null, proposal: null }));
    expect(ctx.proposal).toBeNull();
  });

  test("ctx.proposal is preserved when non-null", () => {
    const proposal = makeManualProposal({
      id: "prop_1_aaaaaa",
      base: COMMIT,
      head: COMMIT,
      branch: "main",
    });
    const ctx = makeProcessorContext(baseInput({ input: null, proposal }));
    expect(ctx.proposal).toBe(proposal);
  });
});

describe("makeProcessorContext — primary inputs round-trip", () => {
  test("snapshot, changedPaths, runId, and input round-trip to the context", () => {
    const input = { kind: "marker" as const, payload: 42 };
    const ctx = makeProcessorContext(
      baseInput({ input, changedPaths: ["a.md", "b.md"], runId: "run-42" }),
    );
    expect(ctx.snapshot).toBe(snapshot);
    expect(ctx.changedPaths).toEqual(["a.md", "b.md"]);
    expect(ctx.runId).toBe("run-42");
    expect(ctx.input).toBe(input);
  });
});

describe("makeProcessorContext — extension config", () => {
  test("ctx.extensionConfig defaults to an empty frozen map", () => {
    const ctx = makeProcessorContext(baseInput({ input: null }));
    expect(ctx.extensionConfig).toEqual({});
    expect(Object.isFrozen(ctx.extensionConfig)).toBe(true);
  });

  test("ctx.extensionConfig preserves the runtime-supplied map", () => {
    const extensionConfig = Object.freeze({
      daily_path: "notes/{date}.md",
    });
    const ctx = makeProcessorContext(
      baseInput({ input: null, extensionConfig }),
    );
    expect(ctx.extensionConfig).toBe(extensionConfig);
  });
});

describe("makeProcessorContext — cancellation signal", () => {
  test("ctx.signal is the same AbortSignal passed by the runtime", () => {
    const controller = new AbortController();
    const ctx = makeProcessorContext(
      baseInput({ input: null, signal: controller.signal }),
    );
    expect(ctx.signal).toBe(controller.signal);
    expect(ctx.signal.aborted).toBe(false);
  });
});
