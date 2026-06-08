// dome.warden.integrity — unit tests with an INJECTED FAKE MODEL.
//
// The integrity warden is a garden-phase llm processor that judges each
// changed wiki markdown page for integrity issues (historical-as-ongoing,
// contradiction, self-corroboration, inference-as-fact) and emits a
// QuestionEffect per non-trivial finding. It must NEVER emit a FactEffect or
// a knowledge PatchEffect (wardens are questions-only). The durable artifact
// is the human/agent resolution, not the model's inference — so a rebuild-
// unsafe garden model processor only emits transient QuestionEffects.
//
// We inject a fake `ModelInvokeFn` via `makeProcessorContext({ modelInvoke })`
// so the tests are deterministic and never call a real model.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import integrity from "../../assets/extensions/dome.warden/processors/integrity";
import type { Effect, QuestionEffect } from "../../src/core/effect";
import { makeManualProposal } from "../../src/core/proposal";
import { commitOid } from "../../src/core/source-ref";
import {
  treeOid,
  type ModelInvokeFn,
  type ModelInvokeStructuredInput,
  type Snapshot,
} from "../../src/core/processor";
import { makeProcessorContext } from "../../src/processors/context";

const HEAD_COMMIT = commitOid("2222222222222222222222222222222222222222");

type Finding = {
  readonly kind: string;
  readonly claim: string;
  readonly severity: "low" | "medium" | "high";
  readonly confidence: number;
  readonly recommendedAnswer: string;
};

describe("dome.warden.integrity", () => {
  test("drops low-risk findings — only risk >= medium becomes a question", async () => {
    const effects = await runIntegrity({
      path: "wiki/concepts/x.md",
      content: "# X\n\nAn unsourced inference and another.\n",
      findings: [
        {
          kind: "inference-as-fact",
          claim: "An unsourced inference",
          severity: "low",
          confidence: 0.6,
          recommendedAnswer: "cite a source",
        },
        {
          kind: "self-corroborating",
          claim: "another",
          severity: "medium",
          confidence: 0.7,
          recommendedAnswer: "cite a source",
        },
      ],
    });
    const questions = effects.filter(isQuestion);
    expect(questions.length).toBe(1);
    expect(questions[0]?.metadata?.risk).toBe("medium");
  });

  test("high-severity finding on a people page → owner-needed QuestionEffect, content-hash idempotencyKey, no fact/patch", async () => {
    const path = "wiki/entities/danny.md";
    const content =
      "---\n" +
      "type: entity\n" +
      "---\n" +
      "# Danny\n\n" +
      "Danny is currently leading the migration (it shipped last quarter).\n";

    const effects = await runIntegrity({
      path,
      content,
      findings: [
        {
          kind: "historical-as-ongoing",
          claim: "Danny is currently leading the migration",
          severity: "high",
          confidence: 0.82,
          recommendedAnswer:
            "Reframe as a completed effort: the migration shipped last quarter.",
        },
      ],
    });

    const questions = effects.filter(isQuestion);
    expect(questions.length).toBe(1);
    const q = questions[0];
    if (q === undefined) throw new Error("expected a question");

    // Questions-only invariant: nothing durable.
    expect(effects.some((e) => e.kind === "fact")).toBe(false);
    expect(effects.some((e) => e.kind === "patch")).toBe(false);

    // People/management content → owner-needed.
    expect(q.metadata?.automationPolicy).toBe("owner-needed");
    expect(q.metadata?.risk).toBe("high");
    expect(typeof q.metadata?.confidence).toBe("number");
    expect(q.metadata?.recommendedAnswer).toContain("shipped last quarter");

    // Content-hash idempotencyKey scheme.
    const digest = createHash("sha256").update(content).digest("hex").slice(0, 12);
    expect(q.idempotencyKey).toBe(
      `dome.warden.integrity:${path}:${digest}:historical-as-ongoing`,
    );

    // Cites the page.
    expect(q.question).toContain(path);
    expect(q.sourceRefs.length).toBe(1);
    expect(q.sourceRefs[0]?.path as string).toBe(path);
  });

  test("non-people page → agent-safe QuestionEffect", async () => {
    const path = "wiki/concepts/migration.md";
    const content =
      "---\n" +
      "type: concept\n" +
      "---\n" +
      "# Migration\n\nThe migration is ongoing (it finished in March).\n";

    const effects = await runIntegrity({
      path,
      content,
      findings: [
        {
          kind: "historical-as-ongoing",
          claim: "The migration is ongoing",
          severity: "medium",
          confidence: 0.6,
          recommendedAnswer: "Reframe as completed: it finished in March.",
        },
      ],
    });

    const questions = effects.filter(isQuestion);
    expect(questions.length).toBe(1);
    expect(questions[0]?.metadata?.automationPolicy).toBe("agent-safe");
  });

  test("no findings → emits nothing", async () => {
    const effects = await runIntegrity({
      path: "wiki/concepts/migration.md",
      content: "# Migration\n\nClear, well-sourced content.\n",
      findings: [],
    });
    expect(effects.length).toBe(0);
  });

  test("ctx.modelInvoke unavailable → no-op (no model, nothing to review)", async () => {
    const path = "wiki/concepts/x.md";
    const ctx = makeProcessorContext({
      snapshot: fakeSnapshot({ path, content: "# X\n" }),
      changedPaths: [path],
      proposal: makeManualProposal({
        base: HEAD_COMMIT,
        head: HEAD_COMMIT,
        branch: "main",
      }),
      runId: "run-integrity-nomodel",
      signal: new AbortController().signal,
      input: { kind: "garden", matchedTriggers: [] } as unknown,
    });
    expect(await integrity.run(ctx)).toEqual([]);
  });

  test("ctx.modelInvoke granted but throws (no provider) → no-op, not a failed run", async () => {
    const path = "wiki/concepts/x.md";
    const throwingInvoke = Object.assign(
      async (): Promise<string> => {
        throw new Error("model.invoke granted but no model provider configured.");
      },
      {
        structured: async <T>(_input: ModelInvokeStructuredInput<T>): Promise<T> => {
          throw new Error(
            "model.invoke is granted but no model provider is configured.",
          );
        },
      },
    ) as ModelInvokeFn;
    const ctx = makeProcessorContext({
      snapshot: fakeSnapshot({ path, content: "# X\n" }),
      changedPaths: [path],
      proposal: makeManualProposal({
        base: HEAD_COMMIT,
        head: HEAD_COMMIT,
        branch: "main",
      }),
      runId: "run-integrity-noprovider",
      signal: new AbortController().signal,
      input: { kind: "garden", matchedTriggers: [] } as unknown,
      modelInvoke: throwingInvoke,
    });
    expect(await integrity.run(ctx)).toEqual([]);
  });

  test("same content twice → same idempotencyKey (settles by content hash)", async () => {
    const path = "wiki/entities/danny.md";
    const content =
      "---\ntype: entity\n---\n# Danny\n\nDanny is currently leading X (done).\n";
    const findings: ReadonlyArray<Finding> = [
      {
        kind: "historical-as-ongoing",
        claim: "Danny is currently leading X",
        severity: "high",
        confidence: 0.8,
        recommendedAnswer: "Reframe as completed.",
      },
    ];

    const first = (await runIntegrity({ path, content, findings })).filter(
      isQuestion,
    );
    const second = (await runIntegrity({ path, content, findings })).filter(
      isQuestion,
    );

    expect(first[0]?.idempotencyKey).toBe(second[0]?.idempotencyKey);
  });
});

