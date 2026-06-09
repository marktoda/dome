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

  test("text-only provider fails loudly: the engine's throwing step lands as consolidate-failed", async () => {
    // The engine attaches a THROWING step when a provider exists without
    // tool-step support (tests/engine/model-step.test.ts pins that seam).
    const ctx = makeCtx({
      files: { "index.md": "x" },
      stepFn: async () => {
        throw new Error(
          "dome.agent.consolidate: the configured model provider does not support tool-step invocation; wire a step provider (dome.model-provider.step/v1) to run agent processors.",
        );
      },
    });
    const effects = await consolidate.run(ctx);
    expect(effects).toHaveLength(1);
    const diag = effects[0] as DiagnosticEffect;
    expect(diag.kind).toBe("diagnostic");
    expect(diag.code).toBe("dome.agent.consolidate-failed");
    expect(diag.message).toContain("does not support tool-step");
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

  test("a run touching exactly the 30-file cap lands as one PatchEffect (boundary)", async () => {
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      const turns = messages.filter((m) => m.role === "assistant").length;
      if (turns < 30) {
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
    const patch = effects.find((e) => e.kind === "patch") as PatchEffect;
    expect(patch).toBeDefined();
    expect(patch.changes.length).toBe(30);
    expect(
      effects.find(
        (e) =>
          e.kind === "diagnostic" &&
          (e as DiagnosticEffect).code === "dome.agent.consolidate-overreach",
      ),
    ).toBeUndefined();
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

  test("consolidationLedgerPath validates config values and falls back instead of throwing", () => {
    expect(consolidationLedgerPath(undefined)).toEqual({
      path: "consolidation-ledger.md",
      problem: null,
    });
    expect(consolidationLedgerPath({})).toEqual({
      path: "consolidation-ledger.md",
      problem: null,
    });
    expect(
      consolidationLedgerPath({ consolidation_ledger_path: "notes/x.md" }),
    ).toEqual({ path: "notes/x.md", problem: null });

    // Malformed config degrades to the default with a diagnostic message —
    // a raw throw here would crash the nightly run.
    const cases: ReadonlyArray<[unknown, string]> = [
      [7, "must be a string"],
      ["ledger.txt", ".md path"],
      ["/abs/ledger.md", "relative vault markdown path"],
      ["../up/ledger.md", "relative vault markdown path"],
    ];
    for (const [value, fragment] of cases) {
      const resolved = consolidationLedgerPath({
        consolidation_ledger_path: value,
      });
      expect(resolved.path).toBe("consolidation-ledger.md");
      expect(resolved.problem).toContain(fragment);
      expect(resolved.problem).toContain("falling back to consolidation-ledger.md");
    }
  });

  test("a malformed ledger-path config does not crash the run: default path + config diagnostic", async () => {
    const seenTask: string[] = [];
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      seenTask.push(messages.find((m) => m.role === "user")?.content ?? "");
      const turns = messages.filter((m) => m.role === "assistant").length;
      if (turns === 0)
        return {
          toolCalls: [
            {
              id: "1",
              name: "writePage",
              input: { path: "consolidation-ledger.md", content: "# Ledger\n2026-06-09" },
            },
          ],
        };
      return { text: "done" };
    };
    const effects = await consolidate.run(
      makeCtx({
        files: { "index.md": "x" },
        extensionConfig: { consolidation_ledger_path: 7 },
        stepFn,
      }),
    );
    // The run proceeded against the DEFAULT ledger path.
    const patch = effects.find((e) => e.kind === "patch") as PatchEffect;
    expect(patch).toBeDefined();
    expect(patch.sourceRefs).toEqual([{ path: "consolidation-ledger.md" } as never]);
    expect(seenTask[0]).toContain("consolidation-ledger.md");
    // The malformed config surfaced as a warning diagnostic.
    const diag = effects.find(
      (e) =>
        e.kind === "diagnostic" &&
        (e as DiagnosticEffect).code === "dome.agent.consolidate-config-invalid",
    ) as DiagnosticEffect;
    expect(diag).toBeDefined();
    expect(diag.severity).toBe("warning");
    expect(diag.message).toContain("must be a string");
  });
});
