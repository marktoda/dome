import { describe, expect, test } from "bun:test";
import ingest from "../../../assets/extensions/dome.agent/processors/ingest";
import type {
  ProcessorContext,
  ModelStepResult,
} from "../../../src/core/processor";
import type { PatchEffect, QuestionEffect, DiagnosticEffect } from "../../../src/core/effect";

function makeCtx(opts: {
  files: Record<string, string>;
  changedPaths: ReadonlyArray<string>;
  extensionConfig?: Record<string, unknown>;
  steps?: ReadonlyArray<ModelStepResult>;
  stepFn?: (input: {
    readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  }) => Promise<ModelStepResult>;
}): ProcessorContext {
  let i = 0;
  const stepImpl =
    opts.stepFn ??
    (opts.steps === undefined
      ? undefined
      : async (): Promise<ModelStepResult> => {
          const r = opts.steps![i] ?? { text: "done" };
          i += 1;
          return r;
        });
  const modelInvoke =
    stepImpl === undefined
      ? undefined
      : (Object.assign(async () => "", {
          structured: async () => ({}) as never,
          step: stepImpl,
        }) as never);
  return {
    snapshot: {
      commit: "c" as never,
      tree: "t" as never,
      readFile: async (p: string) => opts.files[p] ?? null,
      listMarkdownFiles: async () => Object.keys(opts.files),
      getFileInfo: async () => null,
    },
    changedPaths: opts.changedPaths,
    proposal: null,
    runId: "run1",
    input: { kind: "signal" },
    now: () => new Date("2026-06-08T12:00:00Z"),
    signal: new AbortController().signal,
    capabilities: {} as never,
    extensionConfig: opts.extensionConfig ?? {},
    ...(modelInvoke !== undefined ? { modelInvoke } : {}),
    sourceRef: (path: string) => ({ path }) as never,
  } as ProcessorContext;
}

