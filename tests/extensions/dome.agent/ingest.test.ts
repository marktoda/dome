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
  steps?: ReadonlyArray<ModelStepResult>;
  stepFn?: () => Promise<ModelStepResult>;
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
    extensionConfig: {},
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
});
