// dome.warden.integrity-answer — unit test for the resolution router.
//
// The answer-handler is a garden-phase NORMAL (no-model) processor triggered
// by `kind: answer` on dome.warden.integrity questions. It parses
// `ctx.input` = { question, answer } and routes the resolution. The durable
// answer already persists in answers.db; this handler exists so the question
// lifecycle closes. For v1 it acknowledges with an info diagnostic.

import { describe, expect, test } from "bun:test";

import integrityAnswer from "../../assets/extensions/dome.warden/processors/integrity-answer";
import type { DiagnosticEffect, Effect } from "../../src/core/effect";
import { makeManualProposal } from "../../src/core/proposal";
import { commitOid } from "../../src/core/source-ref";
import { treeOid, type Snapshot } from "../../src/core/processor";
import { makeProcessorContext } from "../../src/processors/context";

const HEAD_COMMIT = commitOid("2222222222222222222222222222222222222222");

describe("dome.warden.integrity-answer", () => {
  test("parses { question, answer } and routes without error", async () => {
    const effects = await runAnswer({
      question: {
        idempotencyKey:
          "dome.warden.integrity:wiki/entities/danny.md:abc123abc123:historical-as-ongoing",
        sourceRefs: [],
      },
      answer: "Reframed the claim as a completed effort.",
    });

    // Minimal-but-real: no throw, no fact/patch, an info diagnostic at most.
    expect(effects.some((e) => e.kind === "fact")).toBe(false);
    expect(effects.some((e) => e.kind === "patch")).toBe(false);
    for (const e of effects) {
      expect(e.kind).toBe("diagnostic");
      expect((e as DiagnosticEffect).severity).toBe("info");
    }
  });

  test("invalid answer envelope → does not throw", async () => {
    const effects = await runAnswer({ not: "a valid envelope" } as unknown);
    expect(Array.isArray(effects)).toBe(true);
  });
});

async function runAnswer(input: unknown): Promise<ReadonlyArray<Effect>> {
  const snapshot: Snapshot = Object.freeze({
    commit: HEAD_COMMIT,
    tree: treeOid("3333333333333333333333333333333333333333"),
    readFile: async () => null,
    listMarkdownFiles: async () => Object.freeze([]),
    getFileInfo: async () => null,
  });
  const ctx = makeProcessorContext({
    snapshot,
    changedPaths: [],
    proposal: makeManualProposal({
      base: HEAD_COMMIT,
      head: HEAD_COMMIT,
      branch: "main",
    }),
    runId: "run-integrity-answer",
    signal: new AbortController().signal,
    input,
  });
  return integrityAnswer.run(ctx);
}
