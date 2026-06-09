import { describe, expect, test } from "bun:test";
import consolidate, {
  consolidationLedgerPath,
} from "../../../assets/extensions/dome.agent/processors/consolidate";
import type { ProcessorContext, ModelStepResult } from "../../../src/core/processor";
import type {
  DiagnosticEffect,
  PatchEffect,
  QuestionEffect,
} from "../../../src/core/effect";

function makeCtx(opts: {
  files: Record<string, string>;
  extensionConfig?: Record<string, unknown>;
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
    extensionConfig: opts.extensionConfig ?? {},
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

  test("mid-run throw rolls back atomically: no patch, only a diagnostic", async () => {
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      const turns = messages.filter((m) => m.role === "assistant").length;
      if (turns === 0)
        return { toolCalls: [{ id: "1", name: "deletePage", input: { path: "wiki/concepts/b.md" } }] };
      throw new Error("provider died mid-merge");
    };
    const effects = await consolidate.run(
      makeCtx({ files: { "index.md": "x", "wiki/concepts/b.md": "B" }, stepFn }),
    );
    expect(effects.length).toBe(1);
    const diag = effects[0] as DiagnosticEffect;
    expect(diag.kind).toBe("diagnostic");
    expect(diag.code).toBe("dome.agent.consolidate-failed");
    expect(diag.message).toContain("rolled back");
  });

  test("a run exceeding the per-run patch cap is rolled back with an overreach diagnostic", async () => {
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      const turns = messages.filter((m) => m.role === "assistant").length;
      if (turns < 31) {
        return {
          toolCalls: [
            {
              id: String(turns),
              name: "writePage",
              input: { path: `wiki/concepts/p${turns}.md`, content: "x" },
            },
          ],
        };
      }
      return { text: "done" };
    };
    const effects = await consolidate.run(makeCtx({ files: { "index.md": "x" }, stepFn }));
    expect(effects.find((e) => e.kind === "patch")).toBeUndefined();
    const diag = effects.find((e) => e.kind === "diagnostic") as DiagnosticEffect;
    expect(diag.code).toBe("dome.agent.consolidate-overreach");
    expect(diag.message).toContain("31 files");
  });

  test("ledger path is configurable via extensionConfig and anchors the run's source refs", async () => {
    const seenSystem: string[] = [];
    const seenTask: string[] = [];
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      seenSystem.push(messages.find((m) => m.role === "system")?.content ?? "");
      seenTask.push(messages.find((m) => m.role === "user")?.content ?? "");
      const turns = messages.filter((m) => m.role === "assistant").length;
      if (turns === 0)
        return {
          toolCalls: [
            {
              id: "1",
              name: "writePage",
              input: { path: "notes/janitor-ledger.md", content: "# Consolidation ledger\n2026-06-09" },
            },
          ],
        };
      return { text: "done" };
    };
    const effects = await consolidate.run(
      makeCtx({
        files: { "index.md": "x" },
        extensionConfig: { consolidation_ledger_path: "notes/janitor-ledger.md" },
        stepFn,
      }),
    );
    const patch = effects.find((e) => e.kind === "patch") as PatchEffect;
    expect(patch.sourceRefs).toEqual([{ path: "notes/janitor-ledger.md" } as never]);
    expect(seenSystem[0]).toContain("notes/janitor-ledger.md");
    expect(seenTask[0]).toContain("notes/janitor-ledger.md");
  });

  test("consolidationLedgerPath validates config values", () => {
    expect(consolidationLedgerPath(undefined)).toBe("consolidation-ledger.md");
    expect(consolidationLedgerPath({})).toBe("consolidation-ledger.md");
    expect(
      consolidationLedgerPath({ consolidation_ledger_path: "notes/x.md" }),
    ).toBe("notes/x.md");
    expect(() =>
      consolidationLedgerPath({ consolidation_ledger_path: 7 }),
    ).toThrow("must be a string");
    expect(() =>
      consolidationLedgerPath({ consolidation_ledger_path: "ledger.txt" }),
    ).toThrow(".md path");
    expect(() =>
      consolidationLedgerPath({ consolidation_ledger_path: "/abs/ledger.md" }),
    ).toThrow("relative vault markdown path");
    expect(() =>
      consolidationLedgerPath({ consolidation_ledger_path: "../up/ledger.md" }),
    ).toThrow("relative vault markdown path");
  });
});
