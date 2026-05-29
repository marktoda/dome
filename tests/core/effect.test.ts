// Smoke tests for src/core/effect.ts: the eleven-kind Effect union — each
// kind's per-schema parse, the discriminated-union EffectSchema parse, the
// FactEffect semantic refinements, and the constructor freeze + kind-stamp
// invariants.

import { describe, test, expect } from "bun:test";
import {
  EffectSchema,
  FactEffectSchema,
  diagnosticEffect,
  externalActionEffect,
  factEffect,
  jobEffect,
  outboxRecoveryEffect,
  patchEffect,
  quarantineRecoveryEffect,
  questionEffect,
  runRecoveryEffect,
  searchDocumentEffect,
  viewEffect,
  type Effect,
} from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";

const ref = sourceRef({ commit: commitOid("abc"), path: "wiki/x.md" });
const refs = [ref] as const;

// Minimum-valid effect constructors per kind. Used both for round-trip
// schema parsing and the exhaustive-routing self-test below.
const minEffects = {
  patch: () =>
    patchEffect({
      mode: "auto",
      changes: [
        { kind: "write", path: "wiki/x.md", content: "hello\n" },
      ],
      reason: "fix",
      sourceRefs: refs,
    }),
  diagnostic: () =>
    diagnosticEffect({
      severity: "info",
      code: "smoke",
      message: "ok",
      sourceRefs: refs,
    }),
  fact: () =>
    factEffect({
      subject: { kind: "page", path: "wiki/x.md" },
      predicate: "dome.tasks.dueDate",
      object: { kind: "string", value: "2026-01-01" },
      assertion: "explicit",
      sourceRefs: refs,
    }),
  "search-document": () =>
    searchDocumentEffect({
      operation: "upsert",
      path: "wiki/x.md",
      category: "wiki",
      title: "x",
      body: "hello",
      sourceRefs: refs,
    }),
  question: () =>
    questionEffect({
      question: "ok?",
      sourceRefs: refs,
      idempotencyKey: "q-1",
    }),
  job: () =>
    jobEffect({
      processorId: "dome.test",
      input: null,
      idempotencyKey: "j-1",
    }),
  external: () =>
    externalActionEffect({
      capability: "calendar.write",
      idempotencyKey: "e-1",
      payload: { event: "x" },
      sourceRefs: refs,
    }),
  "outbox-recovery": () =>
    outboxRecoveryEffect({
      action: "retry",
      idempotencyKey: "e-1",
      reason: "recover failed outbox row",
      sourceRefs: refs,
    }),
  "quarantine-recovery": () =>
    quarantineRecoveryEffect({
      action: "reset",
      phase: "garden",
      processorId: "dome.test",
      processorVersion: "0.1.0",
      triggerHash: "trigger-1",
      quarantineId: "quarantine-1",
      quarantinedAt: "2026-05-29T00:00:00.000Z",
      consecutiveRetryableFailures: 3,
      reason: "retry quarantined processor",
      sourceRefs: refs,
    }),
  "run-recovery": () =>
    runRecoveryEffect({
      action: "fail",
      runId: "run_1_orphan",
      startedAt: "2026-05-29T00:00:00.000Z",
      processorId: "dome.test",
      processorVersion: "0.1.0",
      phase: "garden",
      reason: "fail orphan run",
      sourceRefs: refs,
    }),
  view: () =>
    viewEffect({
      name: "test",
      content: { kind: "markdown", body: "# hi" },
      scope: refs,
    }),
} as const;