async function runIntegrity(opts: {
  readonly path: string;
  readonly content: string;
  readonly findings: ReadonlyArray<Finding>;
}): Promise<ReadonlyArray<Effect>> {
  const ctx = makeProcessorContext({
    snapshot: fakeSnapshot(opts),
    changedPaths: [opts.path],
    proposal: makeManualProposal({
      base: HEAD_COMMIT,
      head: HEAD_COMMIT,
      branch: "main",
    }),
    runId: "run-integrity",
    signal: new AbortController().signal,
    input: { kind: "garden", matchedTriggers: [] } as unknown,
    modelInvoke: fakeModelInvoke(opts.findings),
  });
  return integrity.run(ctx);
}

function fakeSnapshot(opts: {
  readonly path: string;
  readonly content: string;
}): Snapshot {
  return Object.freeze({
    commit: HEAD_COMMIT,
    tree: treeOid("3333333333333333333333333333333333333333"),
    readFile: async (p: string) => (p === opts.path ? opts.content : null),
    listMarkdownFiles: async () => Object.freeze([opts.path]),
    getFileInfo: async (p: string) =>
      p === opts.path
        ? {
            lastChangedCommit: HEAD_COMMIT,
            lastChangedAt: "2026-05-28T12:00:00.000Z",
            lastHumanChangedAt: "2026-05-28T12:00:00.000Z",
          }
        : null,
  });
}

// A canned ModelInvokeFn: `.structured` routes the canned findings through the
// caller's own parse fn (matches the real model boundary, which validates the
// parsed value); the text-call form is unused by the warden.
function fakeModelInvoke(findings: ReadonlyArray<Finding>): ModelInvokeFn {
  const fn = async (): Promise<string> => {
    throw new Error("text invoke not used by integrity warden");
  };
  const structured = async <T,>(
    input: ModelInvokeStructuredInput<T>,
  ): Promise<T> => input.parse({ findings });
  return Object.assign(fn, { structured }) as ModelInvokeFn;
}

function isQuestion(effect: Effect): effect is QuestionEffect {
  return effect.kind === "question";
}
