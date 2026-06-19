import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { runAgent } from "../../src/agent/agent";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import fs from "node:fs";

function fakeVault() {
  return {
    runView: async () => ({
      kind: "ok",
      structured: {
        data: {
          matches: [
            {
              title: "RH",
              path: "wiki/entities/robinhood-chain.md",
              snippet: "July 2026",
              sourceRefs: [
                { path: "wiki/entities/robinhood-chain.md", commit: "c1" },
              ],
            },
          ],
        },
      },
    }),
    readDocument: async (p: string) => ({
      path: p,
      commit: "c1",
      content: "Robinhood Chain launches July 2026.",
    }),
  } as never;
}

// Confirmed LanguageModelV3GenerateResult shape (ai@6, @ai-sdk/provider v3):
//   { content: LanguageModelV3Content[], finishReason: {unified, raw}, usage, warnings }
//   - tool-call content: {type:"tool-call", toolCallId, toolName, input: <stringified JSON>}
//   - final text content: {type:"text", text}
//   - finishReason.unified "tool-calls" triggers another step; "stop" ends.
//   - usage uses nested inputTokens/outputTokens objects.
const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function toolCallStep(toolName: string, input: unknown) {
  return {
    content: [
      {
        type: "tool-call" as const,
        toolCallId: `${toolName}-1`,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
    usage,
    warnings: [],
  };
}

function textStep(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "end_turn" },
    usage,
    warnings: [],
  };
}

async function tempVaultHandle() {
  const dir = mkdtempSync(join(tmpdir(), "dome-agent-loop-write-"));
  await git.init({ fs, dir, defaultBranch: "main" });
  await mkdir(join(dir, "wiki"), { recursive: true });
  await writeFile(join(dir, "wiki", "seed.md"), "# Seed\n", "utf8");
  await git.add({ fs, dir, filepath: "wiki/seed.md" });
  await git.commit({ fs, dir, message: "seed", author: { name: "t", email: "t@t" } });
  return {
    path: dir,
    runView: async () => ({ kind: "ok", structured: { data: { matches: [] } } }),
    readDocument: async () => null,
  } as never;
}

describe("runAgent write capability", () => {
  test("with allowWrite, a create_document tool-call writes + commits and surfaces in changes", async () => {
    const vault = await tempVaultHandle();
    // MockLanguageModelV3 returns doGenerate[doGenerateCalls.length] (after push),
    // so index 0 is never returned — the array is 1-indexed in practice.
    const model = new MockLanguageModelV3({
      doGenerate: [
        toolCallStep("search_vault", { text: "placeholder" }), // index 0: never returned
        toolCallStep("create_document", { path: "wiki/made.md", content: "# Made\n" }),
        textStep("Created the page."),
      ],
    });
    const result = await runAgent({ vault, question: "make a page", model, allowWrite: true });
    expect(result.changes).toEqual([{ path: "wiki/made.md", kind: "create" }]);
    expect(await readFile(join((vault as unknown as { path: string }).path, "wiki/made.md"), "utf8")).toBe("# Made\n");
  });

  test("without allowWrite, the write tools are absent (read-only); changes is empty", async () => {
    const vault = await tempVaultHandle();
    // MockLanguageModelV3 uses 1-indexed access (doGenerate[doGenerateCalls.length]);
    // index 0 is never returned, so pad with a dummy.
    const model = new MockLanguageModelV3({ doGenerate: [textStep("pad"), textStep("nothing to do")] });
    const result = await runAgent({ vault, question: "hi", model });
    expect(result.changes).toEqual([]);
  });
});

describe("runAgent", () => {
  test("drives the AI SDK loop through tools and returns answer + citations", async () => {
    // Step 1: model calls search_vault. Step 2: model calls read_document.
    // Step 3: model emits final text. (The SDK collapses the trailing tool-call
    // + final text into the same step group, so steps.length lands at 2 — what
    // matters here is the grounded answer + the citations the tools recorded.)
    const model = new MockLanguageModelV3({
      doGenerate: [
        toolCallStep("search_vault", { text: "robinhood launch" }),
        toolCallStep("read_document", {
          path: "wiki/entities/robinhood-chain.md",
        }),
        textStep("Robinhood Chain launches in early July 2026."),
      ],
    });

    const result = await runAgent({
      vault: fakeVault(),
      model,
      question: "When does Robinhood Chain launch?",
      maxSteps: 6,
    });

    expect(result.answer).toContain("July 2026");
    expect(result.citations.map((c) => c.path)).toContain(
      "wiki/entities/robinhood-chain.md",
    );
    expect(result.stopReason).toBe("final");
    expect(result.steps).toBeGreaterThanOrEqual(2);
  });

  test("returns stopReason=budget and a non-empty answer when the step cap fires mid-loop", async () => {
    // A model that always returns a tool-call and never a final text, so
    // generateText will exhaust maxSteps without hitting "stop".
    const model = new MockLanguageModelV3({
      doGenerate: [
        toolCallStep("search_vault", { text: "anything" }),
        toolCallStep("search_vault", { text: "still going" }),
        // Extra entry so MockLanguageModelV3 doesn't run out before maxSteps.
        toolCallStep("search_vault", { text: "one more" }),
      ],
    });

    const result = await runAgent({
      vault: fakeVault(),
      model,
      question: "Does this answer exist?",
      maxSteps: 2,
    });

    expect(result.stopReason).toBe("budget");
    // Graceful fallback must produce a non-empty string.
    expect(typeof result.answer).toBe("string");
    expect(result.answer.trim().length).toBeGreaterThan(0);
  });
});