describe("per-kind schema round-trip + EffectSchema parse", () => {
  test("PatchEffect", () => {
    const e = minEffects.patch();
    expect(EffectSchema.parse(e).kind).toBe("patch");
  });

  test("PatchEffect canonicalizes file paths", () => {
    const parsed = EffectSchema.parse({
      kind: "patch",
      mode: "auto",
      changes: [{ kind: "write", path: "wiki//x.md", content: "hello\n" }],
      reason: "fix",
      sourceRefs: refs,
    });
    expect(parsed.kind).toBe("patch");
    if (parsed.kind !== "patch") return;
    expect(parsed.changes[0]?.path as string | undefined).toBe("wiki/x.md");
  });

  test("PatchEffect rejects path traversal", () => {
    expect(() =>
      EffectSchema.parse({
        kind: "patch",
        mode: "auto",
        changes: [{ kind: "write", path: "../secret.md", content: "x\n" }],
        reason: "fix",
        sourceRefs: refs,
      }),
    ).toThrow(/vault-relative/);
  });

  test("DiagnosticEffect", () => {
    const e = minEffects.diagnostic();
    expect(EffectSchema.parse(e).kind).toBe("diagnostic");
  });

  test("FactEffect", () => {
    const e = minEffects.fact();
    expect(EffectSchema.parse(e).kind).toBe("fact");
  });

  test("SearchDocumentEffect", () => {
    const e = minEffects["search-document"]();
    expect(EffectSchema.parse(e).kind).toBe("search-document");
  });

  test("FactEffect rejects invalid page NodeRef paths", () => {
    expect(() =>
      EffectSchema.parse({
        kind: "fact",
        subject: { kind: "page", path: "../secret.md" },
        predicate: "dome.tasks.dueDate",
        object: { kind: "string", value: "v" },
        assertion: "explicit",
        sourceRefs: refs,
      }),
    ).toThrow(/vault-relative/);
  });

  test("QuestionEffect", () => {
    const e = minEffects.question();
    expect(EffectSchema.parse(e).kind).toBe("question");
  });

  test("JobEffect", () => {
    const e = minEffects.job();
    expect(EffectSchema.parse(e).kind).toBe("job");
  });

  test("ExternalActionEffect", () => {
    const e = minEffects.external();
    expect(EffectSchema.parse(e).kind).toBe("external");
  });

  test("OutboxRecoveryEffect", () => {
    const e = minEffects["outbox-recovery"]();
    expect(EffectSchema.parse(e).kind).toBe("outbox-recovery");
  });

  test("QuarantineRecoveryEffect", () => {
    const e = minEffects["quarantine-recovery"]();
    expect(EffectSchema.parse(e).kind).toBe("quarantine-recovery");
  });

  test("RunRecoveryEffect", () => {
    const e = minEffects["run-recovery"]();
    expect(EffectSchema.parse(e).kind).toBe("run-recovery");
  });

  test("ViewEffect", () => {
    const e = minEffects.view();
    expect(EffectSchema.parse(e).kind).toBe("view");
  });
});

describe("FactEffectSchema refinements", () => {
  test("rejects when sourceRefs is empty", () => {
    expect(() =>
      FactEffectSchema.parse({
        kind: "fact",
        subject: { kind: "page", path: "wiki/x.md" },
        predicate: "dome.tasks.dueDate",
        object: { kind: "string", value: "v" },
        assertion: "explicit",
        sourceRefs: [],
      }),
    ).toThrow();
  });

  test("rejects when assertion='inferred' without confidence", () => {
    expect(() =>
      FactEffectSchema.parse({
        kind: "fact",
        subject: { kind: "page", path: "wiki/x.md" },
        predicate: "dome.tasks.dueDate",
        object: { kind: "string", value: "v" },
        assertion: "inferred",
        sourceRefs: [ref],
      }),
    ).toThrow();
  });

  test("rejects when assertion='generated' without confidence", () => {
    expect(() =>
      FactEffectSchema.parse({
        kind: "fact",
        subject: { kind: "page", path: "wiki/x.md" },
        predicate: "dome.tasks.dueDate",
        object: { kind: "string", value: "v" },
        assertion: "generated",
        sourceRefs: [ref],
      }),
    ).toThrow();
  });

  test("accepts assertion='explicit' without confidence", () => {
    const parsed = FactEffectSchema.parse({
      kind: "fact",
      subject: { kind: "page", path: "wiki/x.md" },
      predicate: "dome.tasks.dueDate",
      object: { kind: "string", value: "v" },
      assertion: "explicit",
      sourceRefs: [ref],
    });
    expect(parsed.kind).toBe("fact");
  });
});

