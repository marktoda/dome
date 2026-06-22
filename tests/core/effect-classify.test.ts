// tests/core/effect-classify.test.ts
//
// The Effect classifier is the single place that knows how Effect kinds map to
// semantic categories. The `satisfies Record<Effect["kind"], …>` tables here
// (and inside effect-classify.ts) are the load-bearing guard: adding a 12th
// Effect kind fails to compile in both the map and this test until it is
// consciously classified.

import { describe, expect, test } from "bun:test";

import {
  diagnosticEffect,
  type Effect,
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
} from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { effectsOfKind, isProjectionEffect } from "../../src/core/effect-classify";

const ref = sourceRef({ commit: commitOid("abc"), path: "wiki/x.md" });
const refs = [ref] as const;

// One minimum-valid effect per kind — real constructors, no mocks.
const byKind: Record<Effect["kind"], Effect> = {
  patch: patchEffect({
    mode: "auto",
    changes: [{ kind: "write", path: "wiki/x.md", content: "hello\n" }],
    reason: "fix",
    sourceRefs: refs,
  }),
  diagnostic: diagnosticEffect({
    severity: "info",
    code: "smoke",
    message: "ok",
    sourceRefs: refs,
  }),
  fact: factEffect({
    subject: { kind: "page", path: "wiki/x.md" },
    predicate: "dome.tasks.dueDate",
    object: { kind: "string", value: "2026-01-01" },
    assertion: "explicit",
    sourceRefs: refs,
  }),
  "search-document": searchDocumentEffect({
    operation: "upsert",
    path: "wiki/x.md",
    category: "wiki",
    title: "x",
    body: "hello",
    sourceRefs: refs,
  }),
  question: questionEffect({
    question: "ok?",
    sourceRefs: refs,
    idempotencyKey: "q-1",
  }),
  job: jobEffect({ processorId: "dome.test", input: null, idempotencyKey: "j-1" }),
  external: externalActionEffect({
    capability: "calendar.write",
    idempotencyKey: "e-1",
    payload: { event: "x" },
    sourceRefs: refs,
  }),
  "outbox-recovery": outboxRecoveryEffect({
    action: "retry",
    idempotencyKey: "e-1",
    reason: "recover failed outbox row",
    sourceRefs: refs,
  }),
  "quarantine-recovery": quarantineRecoveryEffect({
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
  "run-recovery": runRecoveryEffect({
    action: "fail",
    runId: "run_1_orphan",
    startedAt: "2026-05-29T00:00:00.000Z",
    processorId: "dome.test",
    processorVersion: "0.1.0",
    phase: "garden",
    reason: "fail orphan run",
    sourceRefs: refs,
  }),
  view: viewEffect({
    name: "test",
    content: { kind: "markdown", body: "# hi" },
    scope: refs,
  }),
};

const ALL_KINDS = Object.keys(byKind) as Effect["kind"][];

describe("effectsOfKind", () => {
  test("extracts only the effects of the requested kind", () => {
    const effects: Effect[] = [
      byKind.patch,
      byKind.diagnostic,
      byKind.question,
      byKind.diagnostic,
    ];
    const diagnostics = effectsOfKind(effects, "diagnostic");
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.every((e) => e.kind === "diagnostic")).toBe(true);
  });

  test("narrows the element type so kind-specific fields are reachable", () => {
    const diagnostics = effectsOfKind([byKind.diagnostic], "diagnostic");
    // `.severity` only exists on DiagnosticEffect — compiles only if narrowed.
    expect(diagnostics[0]?.severity).toBe("info");
  });

  test("returns an empty array when nothing matches", () => {
    expect(effectsOfKind([byKind.patch], "question")).toEqual([]);
  });
});

describe("isProjectionEffect", () => {
  // Exhaustive expectation: every Effect kind, classified by whether it feeds a
  // projection sink. `satisfies` makes a new kind a compile error here.
  const expected = {
    patch: false,
    diagnostic: true,
    fact: true,
    "search-document": true,
    question: true,
    job: false,
    external: false,
    "outbox-recovery": false,
    "quarantine-recovery": false,
    "run-recovery": false,
    view: false,
  } satisfies Record<Effect["kind"], boolean>;

  for (const kind of ALL_KINDS) {
    test(`${kind} → ${expected[kind]}`, () => {
      expect(isProjectionEffect(byKind[kind])).toBe(expected[kind]);
    });
  }
});
