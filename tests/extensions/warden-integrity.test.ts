// dome.warden.integrity — unit tests with an INJECTED FAKE MODEL.
//
// The integrity warden is a garden-phase llm processor that judges each
// changed wiki markdown page for integrity issues (historical-as-ongoing,
// contradiction, self-corroboration, inference-as-fact) and emits a
// DiagnosticEffect per non-trivial finding. It must NEVER emit a FactEffect or
// a knowledge PatchEffect (wardens are diagnostics-only, no-graph-write).
// Deterministic claim-collisions are surfaced as "warning" diagnostics with
// code `dome.warden.integrity.claim-collision`; model findings are risk-mapped
// (high → "warning", else "info") with code `dome.warden.integrity.<kind>`.
// Diagnostics self-clear via `resolveStaleDiagnostics` when the page is
// reconciled — there is no answer-handler or automation policy.
//
// We inject a fake `ModelInvokeFn` via `makeProcessorContext({ modelInvoke })`
// so the tests are deterministic and never call a real model.

import { describe, expect, test } from "bun:test";

import integrity from "../../assets/extensions/dome.warden/processors/integrity";
import type { DiagnosticEffect, Effect, FactEffect } from "../../src/core/effect";
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
    const diagnostics = effects.filter(isDiagnostic);
    expect(diagnostics.length).toBe(1);
    // medium risk → info severity
    expect(diagnostics[0]?.severity).toBe("info");
    expect(effects.some((e) => e.kind === "question")).toBe(false);
  });

  test("high-severity finding → warning DiagnosticEffect, no question/fact/patch", async () => {
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

    const diagnostics = effects.filter(isDiagnostic);
    expect(diagnostics.length).toBe(1);
    const d = diagnostics[0];
    if (d === undefined) throw new Error("expected a diagnostic");
    expect(effects.some((e) => e.kind === "question")).toBe(false);
    expect(effects.some((e) => e.kind === "fact")).toBe(false);
    expect(effects.some((e) => e.kind === "patch")).toBe(false);
    expect(d.severity).toBe("warning"); // high risk → warning
    expect(d.code).toBe("dome.warden.integrity.historical-as-ongoing");
    expect(d.message).toContain(path);
    expect(d.message).toContain("shipped last quarter"); // folded recommendedAnswer
    expect(d.sourceRefs.length).toBe(1);
    expect(d.sourceRefs[0]?.path as string).toBe(path);
  });

  test("deterministic claim-collision → warning diagnostic", async () => {
    // Reuse this file's collision fixture (a page with two conflicting claim
    // values for the same key). Build ctx as the other tests do, with
    // ctx.projection.facts returning the colliding CLAIM_PREDICATE facts.
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
    const collisions = effects.filter(isDiagnostic).filter(
      (d) => d.code === "dome.warden.integrity.claim-collision",
    );
    expect(collisions.length).toBe(1);
    expect(collisions[0]?.severity).toBe("warning");
    expect(effects.some((e) => e.kind === "question")).toBe(false);
  });

  test("two distinct colliding keys on one page → two separate collision diagnostics with distinct stableIds", async () => {
    // Regression guard: before the per-key stableId fix, multiple collisions on
    // the same page shared a page-level subject_hash, so only the first
    // survived the INSERT OR IGNORE dedup. Each collision must now carry a
    // per-key stableId so the projection can distinguish them.
    const path = "wiki/concepts/migration.md";
    const content =
      "# Migration\n\n" +
      "- **Status:** active\n" +
      "- **Status:** shipped\n" +
      "- **Owner:** Ada\n" +
      "- **Owner:** Grace\n";
    const effects = await runIntegrity({
      path,
      content,
      findings: [],
      claimFacts: [
        claimFact(path, "Status", "active"),
        claimFact(path, "Status", "shipped"),
        claimFact(path, "Owner", "Ada"),
        claimFact(path, "Owner", "Grace"),
      ],
    });
    const collisions = effects.filter(
      (e): e is DiagnosticEffect =>
        e.kind === "diagnostic" &&
        (e as DiagnosticEffect).code === "dome.warden.integrity.claim-collision",
    );
    expect(collisions.length).toBe(2);
    // distinct stableIds — one per colliding key
    const stableIds = collisions.map((c) => c.sourceRefs[0]?.stableId).sort();
    expect(new Set(stableIds).size).toBe(2);
    expect(effects.some((e) => e.kind === "question")).toBe(false);
  });

  test("two same-kind model findings on one page → two diagnostics with distinct stableIds", async () => {
    // Fidelity guard: model findings of the same kind on one page share a
    // `dome.warden.integrity.<kind>` code; without a per-finding stableId they
    // also share a page-level subject_hash, so the projection's INSERT OR
    // IGNORE dedup collapses them to one row. Each distinct finding must carry
    // its own stableId so both survive.
    const path = "wiki/entities/danny.md";
    const content =
      "---\ntype: entity\n---\n# Danny\n\nTwo separate stale framings live here.\n";
    const effects = await runIntegrity({
      path,
      content,
      findings: [
        {
          kind: "historical-as-ongoing",
          claim: "Danny is leading the migration",
          severity: "high",
          confidence: 0.9,
          recommendedAnswer: "Reframe: the migration shipped.",
        },
        {
          kind: "historical-as-ongoing",
          claim: "Danny is onboarding the new hire",
          severity: "high",
          confidence: 0.9,
          recommendedAnswer: "Reframe: onboarding completed.",
        },
      ],
    });
    const diags = effects.filter(
      (e): e is DiagnosticEffect =>
        e.kind === "diagnostic" &&
        (e as DiagnosticEffect).code ===
          "dome.warden.integrity.historical-as-ongoing",
    );
    expect(diags.length).toBe(2);
    const stableIds = diags.map((d) => d.sourceRefs[0]?.stableId).sort();
    expect(new Set(stableIds).size).toBe(2);
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
      (e) => e.kind === "diagnostic",
    );
    const second = (await runIntegrity({ path, content, findings })).filter(
      (e) => e.kind === "diagnostic",
    );

    // Diagnostics are deterministic: same content → same code and message.
    expect(first[0]?.code).toBe(second[0]?.code);
    expect(first[0]?.message).toBe(second[0]?.message);
  });

  // ----- Claims-fact contradiction pre-filter (Task 2) --------------------

  test("a real key-collision contradiction in claims facts surfaces a diagnostic — even when the model finds nothing", async () => {
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
    const collisions = effects.filter(isDiagnostic).filter(
      (d) => d.code === "dome.warden.integrity.claim-collision",
    );
    expect(collisions.length).toBe(1);
    const d = collisions[0];
    if (d === undefined) throw new Error("expected a contradiction diagnostic");
    expect(d.severity).toBe("warning");
    expect(d.message.toLowerCase()).toContain("contradiction");
    expect(d.message).toContain("Status");
    // No fact/patch.
    expect(effects.some((e) => e.kind === "fact")).toBe(false);
    expect(effects.some((e) => e.kind === "patch")).toBe(false);
  });

  test("same key with one consistent value is NOT a collision — no diagnostic", async () => {
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
    expect(effects.filter((e) => e.kind === "diagnostic").length).toBe(0);
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
    expect(effects.filter((e) => e.kind === "diagnostic").length).toBe(0);
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
    const diagnostics = effects.filter(isDiagnostic);
    // The deterministic collision diagnostic + the now-unsuppressed self-corroborating finding.
    const codes = diagnostics.map((d) => d.code);
    expect(codes.some((c) => c === "dome.warden.integrity.claim-collision")).toBe(true);
    expect(codes.some((c) => c === "dome.warden.integrity.self-corroborating")).toBe(true);
  });

  test("confidence below the floor → no diagnostic (model finding gated out)", async () => {
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
    expect(effects.filter((e) => e.kind === "diagnostic").length).toBe(0);
  });

  test("confidence at/above the configured floor → diagnostic surfaces", async () => {
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
    expect(effects.filter((e) => e.kind === "diagnostic").length).toBe(1);
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
    const diags = effects.filter(isDiagnostic);
    // One config-invalid warning + one finding diagnostic.
    const configDiag = diags.find((d) => d.code === "dome.warden.confidence-config-invalid");
    if (configDiag === undefined) throw new Error("expected config-invalid diagnostic");
    expect(configDiag.code).toBe("dome.warden.confidence-config-invalid");
    expect(configDiag.severity).toBe("warning");
    expect(configDiag.message).toContain("question_confidence_floor");
    // Degrade-not-crash: a high-confidence finding still surfaces under the default floor.
    expect(diags.filter((d) => d.code !== "dome.warden.confidence-config-invalid").length).toBe(1);
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

function isDiagnostic(effect: Effect): effect is DiagnosticEffect {
  return effect.kind === "diagnostic";
}