describe("constructor freeze + kind discriminator stamp", () => {
  test("every constructor returns a frozen object", () => {
    expect(Object.isFrozen(minEffects.patch())).toBe(true);
    expect(Object.isFrozen(minEffects.diagnostic())).toBe(true);
    expect(Object.isFrozen(minEffects.fact())).toBe(true);
    expect(Object.isFrozen(minEffects["search-document"]())).toBe(true);
    expect(Object.isFrozen(minEffects.question())).toBe(true);
    expect(Object.isFrozen(minEffects.job())).toBe(true);
    expect(Object.isFrozen(minEffects.external())).toBe(true);
    expect(Object.isFrozen(minEffects["outbox-recovery"]())).toBe(true);
    expect(Object.isFrozen(minEffects["quarantine-recovery"]())).toBe(true);
    expect(Object.isFrozen(minEffects["run-recovery"]())).toBe(true);
    expect(Object.isFrozen(minEffects.view())).toBe(true);
  });

  test("each constructor stamps its kind discriminator", () => {
    expect(minEffects.patch().kind).toBe("patch");
    expect(minEffects.diagnostic().kind).toBe("diagnostic");
    expect(minEffects.fact().kind).toBe("fact");
    expect(minEffects["search-document"]().kind).toBe("search-document");
    expect(minEffects.question().kind).toBe("question");
    expect(minEffects.job().kind).toBe("job");
    expect(minEffects.external().kind).toBe("external");
    expect(minEffects["outbox-recovery"]().kind).toBe("outbox-recovery");
    expect(minEffects["quarantine-recovery"]().kind).toBe(
      "quarantine-recovery",
    );
    expect(minEffects["run-recovery"]().kind).toBe("run-recovery");
    expect(minEffects.view().kind).toBe("view");
  });

  test("path-bearing constructors canonicalize paths", () => {
    const patch = patchEffect({
      mode: "auto",
      changes: [{ kind: "write", path: "wiki//x.md", content: "hello\n" }],
      reason: "fix",
      sourceRefs: refs,
    });
    expect(patch.changes[0]?.path as string | undefined).toBe("wiki/x.md");

    const fact = factEffect({
      subject: { kind: "page", path: "wiki//x.md" },
      predicate: "dome.tasks.dueDate",
      object: { kind: "page", path: "wiki//y.md" },
      assertion: "explicit",
      sourceRefs: refs,
    });
    expect(fact.subject.kind).toBe("page");
    if (fact.subject.kind !== "page") return;
    expect(fact.subject.path as string).toBe("wiki/x.md");
    expect(fact.object.kind).toBe("page");
    if (fact.object.kind !== "page") return;
    expect(fact.object.path as string).toBe("wiki/y.md");

    const search = searchDocumentEffect({
      operation: "upsert",
      path: "wiki//x.md",
      category: "wiki",
      title: "x",
      body: "hello",
      sourceRefs: refs,
    });
    expect(search.path as string).toBe("wiki/x.md");
  });

  test("path-bearing constructors reject path traversal", () => {
    expect(() =>
      patchEffect({
        mode: "auto",
        changes: [{ kind: "write", path: "../secret.md", content: "x\n" }],
        reason: "fix",
        sourceRefs: refs,
      }),
    ).toThrow(/FileChange\.path/);
  });
});

describe("exhaustive-routing self-test", () => {
  test("every kind constructs and parses via EffectSchema", () => {
    const kinds = [
      "patch",
      "diagnostic",
      "fact",
      "search-document",
      "question",
      "job",
      "external",
      "outbox-recovery",
      "quarantine-recovery",
      "run-recovery",
      "view",
    ] as const;
    for (const k of kinds) {
      const e: Effect = minEffects[k]();
      const parsed = EffectSchema.parse(e);
      expect(parsed.kind).toBe(k);
    }
  });
});
