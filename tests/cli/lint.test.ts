import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domeInit } from "../../src/cli/commands/init";
import { domeLint } from "../../src/cli/commands/lint";

function makeNoopMockModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: "lint complete" }],
      finishReason: { unified: "stop", raw: "end_turn" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

function readUserMessage(call: { prompt: ReadonlyArray<{ role: string; content: unknown }> }): string {
  const userMsg = call.prompt.find((m) => m.role === "user");
  if (!userMsg || !Array.isArray(userMsg.content)) return "";
  return userMsg.content
    .filter(
      (p): p is { type: "text"; text: string } =>
        typeof p === "object" && p !== null && (p as { type: string }).type === "text",
    )
    .map((p) => p.text)
    .join("");
}

describe("dome lint two-mode invocation", () => {
  test("propose mode (no --apply) does not trigger apply branch in the workflow", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-lint-propose-"));
    const target = join(base, "v");
    try {
      const initRes = await domeInit(target);
      expect(initRes.ok).toBe(true);

      const mock = makeNoopMockModel();
      const res = await domeLint(target, { model: mock, skipCommit: true });
      expect(res.ok).toBe(true);

      expect(mock.doGenerateCalls.length).toBeGreaterThanOrEqual(1);
      const user = readUserMessage(mock.doGenerateCalls[0]!);
      // Propose mode contract: the CLI passes "" to runWorkflowAtPath; the
      // agent loop substitutes a synthetic kickoff ("Begin.") for the empty
      // turn. The substantive guarantee is that the user message does NOT
      // carry an `apply <id>` dispatch token — that's what would route the
      // workflow into apply mode per src/prompts/builtin/lint.md §"Apply
      // mode" dispatch rule.
      expect(user.toLowerCase()).not.toContain("apply ");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("apply mode with one id sends 'apply H1' to the workflow", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-lint-apply-"));
    const target = join(base, "v");
    try {
      const initRes = await domeInit(target);
      expect(initRes.ok).toBe(true);

      const mock = makeNoopMockModel();
      const res = await domeLint(target, { model: mock, skipCommit: true }, ["H1"]);
      expect(res.ok).toBe(true);

      expect(mock.doGenerateCalls.length).toBeGreaterThanOrEqual(1);
      const user = readUserMessage(mock.doGenerateCalls[0]!);
      expect(user).toContain("apply H1");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("apply mode with multiple ids sends 'apply H1 H2' to the workflow", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-lint-multi-"));
    const target = join(base, "v");
    try {
      const initRes = await domeInit(target);
      expect(initRes.ok).toBe(true);

      const mock = makeNoopMockModel();
      const res = await domeLint(target, { model: mock, skipCommit: true }, ["H1", "H2"]);
      expect(res.ok).toBe(true);

      expect(mock.doGenerateCalls.length).toBeGreaterThanOrEqual(1);
      const user = readUserMessage(mock.doGenerateCalls[0]!);
      // Order-preserving join with single-space separator matches the
      // workflow prompt's apply-mode dispatch shape.
      expect(user).toContain("apply H1 H2");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("apply mode rejects empty id with validation error before workflow dispatch", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-lint-empty-"));
    const target = join(base, "v");
    try {
      const initRes = await domeInit(target);
      expect(initRes.ok).toBe(true);

      const mock = makeNoopMockModel();
      const res = await domeLint(target, { model: mock, skipCommit: true }, [""]);
      expect(res.ok).toBe(false);
      if (!res.ok && res.error.kind === "validation") {
        // Narrow to the validation variant so `.message` is in scope —
        // the CliError union includes shapes like `invariant-violated`
        // that carry `detail` instead of `message`.
        expect(res.error.message.toLowerCase()).toContain("non-empty");
      } else if (!res.ok) {
        throw new Error(`expected validation error, got: ${res.error.kind}`);
      }
      // No workflow dispatch happened — the mock model was never called.
      expect(mock.doGenerateCalls.length).toBe(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
