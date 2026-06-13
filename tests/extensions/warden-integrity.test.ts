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
import type { Effect, FactEffect, QuestionEffect } from "../../src/core/effect";
import { makeManualProposal } from "../../src/core/proposal";
import { commitOid } from "../../src/core/source-ref";
import {
  treeOid,
  type ModelInvokeFn,
  type ModelInvokeStructuredInput,
  type ProjectionQueryView,
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
    // Uses historical-as-ongoing (an un-suppressed class): the severity gate is
    // what this test exercises. The noisy classes (self-corroborating /
    // inference-as-fact) are gated separately by the collision pre-filter — see
    // the suppression tests below.
    const effects = await runIntegrity({
      path: "wiki/concepts/x.md",
      content: "# X\n\nAn event framed as ongoing and another.\n",
      findings: [
        {
          kind: "historical-as-ongoing",
          claim: "An event framed as ongoing",
          severity: "low",
          confidence: 0.6,
          recommendedAnswer: "reframe as completed",
        },
        {
          kind: "historical-as-ongoing",
          claim: "another",
          severity: "medium",
          confidence: 0.7,
          recommendedAnswer: "reframe as completed",
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

  test("model_override routes every structured call", async () => {
    const path = "wiki/concepts/x.md";
    const seen: Array<string | undefined> = [];
    const structured = async <T,>(
      input: ModelInvokeStructuredInput<T>,
    ): Promise<T> => {
      seen.push(input.model);
      return input.parse({ findings: [] });
    };
    const modelInvoke = Object.assign(
      async (): Promise<string> => {
        throw new Error("text invoke not used by integrity warden");
      },
      { structured },
    ) as ModelInvokeFn;
    const effects = await integrity.run(
      makeProcessorContext({
        snapshot: fakeSnapshot({ path, content: "# X\n" }),
        changedPaths: [path],
        proposal: makeManualProposal({
          base: HEAD_COMMIT,
          head: HEAD_COMMIT,
          branch: "main",
        }),
        runId: "run-integrity-model-override",
        signal: new AbortController().signal,
        input: { kind: "garden", matchedTriggers: [] } as unknown,
        modelInvoke,
        extensionConfig: { model_override: "claude-haiku-4-5" },
      }),
    );
    expect(seen).toEqual(["claude-haiku-4-5"]);
    expect(effects).toEqual([]);
  });

  test("malformed model_override degrades to the provider default with ONE warning", async () => {
    const path = "wiki/concepts/x.md";
    const seen: Array<string | undefined> = [];
    const structured = async <T,>(
      input: ModelInvokeStructuredInput<T>,
    ): Promise<T> => {
      seen.push(input.model);
      return input.parse({ findings: [] });
    };
    const modelInvoke = Object.assign(
      async (): Promise<string> => {
        throw new Error("text invoke not used by integrity warden");
      },
      { structured },
    ) as ModelInvokeFn;
    const effects = await integrity.run(
      makeProcessorContext({
        snapshot: fakeSnapshot({ path, content: "# X\n" }),
        changedPaths: [path],
        proposal: makeManualProposal({
          base: HEAD_COMMIT,
          head: HEAD_COMMIT,
          branch: "main",
        }),
        runId: "run-integrity-model-override-bad",
        signal: new AbortController().signal,
        input: { kind: "garden", matchedTriggers: [] } as unknown,
        modelInvoke,
        extensionConfig: { model_override: 42 },
      }),
    );
    // Degrade, not crash: the review still ran on the provider default.
    expect(seen).toEqual([undefined]);
    const diags = effects.filter((e) => e.kind === "diagnostic");
    expect(diags).toHaveLength(1);
    const diag = diags[0] as { code: string; severity: string; message: string };
    expect(diag.code).toBe("dome.warden.model-config-invalid");
    expect(diag.severity).toBe("warning");
    expect(diag.message).toContain("model_override");
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

  // ----- Claims-fact contradiction pre-filter (Task 2) --------------------

  test("a real key-collision contradiction in claims facts surfaces a question — even when the model finds nothing", async () => {
    const path = "wiki/concepts/migration.md";
    const content =
      "# Migration\n\n" +
      "- **Status:** active\n" +
      "- **Status:** shipped\n";
    const effects = await runIntegrity({
      path,
      content,
      findings: [],
      claimFacts: [
        claimFact(path, "Status", "active"),
        claimFact(path, "Status", "shipped"),
      ],
    });
    const questions = effects.filter(isQuestion);
    expect(questions.length).toBe(1);
    const q = questions[0];
    if (q === undefined) throw new Error("expected a contradiction question");
    expect(q.metadata?.risk).toBe("high");
    expect(q.question.toLowerCase()).toContain("contradiction");
    expect(q.question).toContain("Status");
    // Questions-only: no fact/patch.
    expect(effects.some((e) => e.kind === "fact")).toBe(false);
    expect(effects.some((e) => e.kind === "patch")).toBe(false);
    // Deterministic idempotencyKey keyed on the contradicted claim key.
    expect(q.idempotencyKey).toContain("dome.warden.integrity:");
    expect(q.idempotencyKey).toContain(":claim-collision:");
  });

  test("same key with one consistent value is NOT a collision — no question", async () => {
    const path = "wiki/concepts/migration.md";
    const effects = await runIntegrity({
      path,
      content: "# Migration\n\n- **Status:** shipped\n- **Status:** shipped\n",
      findings: [],
      claimFacts: [
        claimFact(path, "Status", "shipped"),
        claimFact(path, "Status", "shipped"),
      ],
    });
    expect(effects.filter(isQuestion).length).toBe(0);
  });

  test("legitimate non-contradictory prose: a self-corroborating finding is suppressed without a collision backing", async () => {
    const path = "wiki/concepts/x.md";
    const effects = await runIntegrity({
      path,
      content: "# X\n\nA claim supported only by this vault.\n",
      findings: [
        {
          kind: "self-corroborating",
          claim: "A claim supported only by this vault",
          severity: "medium",
          confidence: 0.9,
          recommendedAnswer: "cite an external source",
        },
        {
          kind: "inference-as-fact",
          claim: "An inferred fact",
          severity: "high",
          confidence: 0.9,
          recommendedAnswer: "mark as inference",
        },
      ],
      claimFacts: [],
    });
    // Both noisy-class findings are suppressed: no collision backs them.
    expect(effects.filter(isQuestion).length).toBe(0);
  });

  test("a self-corroborating finding IS surfaced when a collision on the page backs it", async () => {
    const path = "wiki/concepts/x.md";
    const effects = await runIntegrity({
      path,
      content:
        "# X\n\n- **Owner:** Ada\n- **Owner:** Grace\n\nA self-cited claim.\n",
      findings: [
        {
          kind: "self-corroborating",
          claim: "A self-cited claim",
          severity: "medium",
          confidence: 0.9,
          recommendedAnswer: "cite an external source",
        },
      ],
      claimFacts: [
        claimFact(path, "Owner", "Ada"),
        claimFact(path, "Owner", "Grace"),
      ],
    });
    const questions = effects.filter(isQuestion);
    // The deterministic collision question + the now-unsuppressed self-corroborating finding.
    const kinds = questions.map((q) => q.idempotencyKey);
    expect(kinds.some((k) => k.includes(":claim-collision:"))).toBe(true);
    expect(kinds.some((k) => k.includes(":self-corroborating"))).toBe(true);
  });

  test("confidence below the floor → no question (model finding gated out)", async () => {
    const path = "wiki/concepts/x.md";
    const effects = await runIntegrity({
      path,
      content: "# X\n\nAn event framed as ongoing.\n",
      findings: [
        {
          kind: "historical-as-ongoing",
          claim: "An event framed as ongoing",
          severity: "high",
          confidence: 0.3,
          recommendedAnswer: "reframe as completed",
        },
      ],
      config: { question_confidence_floor: 0.6 },
    });
    expect(effects.filter(isQuestion).length).toBe(0);
  });

  test("confidence at/above the configured floor → question surfaces", async () => {
    const path = "wiki/concepts/x.md";
    const effects = await runIntegrity({
      path,
      content: "# X\n\nAn event framed as ongoing.\n",
      findings: [
        {
          kind: "historical-as-ongoing",
          claim: "An event framed as ongoing",
          severity: "high",
          confidence: 0.75,
          recommendedAnswer: "reframe as completed",
        },
      ],
      config: { question_confidence_floor: 0.7 },
    });
    expect(effects.filter(isQuestion).length).toBe(1);
  });

  test("malformed question_confidence_floor → conservative default + ONE warning, review still runs", async () => {
    const path = "wiki/concepts/x.md";
    const effects = await runIntegrity({
      path,
      content: "# X\n\nAn event framed as ongoing.\n",
      findings: [
        {
          kind: "historical-as-ongoing",
          claim: "An event framed as ongoing",
          severity: "high",
          confidence: 0.9,
          recommendedAnswer: "reframe as completed",
        },
      ],
      config: { question_confidence_floor: "nonsense" },
    });
    const diags = effects.filter((e) => e.kind === "diagnostic");
    expect(diags).toHaveLength(1);
    const diag = diags[0] as { code: string; severity: string; message: string };
    expect(diag.code).toBe("dome.warden.confidence-config-invalid");
    expect(diag.severity).toBe("warning");
    expect(diag.message).toContain("question_confidence_floor");
    // Degrade-not-crash: a high-confidence finding still surfaces under the default floor.
    expect(effects.filter(isQuestion).length).toBe(1);
  });
});

async function runIntegrity(opts: {
  readonly path: string;
  readonly content: string;
  readonly findings: ReadonlyArray<Finding>;
  readonly claimFacts?: ReadonlyArray<FactEffect>;
  readonly config?: Record<string, unknown>;
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
    ...(opts.claimFacts !== undefined
      ? { projection: fakeProjection(opts.claimFacts) }
      : {}),
    ...(opts.config !== undefined ? { extensionConfig: opts.config } : {}),
  });
  return integrity.run(ctx);
}

/** A `dome.claims.claim` fact: object is canonical JSON {key, value, asOf?}. */
function claimFact(path: string, key: string, value: string): FactEffect {
  return {
    kind: "fact",
    subject: { kind: "page", path },
    predicate: "dome.claims.claim",
    object: { kind: "string", value: JSON.stringify({ key, value }) },
    assertion: "extracted",
    sourceRefs: [{ path } as unknown],
  } as unknown as FactEffect;
}

/** Minimal projection that filters facts by predicate, mirroring the runtime. */
function fakeProjection(facts: ReadonlyArray<FactEffect>): ProjectionQueryView {
  return {
    facts: (filter?: { readonly predicate?: string }) =>
      facts.filter(
        (f) =>
          filter?.predicate === undefined || f.predicate === filter.predicate,
      ),
    diagnostics: () => [],
    questions: () => [],
    searchDocuments: () => [],
    documentsByPath: () => [],
  } as unknown as ProjectionQueryView;
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