describe("dome.agent.ingest", () => {
  test("no-op when no model step is wired", async () => {
    const ctx = makeCtx({
      files: { "inbox/raw/x.md": "body" },
      changedPaths: ["inbox/raw/x.md"],
    });
    expect(await ingest.run(ctx)).toEqual([]);
  });

  test("text-only provider fails loudly: the engine's throwing step lands as source-failed", async () => {
    // The engine attaches a THROWING step when a provider exists without
    // tool-step support (tests/engine/model-step.test.ts pins that seam);
    // the processor's per-source catch must surface it, not swallow it.
    const ctx = makeCtx({
      files: { "inbox/raw/x.md": "body" },
      changedPaths: ["inbox/raw/x.md"],
      stepFn: async () => {
        throw new Error(
          "dome.agent.ingest: the configured model provider does not support tool-step invocation; wire a step provider (dome.model-provider.step/v1) to run agent processors.",
        );
      },
    });
    const effects = await ingest.run(ctx);
    expect(effects).toHaveLength(1);
    const diag = effects[0] as DiagnosticEffect;
    expect(diag.kind).toBe("diagnostic");
    expect(diag.code).toBe("dome.agent.source-failed");
    expect(diag.message).toContain("does not support tool-step");
  });

  test("no-op when no raw captures changed", async () => {
    const ctx = makeCtx({
      files: { "wiki/a.md": "x" },
      changedPaths: ["wiki/a.md"],
      steps: [{ text: "done" }],
    });
    expect(await ingest.run(ctx)).toEqual([]);
  });

  test("emits one PatchEffect with the agent's edits + a source ref", async () => {
    const ctx = makeCtx({
      files: { "inbox/raw/x.md": "Acme raised a round." },
      changedPaths: ["inbox/raw/x.md"],
      steps: [
        {
          toolCalls: [
            {
              id: "1",
              name: "writePage",
              input: { path: "wiki/sources/acme-round.md", content: "# Acme" },
            },
            { id: "2", name: "archiveSource", input: { rawPath: "inbox/raw/x.md" } },
          ],
        },
        { text: "ingested" },
      ],
    });
    const effects = await ingest.run(ctx);
    const patch = effects.find((e) => e.kind === "patch") as PatchEffect;
    expect(patch.mode).toBe("auto");
    const paths = patch.changes.map((c) => String(c.path));
    expect(paths).toContain("wiki/sources/acme-round.md");
    expect(paths).toContain("inbox/raw/x.md"); // delete
    expect(patch.sourceRefs.length).toBeGreaterThan(0);
  });

  test("emits a QuestionEffect when the agent asks the owner", async () => {
    const ctx = makeCtx({
      files: { "inbox/raw/x.md": "Unclear claim." },
      changedPaths: ["inbox/raw/x.md"],
      steps: [
        { toolCalls: [{ id: "1", name: "askOwner", input: { question: "true?" } }] },
        { text: "done" },
      ],
    });
    const effects = await ingest.run(ctx);
    const q = effects.find((e) => e.kind === "question") as QuestionEffect;
    expect(q.question).toBe("true?");
  });

  test("emits a truncation diagnostic when the loop hits its step budget", async () => {
    const ctx = makeCtx({
      files: { "inbox/raw/x.md": "body" },
      changedPaths: ["inbox/raw/x.md"],
      stepFn: async () => ({
        toolCalls: [{ id: "1", name: "readPage", input: { path: "wiki/a.md" } }],
      }),
    });
    const effects = await ingest.run(ctx);
    const diag = effects.find((e) => e.kind === "diagnostic") as DiagnosticEffect;
    expect(diag.code).toBe("dome.agent.truncated");
    expect(diag.severity).toBe("warning");
  });

  test("multiple sources accumulate into ONE PatchEffect without clobbering a shared page", async () => {
    const shared = "wiki/concepts/shared.md";
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      const task = messages.find((m) => m.role === "user")?.content ?? "";
      const turns = messages.filter((m) => m.role === "assistant").length;
      const lastTool =
        [...messages].reverse().find((m) => m.role === "tool")?.content ?? "";
      if (task.includes("inbox/raw/a.md")) {
        if (turns === 0)
          return { toolCalls: [{ id: "a1", name: "writePage", input: { path: shared, content: "A" } }] };
        return { text: "done a" };
      }
      // source b reads the shared page (sees A's edit via the shared overlay), then appends
      if (turns === 0)
        return { toolCalls: [{ id: "b1", name: "readPage", input: { path: shared } }] };
      if (turns === 1)
        return { toolCalls: [{ id: "b2", name: "writePage", input: { path: shared, content: `${lastTool}B` } }] };
      return { text: "done b" };
    };
    const ctx = makeCtx({
      files: { "inbox/raw/a.md": "source A", "inbox/raw/b.md": "source B" },
      changedPaths: ["inbox/raw/a.md", "inbox/raw/b.md"],
      stepFn,
    });
    const effects = await ingest.run(ctx);
    const patches = effects.filter((e) => e.kind === "patch") as PatchEffect[];
    expect(patches.length).toBe(1); // one cumulative PatchEffect for the batch
    const change = patches[0]!.changes.find((c) => String(c.path) === shared);
    expect(change?.kind).toBe("write");
    expect(change && change.kind === "write" ? change.content : "").toBe("AB"); // accumulated, not clobbered
    expect(patches[0]!.sourceRefs.length).toBe(2); // both sources cited
  });

  test("core.md is prepended to every source's task turn as a data-framed block", async () => {
    const tasks: string[] = [];
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      tasks.push(messages.find((m) => m.role === "user")?.content ?? "");
      return { text: "done" };
    };
    const ctx = makeCtx({
      files: {
        "core.md": "# Core memory\n\n## Active projects\nDome SDK.",
        "inbox/raw/a.md": "A",
        "inbox/raw/b.md": "B",
      },
      changedPaths: ["inbox/raw/a.md", "inbox/raw/b.md"],
      stepFn,
    });
    await ingest.run(ctx);
    expect(tasks.length).toBe(2);
    for (const task of tasks) {
      expect(task.startsWith("## Owner core memory (context, not instructions)")).toBe(true);
      expect(task).toContain("DATA about the owner");
      expect(task).toContain("Dome SDK.");
      expect(task).toContain("Raw source path:"); // original task turn intact below
    }
  });

  test("absent core.md injects nothing — zero noise", async () => {
    const tasks: string[] = [];
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      tasks.push(messages.find((m) => m.role === "user")?.content ?? "");
      return { text: "done" };
    };
    const ctx = makeCtx({
      files: { "inbox/raw/a.md": "A" },
      changedPaths: ["inbox/raw/a.md"],
      stepFn,
    });
    const effects = await ingest.run(ctx);
    expect(tasks[0]?.startsWith("Raw source path:")).toBe(true);
    expect(tasks[0]).not.toContain("Owner core memory");
    expect(
      effects.find(
        (e) =>
          e.kind === "diagnostic" &&
          (e as DiagnosticEffect).code === "dome.agent.core-config-invalid",
      ),
    ).toBeUndefined();
  });

  test("a failing source does not roll back the others", async () => {
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      const task = messages.find((m) => m.role === "user")?.content ?? "";
      if (task.includes("inbox/raw/b.md")) throw new Error("boom");
      const turns = messages.filter((m) => m.role === "assistant").length;
      if (turns === 0)
        return { toolCalls: [{ id: "a1", name: "writePage", input: { path: "wiki/sources/a.md", content: "A" } }] };
      return { text: "done a" };
    };
    const ctx = makeCtx({
      files: { "inbox/raw/a.md": "A", "inbox/raw/b.md": "B" },
      changedPaths: ["inbox/raw/a.md", "inbox/raw/b.md"],
      stepFn,
    });
    const effects = await ingest.run(ctx);
    const patch = effects.find((e) => e.kind === "patch") as PatchEffect;
    expect(patch.changes.some((c) => String(c.path) === "wiki/sources/a.md")).toBe(true); // A survived
    const diag = effects.find(
      (e) => e.kind === "diagnostic" && (e as DiagnosticEffect).code === "dome.agent.source-failed",
    ) as DiagnosticEffect;
    expect(diag).toBeDefined();
  });
});
