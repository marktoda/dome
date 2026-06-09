import { describe, expect, test } from "bun:test";
import consolidate from "../../../assets/extensions/dome.agent/processors/consolidate";
import type { ProcessorContext, ModelStepResult } from "../../../src/core/processor";
import type { PatchEffect, QuestionEffect } from "../../../src/core/effect";

function makeCtx(opts: {
  files: Record<string, string>;
  stepFn?: (input: {
    readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  }) => Promise<ModelStepResult>;
}): ProcessorContext {
  const modelInvoke =
    opts.stepFn === undefined
      ? undefined
      : (Object.assign(async () => "", {
          structured: async () => ({}) as never,
          step: opts.stepFn,
        }) as never);
  return {
    snapshot: {
      commit: "c" as never,
      tree: "t" as never,
      readFile: async (p: string) => opts.files[p] ?? null,
      listMarkdownFiles: async () => Object.keys(opts.files),
      getFileInfo: async () => null,
    },
    changedPaths: [],
    proposal: null,
    runId: "run1",
    input: { kind: "schedule" },
    now: () => new Date("2026-06-09T04:00:00Z"),
    signal: new AbortController().signal,
    capabilities: {} as never,
    extensionConfig: {},
    ...(modelInvoke !== undefined ? { modelInvoke } : {}),
    sourceRef: (path: string) => ({ path }) as never,
  } as ProcessorContext;
}

describe("dome.agent.consolidate", () => {
  test("no-op when no model step is wired", async () => {
    expect(await consolidate.run(makeCtx({ files: { "index.md": "x" } }))).toEqual([]);
  });

  test("merges a duplicate into one PatchEffect: canonical write + absorbed delete + link rewrite", async () => {
    const files = {
      "index.md": "## Concepts\n- [[wiki/concepts/a]] — A\n- [[wiki/concepts/b]] — B (dup)\n",
      "wiki/concepts/a.md": "# A\nfact-A",
      "wiki/concepts/b.md": "# B\nfact-B",
      "wiki/concepts/refs-b.md": "see [[wiki/concepts/b]]",
    };
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      const turns = messages.filter((m) => m.role === "assistant").length;
      if (turns === 0)
        return { toolCalls: [{ id: "1", name: "writePage", input: { path: "wiki/concepts/a.md", content: "# A\nfact-A\nfact-B" } }] };
      if (turns === 1)
        return { toolCalls: [{ id: "2", name: "deletePage", input: { path: "wiki/concepts/b.md" } }] };
      if (turns === 2)
        return { toolCalls: [{ id: "3", name: "writePage", input: { path: "wiki/concepts/refs-b.md", content: "see [[wiki/concepts/a]]" } }] };
      return { text: "merged b into a" };
    };
    const effects = await consolidate.run(makeCtx({ files, stepFn }));
    const patches = effects.filter((e) => e.kind === "patch") as PatchEffect[];
    expect(patches.length).toBe(1);
    const byPath = new Map(patches[0]!.changes.map((c) => [String(c.path), c]));
    expect(byPath.get("wiki/concepts/a.md")?.kind).toBe("write");
    expect(byPath.get("wiki/concepts/b.md")?.kind).toBe("delete");
    expect(byPath.get("wiki/concepts/refs-b.md")?.kind).toBe("write");
    expect(patches[0]!.sourceRefs.length).toBeGreaterThan(0);
  });

  test("ambiguous case asks instead of merging", async () => {
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      const turns = messages.filter((m) => m.role === "assistant").length;
      if (turns === 0)
        return { toolCalls: [{ id: "1", name: "askOwner", input: { question: "Merge X ← Y? may be distinct" } }] };
      return { text: "asked" };
    };
    const effects = await consolidate.run(makeCtx({ files: { "index.md": "x" }, stepFn }));
    expect(effects.find((e) => e.kind === "patch")).toBeUndefined();
    const q = effects.find((e) => e.kind === "question") as QuestionEffect;
    expect(q.question).toContain("Merge X");
  });
});
