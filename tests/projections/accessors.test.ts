// Smoke tests for the per-table accessor files under src/projections/:
//   - facts.ts        — insertFact / factsBySubject / factsByPredicate
//   - diagnostics.ts  — insertDiagnostic / queryDiagnostics / resolveDiagnostic
//   - questions.ts    — insertQuestion / queryQuestions / answerQuestion
//   - jobs.ts         — enqueueJob / nextEligibleJob / claimNextEligibleJob /
//                       markJob{Running,Succeeded,Failed}
//   - schedule-cursors.ts — upsertCursor / getCursor / allCursors
//
// Each test gets a fresh tmpdir + a fresh projection.db so cross-test
// pollution is impossible. Tests use the typed Effect constructors from
// src/core/effect.ts (no hand-built Effect objects).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  diagnosticEffect,
  factEffect,
  jobEffect,
  questionEffect,
} from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { openProjectionDb, type ProjectionDb } from "../../src/projections/db";
import {
  allFacts,
  factsByPredicate,
  factsBySubject,
  insertFact,
  resolveStalePageFacts,
} from "../../src/projections/facts";
import {
  insertDiagnostic,
  queryDiagnostics,
  resolveDiagnostic,
  resolveStaleDiagnostics,
} from "../../src/projections/diagnostics";
import {
  answerQuestionById,
  getQuestionRecord,
  answerQuestion,
  insertQuestion,
  queryQuestionRecords,
  queryQuestions,
  resolveStaleQuestions,
} from "../../src/projections/questions";
import {
  claimNextEligibleJob,
  enqueueJob,
  markJobFailed,
  markJobRunning,
  markJobSucceeded,
  nextEligibleJob,
} from "../../src/projections/jobs";
import {
  allCursors,
  getCursor,
  upsertCursor,
} from "../../src/projections/schedule-cursors";

const ADOPTED = commitOid("abcdef0000000000000000000000000000000000");
const OTHER = commitOid("bbbbbb0000000000000000000000000000000000");
const REF = sourceRef({ commit: ADOPTED, path: "wiki/x.md" });

// Shared per-test handle harness. `withDb` returns a fresh ProjectionDb in an
// isolated tmpdir; afterEach closes + rms it.
let root: string;
let db: ProjectionDb;

async function openFresh(): Promise<ProjectionDb> {
  const path = join(root, ".dome", "state", "projection.db");
  const r = await openProjectionDb({
    path,
    extensionSet: [],
    processorVersions: [],
    capabilityPolicyHash: "test-policy",
  });
  if (!r.ok) throw new Error(`openProjectionDb failed: ${JSON.stringify(r.error)}`);
  return r.value.db;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "dome-projection-acc-"));
  db = await openFresh();
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
  rmSync(root, { recursive: true, force: true });
});

// ----- facts ---------------------------------------------------------------

describe("facts accessor", () => {
  it("round-trips an insertFact + factsBySubject for a 'page' NodeRef", () => {
    const effect = factEffect({
      subject: { kind: "page", path: "wiki/alice.md" },
      predicate: "dome.tasks.dueDate",
      object: { kind: "string", value: "2026-01-01" },
      assertion: "explicit",
      sourceRefs: [REF],
    });
    insertFact(db, { effect, processorId: "p1", adoptedCommit: ADOPTED });

    const got = factsBySubject(db, { kind: "page", path: "wiki/alice.md" });
    expect(got.length).toBe(1);
    expect(got[0]?.predicate).toBe("dome.tasks.dueDate");
    expect(got[0]?.subject.kind).toBe("page");
    if (got[0]?.subject.kind !== "page") return;
    expect(got[0].subject.path as string).toBe("wiki/alice.md");
  });

  it("round-trips an insertFact + factsBySubject for a 'task' NodeRef", () => {
    const effect = factEffect({
      subject: { kind: "task", stableId: "task-42" },
      predicate: "dome.tasks.status",
      object: { kind: "string", value: "done" },
      assertion: "explicit",
      sourceRefs: [REF],
    });
    insertFact(db, { effect, processorId: "p1", adoptedCommit: ADOPTED });

    const got = factsBySubject(db, { kind: "task", stableId: "task-42" });
    expect(got.length).toBe(1);
    expect(got[0]?.subject).toEqual({ kind: "task", stableId: "task-42" });
  });

  it("round-trips an insertFact + factsBySubject for an 'entity' NodeRef", () => {
    const effect = factEffect({
      subject: { kind: "entity", name: "Acme Corp" },
      predicate: "dome.entities.kind",
      object: { kind: "string", value: "company" },
      assertion: "explicit",
      sourceRefs: [REF],
    });
    insertFact(db, { effect, processorId: "p1", adoptedCommit: ADOPTED });

    const got = factsBySubject(db, { kind: "entity", name: "Acme Corp" });
    expect(got.length).toBe(1);
    expect(got[0]?.subject).toEqual({ kind: "entity", name: "Acme Corp" });
  });

  it("factsByPredicate filters by (namespace, predicate)", () => {
    const a = factEffect({
      subject: { kind: "page", path: "wiki/a.md" },
      predicate: "dome.tasks.dueDate",
      object: { kind: "string", value: "2026-01-01" },
      assertion: "explicit",
      sourceRefs: [REF],
    });
    const b = factEffect({
      subject: { kind: "page", path: "wiki/b.md" },
      predicate: "dome.tasks.status",
      object: { kind: "string", value: "done" },
      assertion: "explicit",
      sourceRefs: [REF],
    });
    insertFact(db, { effect: a, processorId: "p1", adoptedCommit: ADOPTED });
    insertFact(db, { effect: b, processorId: "p1", adoptedCommit: ADOPTED });

    const got = factsByPredicate(db, "dome.tasks", "dome.tasks.dueDate");
    expect(got.length).toBe(1);
    expect(got[0]?.predicate).toBe("dome.tasks.dueDate");
  });

  it("allFacts returns every fact in insertion order with one accessor call", () => {
    const a = factEffect({
      subject: { kind: "page", path: "wiki/a.md" },
      predicate: "dome.tasks.dueDate",
      object: { kind: "string", value: "2026-01-01" },
      assertion: "explicit",
      sourceRefs: [REF],
    });
    const b = factEffect({
      subject: { kind: "page", path: "wiki/b.md" },
      predicate: "dome.tasks.status",
      object: { kind: "string", value: "done" },
      assertion: "explicit",
      sourceRefs: [REF],
    });
    insertFact(db, { effect: a, processorId: "p1", adoptedCommit: ADOPTED });
    insertFact(db, { effect: b, processorId: "p1", adoptedCommit: ADOPTED });

    expect(allFacts(db).map((fact) => fact.predicate)).toEqual([
      "dome.tasks.dueDate",
      "dome.tasks.status",
    ]);
  });

  it("resolveStalePageFacts clears only the processor's page-subject rows for inspected paths", () => {
    const stale = factEffect({
      subject: { kind: "page", path: "wiki/a.md" },
      predicate: "dome.graph.links_to",
      object: { kind: "string", value: "old" },
      assertion: "extracted",
      sourceRefs: [sourceRef({ commit: ADOPTED, path: "wiki/a.md" })],
    });
    const otherPath = factEffect({
      subject: { kind: "page", path: "wiki/b.md" },
      predicate: "dome.graph.links_to",
      object: { kind: "string", value: "kept-path" },
      assertion: "extracted",
      sourceRefs: [sourceRef({ commit: ADOPTED, path: "wiki/b.md" })],
    });
    const otherProcessor = factEffect({
      subject: { kind: "page", path: "wiki/a.md" },
      predicate: "dome.other.links_to",
      object: { kind: "string", value: "kept-processor" },
      assertion: "extracted",
      sourceRefs: [sourceRef({ commit: ADOPTED, path: "wiki/a.md" })],
    });
    const entity = factEffect({
      subject: { kind: "entity", name: "Acme" },
      predicate: "dome.graph.mentioned_in",
      object: { kind: "string", value: "wiki/a.md" },
      assertion: "extracted",
      sourceRefs: [sourceRef({ commit: ADOPTED, path: "wiki/a.md" })],
    });

    insertFact(db, {
      effect: stale,
      processorId: "p1",
      adoptedCommit: ADOPTED,
    });
    insertFact(db, {
      effect: otherPath,
      processorId: "p1",
      adoptedCommit: ADOPTED,
    });
    insertFact(db, {
      effect: otherProcessor,
      processorId: "p2",
      adoptedCommit: ADOPTED,
    });
    insertFact(db, {
      effect: entity,
      processorId: "p1",
      adoptedCommit: ADOPTED,
    });

    const deleted = resolveStalePageFacts(db, {
      processorId: "p1",
      inspectedPaths: ["wiki/a.md", "wiki/a.md"],
    });

    expect(deleted).toBe(1);
    const pageA = factsBySubject(db, { kind: "page", path: "wiki/a.md" });
    expect(pageA.map((f) => f.predicate)).toEqual(["dome.other.links_to"]);
    expect(factsBySubject(db, { kind: "page", path: "wiki/b.md" }).length).toBe(
      1,
    );
    expect(factsBySubject(db, { kind: "entity", name: "Acme" }).length).toBe(1);
  });
});

// ----- diagnostics ---------------------------------------------------------

describe("diagnostics accessor", () => {
  // Regression: pre-fix, queryDiagnostics ordered by id ASC (oldest first).
  // When N diagnostics accumulate, freshly-emitted diagnostics drop out of the
  // default CLI window. User experience: "I just emitted a broken wikilink
  // diagnostic; `dome inspect diagnostics` doesn't show it." Fix orders DESC
  // so the freshest diagnostics are visible first.
  it("queryDiagnostics returns rows in newest-first order (id DESC)", () => {
    insertDiagnostic(db, {
      effect: diagnosticEffect({
        severity: "warning",
        code: "first",
        message: "first inserted",
        sourceRefs: [REF],
      }),
      processorId: "p1",
      proposalId: "prop_1",
      adoptedCommit: ADOPTED,
    });
    insertDiagnostic(db, {
      effect: diagnosticEffect({
        severity: "warning",
        code: "second",
        message: "second inserted",
        sourceRefs: [REF],
      }),
      processorId: "p1",
      proposalId: "prop_1",
      adoptedCommit: ADOPTED,
    });
    insertDiagnostic(db, {
      effect: diagnosticEffect({
        severity: "warning",
        code: "third",
        message: "third inserted (most recent)",
        sourceRefs: [REF],
      }),
      processorId: "p1",
      proposalId: "prop_1",
      adoptedCommit: ADOPTED,
    });

    const got = queryDiagnostics(db);
    expect(got.length).toBe(3);
    expect(got[0]?.code).toBe("third");
    expect(got[1]?.code).toBe("second");
    expect(got[2]?.code).toBe("first");
  });

  it("insertDiagnostic is idempotent on (processorId, code, proposalId, sourceRefs)", () => {
    const effect = diagnosticEffect({
      severity: "warning",
      code: "stale-link",
      message: "stale link to wiki/y.md",
      sourceRefs: [REF],
    });
    insertDiagnostic(db, {
      effect,
      processorId: "p1",
      proposalId: "prop_1",
      adoptedCommit: ADOPTED,
    });
    insertDiagnostic(db, {
      effect,
      processorId: "p1",
      proposalId: "prop_1",
      adoptedCommit: ADOPTED,
    });

    // INSERT OR IGNORE on the UNIQUE (processor_id, code, proposal_id,
    // subject_hash) means a re-emission of the same diagnostic at the
    // same source location is a silent no-op.
    const got = queryDiagnostics(db);
    expect(got.length).toBe(1);
  });

  it("insertDiagnostic inserts distinct rows when sourceRefs differ", () => {
    // Two diagnostics with the same (processorId, code, proposalId) but
    // different sourceRefs — e.g., validate-wikilinks finding two broken
    // links in two different files. Pre-fix, the UNIQUE constraint
    // collapsed these into one row, masking real defects.
    const ref1 = sourceRef({
      commit: ADOPTED,
      path: "wiki/a.md",
    });
    const ref2 = sourceRef({
      commit: ADOPTED,
      path: "wiki/b.md",
    });
    insertDiagnostic(db, {
      effect: diagnosticEffect({
        severity: "warning",
        code: "broken-link",
        message: "broken link in a.md",
        sourceRefs: [ref1],
      }),
      processorId: "p1",
      proposalId: "prop_1",
      adoptedCommit: ADOPTED,
    });
    insertDiagnostic(db, {
      effect: diagnosticEffect({
        severity: "warning",
        code: "broken-link",
        message: "broken link in b.md",
        sourceRefs: [ref2],
      }),
      processorId: "p1",
      proposalId: "prop_1",
      adoptedCommit: ADOPTED,
    });

    expect(queryDiagnostics(db).length).toBe(2);
  });

  // Regression: subject_hash drops `commit` and `blob` from the dedup
  // discriminator. Two diagnostics emitted against the same vault span
  // (same path + range + stableId) but anchored to different candidate
  // commits — the adoption loop's normal behavior when a sibling
  // PatchEffect advances the tree mid-loop — must dedupe to one row.
  // Pre-H3, the prior shape `source_refs_hash` (hashing the full
  // SourceRef including commit) over-distinguished, leaving two rows.
  it("diagnostics with same path+range but different SourceRef.commit dedup", () => {
    const otherCommit = commitOid("fedcba0000000000000000000000000000000000");
    const refAdopted = sourceRef({
      commit: ADOPTED,
      path: "wiki/x.md",
      range: { startLine: 3, endLine: 3, startChar: 0, endChar: 12 },
    });
    const refOther = sourceRef({
      commit: otherCommit,
      path: "wiki/x.md",
      range: { startLine: 3, endLine: 3, startChar: 0, endChar: 12 },
    });
    insertDiagnostic(db, {
      effect: diagnosticEffect({
        severity: "warning",
        code: "broken-link",
        message: "broken link in x.md (iteration 1)",
        sourceRefs: [refAdopted],
      }),
      processorId: "p1",
      proposalId: "prop_1",
      adoptedCommit: ADOPTED,
    });
    insertDiagnostic(db, {
      effect: diagnosticEffect({
        severity: "warning",
        code: "broken-link",
        message: "broken link in x.md (iteration 2)",
        sourceRefs: [refOther],
      }),
      processorId: "p1",
      proposalId: "prop_1",
      adoptedCommit: ADOPTED,
    });

    // Same content identity → one row, regardless of which candidate
    // commit anchored the emission.
    expect(queryDiagnostics(db).length).toBe(1);
  });

  it("queryDiagnostics shows only the latest unresolved row for duplicate live identities", () => {
    const newerCommit = commitOid("1111110000000000000000000000000000000000");
    const original = diagnosticEffect({
      severity: "warning",
      code: "broken-link",
      message: "old unresolved row",
      sourceRefs: [
        sourceRef({
          commit: ADOPTED,
          path: "wiki/x.md",
          range: { startLine: 3, endLine: 3, startChar: 0, endChar: 12 },
        }),
      ],
    });
    const duplicate = diagnosticEffect({
      severity: "warning",
      code: "broken-link",
      message: "new unresolved row",
      sourceRefs: [
        sourceRef({
          commit: newerCommit,
          path: "wiki/x.md",
          range: { startLine: 3, endLine: 3, startChar: 0, endChar: 12 },
        }),
      ],
    });
    insertDiagnostic(db, {
      effect: original,
      processorId: "p1",
      proposalId: "prop_old",
      adoptedCommit: ADOPTED,
    });
    insertDiagnostic(db, {
      effect: duplicate,
      processorId: "p1",
      proposalId: "prop_new",
      adoptedCommit: newerCommit,
    });

    const current = queryDiagnostics(db);
    expect(current.length).toBe(1);
    expect(current[0]?.message).toBe("new unresolved row");
    expect(current[0]?.sourceRefs[0]?.commit).toBe(newerCommit);
    expect(queryDiagnostics(db, { severity: "warning" }).length).toBe(1);
    expect(queryDiagnostics(db, { processorId: "p1" }).length).toBe(1);
    expect(
      queryDiagnostics(db, { severity: "warning", processorId: "p1" }).length,
    ).toBe(1);
  });

  it("queryDiagnostics({severity: 'warning'}) filters by severity", () => {
    const w = diagnosticEffect({
      severity: "warning",
      code: "w",
      message: "warn",
      sourceRefs: [REF],
    });
    const i = diagnosticEffect({
      severity: "info",
      code: "i",
      message: "info",
      sourceRefs: [REF],
    });
    insertDiagnostic(db, {
      effect: w,
      processorId: "p1",
      proposalId: null,
      adoptedCommit: ADOPTED,
    });
    insertDiagnostic(db, {
      effect: i,
      processorId: "p1",
      proposalId: null,
      adoptedCommit: ADOPTED,
    });

    const got = queryDiagnostics(db, { severity: "warning" });
    expect(got.length).toBe(1);
    expect(got[0]?.severity).toBe("warning");
  });

  it("resolveDiagnostic removes the row matching the triple from query results", () => {
    const effect = diagnosticEffect({
      severity: "error",
      code: "broken-yaml",
      message: "yaml parse failed",
      sourceRefs: [REF],
    });
    insertDiagnostic(db, {
      effect,
      processorId: "p1",
      proposalId: "prop_2",
      adoptedCommit: ADOPTED,
    });
    expect(queryDiagnostics(db).length).toBe(1);

    resolveDiagnostic(db, {
      processorId: "p1",
      code: "broken-yaml",
      proposalId: "prop_2",
    });
    // queryDiagnostics filters `resolved_at IS NULL` — resolved rows fall
    // out of the live view.
    expect(queryDiagnostics(db).length).toBe(0);
  });

  it("resolveStaleDiagnostics resolves only stale rows on inspected paths", () => {
    const stale = diagnosticEffect({
      severity: "warning",
      code: "broken-link",
      message: "broken link in x.md",
      sourceRefs: [REF],
    });
    const untouched = diagnosticEffect({
      severity: "warning",
      code: "broken-link",
      message: "broken link in y.md",
      sourceRefs: [
        sourceRef({
          commit: ADOPTED,
          path: "wiki/y.md",
        }),
      ],
    });
    insertDiagnostic(db, {
      effect: stale,
      processorId: "p1",
      proposalId: "prop_3",
      adoptedCommit: ADOPTED,
    });
    insertDiagnostic(db, {
      effect: untouched,
      processorId: "p1",
      proposalId: "prop_3",
      adoptedCommit: ADOPTED,
    });

    const resolved = resolveStaleDiagnostics(db, {
      processorId: "p1",
      inspectedPaths: ["wiki/x.md"],
      emittedDiagnostics: [],
    });

    expect(resolved).toBe(1);
    const got = queryDiagnostics(db);
    expect(got.length).toBe(1);
    expect(got[0]?.message).toBe("broken link in y.md");
  });

  it("resolveStaleDiagnostics keeps re-emitted diagnostics by content identity", () => {
    const otherCommit = commitOid("1111110000000000000000000000000000000000");
    const original = diagnosticEffect({
      severity: "warning",
      code: "broken-link",
      message: "original message",
      sourceRefs: [
        sourceRef({
          commit: ADOPTED,
          path: "wiki/x.md",
          range: { startLine: 2, endLine: 2, startChar: 0, endChar: 12 },
        }),
      ],
    });
    const reEmitted = diagnosticEffect({
      severity: "warning",
      code: "broken-link",
      message: "updated message",
      sourceRefs: [
        sourceRef({
          commit: otherCommit,
          path: "wiki/x.md",
          range: { startLine: 2, endLine: 2, startChar: 0, endChar: 12 },
        }),
      ],
    });
    insertDiagnostic(db, {
      effect: original,
      processorId: "p1",
      proposalId: "prop_4",
      adoptedCommit: ADOPTED,
    });

    const resolved = resolveStaleDiagnostics(db, {
      processorId: "p1",
      inspectedPaths: ["wiki/x.md"],
      emittedDiagnostics: [reEmitted],
    });

    expect(resolved).toBe(0);
    expect(queryDiagnostics(db).length).toBe(1);
  });

  it("resolveStaleDiagnostics prunes older live duplicates for re-emitted diagnostics", () => {
    const newerCommit = commitOid("1111110000000000000000000000000000000000");
    const original = diagnosticEffect({
      severity: "warning",
      code: "broken-link",
      message: "old unresolved row",
      sourceRefs: [
        sourceRef({
          commit: ADOPTED,
          path: "wiki/x.md",
          range: { startLine: 2, endLine: 2, startChar: 0, endChar: 12 },
        }),
      ],
    });
    const reEmitted = diagnosticEffect({
      severity: "warning",
      code: "broken-link",
      message: "new unresolved row",
      sourceRefs: [
        sourceRef({
          commit: newerCommit,
          path: "wiki/x.md",
          range: { startLine: 2, endLine: 2, startChar: 0, endChar: 12 },
        }),
      ],
    });
    insertDiagnostic(db, {
      effect: original,
      processorId: "p1",
      proposalId: "prop_old",
      adoptedCommit: ADOPTED,
    });
    insertDiagnostic(db, {
      effect: reEmitted,
      processorId: "p1",
      proposalId: "prop_new",
      adoptedCommit: newerCommit,
    });

    const resolved = resolveStaleDiagnostics(db, {
      processorId: "p1",
      inspectedPaths: ["wiki/x.md"],
      emittedDiagnostics: [reEmitted],
    });

    expect(resolved).toBe(1);
    const current = queryDiagnostics(db);
    expect(current.length).toBe(1);
    expect(current[0]?.message).toBe("new unresolved row");
    expect(current[0]?.sourceRefs[0]?.commit).toBe(newerCommit);
  });
});

// ----- questions -----------------------------------------------------------

describe("questions accessor", () => {
  it("insertQuestion is idempotent on idempotency_key", () => {
    const effect = questionEffect({
      question: "what is the dueDate of wiki/x.md?",
      sourceRefs: [REF],
      idempotencyKey: "q-1",
    });
    insertQuestion(db, { effect, processorId: "p1", adoptedCommit: ADOPTED });
    insertQuestion(db, { effect, processorId: "p1", adoptedCommit: ADOPTED });

    const got = queryQuestions(db);
    expect(got.length).toBe(1);
  });

  it("insertQuestion refreshes unanswered rows for stable question keys", () => {
    const original = questionEffect({
      question: "possible followup at old line?",
      sourceRefs: [
        sourceRef({
          commit: ADOPTED,
          path: "wiki/a.md",
          range: { startLine: 3, endLine: 3 },
          stableId: "dome.daily.open-loop:abc",
        }),
      ],
      idempotencyKey: "q-stable",
    });
    const moved = questionEffect({
      question: "possible followup at new line?",
      sourceRefs: [
        sourceRef({
          commit: OTHER,
          path: "wiki/a.md",
          range: { startLine: 7, endLine: 7 },
          stableId: "dome.daily.open-loop:abc",
        }),
      ],
      idempotencyKey: "q-stable",
    });
    insertQuestion(db, { effect: original, processorId: "p1", adoptedCommit: ADOPTED });
    insertQuestion(db, { effect: moved, processorId: "p1", adoptedCommit: OTHER });

    const records = queryQuestionRecords(db);
    expect(records).toHaveLength(1);
    expect(records[0]?.effect.question).toBe("possible followup at new line?");
    expect(records[0]?.adoptedCommit).toBe(OTHER);
    expect(records[0]?.effect.sourceRefs[0]?.range?.startLine).toBe(7);
    expect(records[0]?.effect.sourceRefs[0]?.stableId).toBe(
      "dome.daily.open-loop:abc",
    );
  });

  it("insertQuestion does not overwrite answered rows", () => {
    const original = questionEffect({
      question: "possible followup?",
      sourceRefs: [
        sourceRef({
          commit: ADOPTED,
          path: "wiki/a.md",
          range: { startLine: 3, endLine: 3 },
        }),
      ],
      idempotencyKey: "q-answered-stable",
    });
    const moved = questionEffect({
      question: "changed wording?",
      sourceRefs: [
        sourceRef({
          commit: OTHER,
          path: "wiki/a.md",
          range: { startLine: 7, endLine: 7 },
        }),
      ],
      idempotencyKey: "q-answered-stable",
    });
    insertQuestion(db, { effect: original, processorId: "p1", adoptedCommit: ADOPTED });
    answerQuestion(db, {
      idempotencyKey: "q-answered-stable",
      answer: "track",
    });
    insertQuestion(db, { effect: moved, processorId: "p1", adoptedCommit: OTHER });

    const records = queryQuestionRecords(db);
    expect(records).toHaveLength(1);
    expect(records[0]?.effect.question).toBe("possible followup?");
    expect(records[0]?.adoptedCommit).toBe(ADOPTED);
    expect(records[0]?.effect.sourceRefs[0]?.range?.startLine).toBe(3);
    expect(records[0]?.answer).toBe("track");
  });

  it("resolveStaleQuestions deletes stale questions for inspected paths", () => {
    const stale = questionEffect({
      question: "stale?",
      sourceRefs: [sourceRef({ commit: ADOPTED, path: "wiki/a.md" })],
      idempotencyKey: "q-stale",
    });
    const keptPath = questionEffect({
      question: "other path?",
      sourceRefs: [sourceRef({ commit: ADOPTED, path: "wiki/b.md" })],
      idempotencyKey: "q-other-path",
    });
    const keptProcessor = questionEffect({
      question: "other processor?",
      sourceRefs: [sourceRef({ commit: ADOPTED, path: "wiki/a.md" })],
      idempotencyKey: "q-other-processor",
    });
    insertQuestion(db, {
      effect: stale,
      processorId: "p1",
      adoptedCommit: ADOPTED,
    });
    insertQuestion(db, {
      effect: keptPath,
      processorId: "p1",
      adoptedCommit: ADOPTED,
    });
    insertQuestion(db, {
      effect: keptProcessor,
      processorId: "p2",
      adoptedCommit: ADOPTED,
    });

    const deleted = resolveStaleQuestions(db, {
      processorId: "p1",
      inspectedPaths: ["wiki/a.md", "wiki/a.md"],
      emittedQuestions: [],
    });

    expect(deleted).toBe(1);
    expect(queryQuestions(db).map((q) => q.idempotencyKey)).toEqual([
      "q-other-path",
      "q-other-processor",
    ]);
  });

  it("resolveStaleQuestions keeps re-emitted questions by idempotency key", () => {
    const original = questionEffect({
      question: "original?",
      sourceRefs: [sourceRef({ commit: ADOPTED, path: "wiki/a.md" })],
      idempotencyKey: "q-keep",
    });
    const reEmitted = questionEffect({
      question: "updated wording?",
      sourceRefs: [sourceRef({ commit: ADOPTED, path: "wiki/a.md" })],
      idempotencyKey: "q-keep",
    });
    insertQuestion(db, {
      effect: original,
      processorId: "p1",
      adoptedCommit: ADOPTED,
    });

    const deleted = resolveStaleQuestions(db, {
      processorId: "p1",
      inspectedPaths: ["wiki/a.md"],
      emittedQuestions: [reEmitted],
    });

    expect(deleted).toBe(0);
    expect(queryQuestions(db).map((q) => q.idempotencyKey)).toEqual([
      "q-keep",
    ]);
  });

  it("queryQuestions({resolved: true}) filters to answered questions only", () => {
    const a = questionEffect({
      question: "answered?",
      sourceRefs: [REF],
      idempotencyKey: "q-a",
    });
    const u = questionEffect({
      question: "unanswered?",
      sourceRefs: [REF],
      idempotencyKey: "q-u",
    });
    insertQuestion(db, { effect: a, processorId: "p1", adoptedCommit: ADOPTED });
    insertQuestion(db, { effect: u, processorId: "p1", adoptedCommit: ADOPTED });
    answerQuestion(db, { idempotencyKey: "q-a", answer: "yes" });

    const got = queryQuestions(db, { resolved: true });
    expect(got.length).toBe(1);
    expect(got[0]?.idempotencyKey).toBe("q-a");
  });

  it("answerQuestion marks a question answered (visible to resolved filter)", () => {
    const effect = questionEffect({
      question: "the question",
      sourceRefs: [REF],
      idempotencyKey: "q-1",
    });
    insertQuestion(db, { effect, processorId: "p1", adoptedCommit: ADOPTED });

    expect(queryQuestions(db, { resolved: true }).length).toBe(0);
    answerQuestion(db, { idempotencyKey: "q-1", answer: "the answer" });
    expect(queryQuestions(db, { resolved: true }).length).toBe(1);
  });

  it("queryQuestionRecords exposes stable row ids and answer metadata", () => {
    const effect = questionEffect({
      question: "choose?",
      sourceRefs: [REF],
      idempotencyKey: "q-row",
      options: ["yes", "no"],
      metadata: {
        risk: "low",
        confidence: 0.9,
        recommendedAnswer: "yes",
        automationPolicy: "agent-safe",
      },
    });
    insertQuestion(db, { effect, processorId: "p1", adoptedCommit: ADOPTED });

    const records = queryQuestionRecords(db);
    expect(records.length).toBe(1);
    const record = records[0];
    expect(record?.id).toBeGreaterThan(0);
    expect(record?.processorId).toBe("p1");
    expect(record?.adoptedCommit).toBe(ADOPTED);
    expect(record?.answeredAt).toBeNull();
    expect(record?.answer).toBeNull();
    expect(record?.effect.options).toEqual(["yes", "no"]);
    expect(record?.effect.metadata).toEqual({
      risk: "low",
      confidence: 0.9,
      recommendedAnswer: "yes",
      automationPolicy: "agent-safe",
    });
  });

  it("answerQuestionById validates options and records the answer", () => {
    const effect = questionEffect({
      question: "choose?",
      sourceRefs: [REF],
      idempotencyKey: "q-choice",
      options: ["keep", "merge"],
    });
    insertQuestion(db, { effect, processorId: "p1", adoptedCommit: ADOPTED });
    const record = queryQuestionRecords(db)[0];
    expect(record).toBeDefined();
    if (record === undefined) return;

    const invalid = answerQuestionById(db, {
      id: record.id,
      answer: "delete",
    });
    expect(invalid.kind).toBe("invalid-option");
    expect(getQuestionRecord(db, record.id)?.answeredAt).toBeNull();

    const answered = answerQuestionById(db, {
      id: record.id,
      answer: "keep",
    });
    expect(answered.kind).toBe("answered");
    const after = getQuestionRecord(db, record.id);
    expect(after?.answer).toBe("keep");
    expect(after?.answeredAt).not.toBeNull();
  });
});

// ----- jobs ----------------------------------------------------------------

describe("jobs accessor", () => {
  it("enqueueJob + nextEligibleJob round-trips a job with explicit runAfter", () => {
    const earlier = new Date(Date.now() - 60_000).toISOString();
    const effect = jobEffect({
      processorId: "dome.deferred",
      input: { x: 1 },
      idempotencyKey: "j-1",
      runAfter: earlier,
    });
    enqueueJob(db, { effect, processorId: "p.emitter" });

    const next = nextEligibleJob(db, new Date());
    expect(next).not.toBeNull();
    if (next === null) return;
    expect(next.idempotencyKey).toBe("j-1");
    expect(next.processorId).toBe("dome.deferred");
    expect(next.status).toBe("pending");
    expect(next.attempts).toBe(0);
    expect(next.runAfter).toBe(earlier);
  });

  it("enqueueJob defaults runAfter to 'now' when the effect omits it", () => {
    const before = new Date();
    const effect = jobEffect({
      processorId: "dome.immediate",
      input: null,
      idempotencyKey: "j-now",
    });
    enqueueJob(db, { effect, processorId: "p.emitter" });
    const after = new Date();

    const next = nextEligibleJob(db, after);
    expect(next).not.toBeNull();
    if (next === null) return;
    // runAfter is an ISO string; lexical comparison is correct for canonical
    // ISO-8601. Bound it [before, after].
    expect(next.runAfter >= before.toISOString()).toBe(true);
    expect(next.runAfter <= after.toISOString()).toBe(true);
  });

  it("markJobRunning transitions pending→running and bumps attempts", () => {
    const effect = jobEffect({
      processorId: "p",
      input: null,
      idempotencyKey: "j-1",
    });
    enqueueJob(db, { effect, processorId: "p" });
    const next = nextEligibleJob(db, new Date());
    expect(next).not.toBeNull();
    if (next === null) return;

    markJobRunning(db, next.id);

    // nextEligibleJob filters to `status = 'pending'`, so the running row
    // no longer appears.
    expect(nextEligibleJob(db, new Date())).toBeNull();

    const row = db.raw
      .query<{ status: string; attempts: number }, [number]>(
        "SELECT status, attempts FROM scheduled_jobs WHERE id = ?",
      )
      .all(next.id)[0];
    expect(row).toBeDefined();
    expect(row?.status).toBe("running");
    expect(row?.attempts).toBe(1);
  });

  it("claimNextEligibleJob atomically claims the next due job", () => {
    const effect = jobEffect({
      processorId: "p",
      input: { x: 1 },
      idempotencyKey: "j-claim",
    });
    enqueueJob(db, { effect, processorId: "p" });

    const claimed = claimNextEligibleJob(db, new Date());
    expect(claimed).not.toBeNull();
    if (claimed === null) return;
    expect(claimed.idempotencyKey).toBe("j-claim");
    expect(claimed.status).toBe("running");
    expect(claimed.attempts).toBe(1);
    expect(claimNextEligibleJob(db, new Date())).toBeNull();
    expect(nextEligibleJob(db, new Date())).toBeNull();
  });

  it("claimNextEligibleJob skips future and non-pending rows", () => {
    const future = new Date(Date.now() + 60_000);
    enqueueJob(db, {
      processorId: "p",
      effect: jobEffect({
        processorId: "p.future",
        input: null,
        idempotencyKey: "j-future",
        runAfter: future.toISOString(),
      }),
    });
    enqueueJob(db, {
      processorId: "p",
      effect: jobEffect({
        processorId: "p.running",
        input: null,
        idempotencyKey: "j-running",
      }),
    });
    const running = nextEligibleJob(db, new Date());
    if (running === null) throw new Error("expected immediate job");
    markJobRunning(db, running.id);

    expect(claimNextEligibleJob(db, new Date())).toBeNull();
  });

  it("markJobSucceeded transitions running→succeeded with completed_at", () => {
    const effect = jobEffect({
      processorId: "p",
      input: null,
      idempotencyKey: "j-1",
    });
    enqueueJob(db, { effect, processorId: "p" });
    const next = nextEligibleJob(db, new Date());
    if (next === null) throw new Error("expected a pending job");

    markJobRunning(db, next.id);
    const completedAt = new Date();
    markJobSucceeded(db, next.id, completedAt);

    const row = db.raw
      .query<{ status: string; completed_at: string | null }, [number]>(
        "SELECT status, completed_at FROM scheduled_jobs WHERE id = ?",
      )
      .all(next.id)[0];
    expect(row?.status).toBe("succeeded");
    expect(row?.completed_at).toBe(completedAt.toISOString());
  });

  it("markJobFailed transitions running→failed with completed_at", () => {
    const effect = jobEffect({
      processorId: "p",
      input: null,
      idempotencyKey: "j-1",
    });
    enqueueJob(db, { effect, processorId: "p" });
    const next = nextEligibleJob(db, new Date());
    if (next === null) throw new Error("expected a pending job");

    markJobRunning(db, next.id);
    const completedAt = new Date();
    markJobFailed(db, next.id, completedAt);

    const row = db.raw
      .query<{ status: string; completed_at: string | null }, [number]>(
        "SELECT status, completed_at FROM scheduled_jobs WHERE id = ?",
      )
      .all(next.id)[0];
    expect(row?.status).toBe("failed");
    expect(row?.completed_at).toBe(completedAt.toISOString());
  });
});

// ----- schedule-cursors ----------------------------------------------------

describe("schedule-cursors accessor", () => {
  it("upsertCursor + getCursor round-trips a single cursor", () => {
    upsertCursor(db, {
      processorId: "dome.scheduled.refresh",
      cron: "0 * * * *",
      lastFire: "2026-01-01T00:00:00.000Z",
      nextFire: "2026-01-01T01:00:00.000Z",
    });

    const got = getCursor(db, "dome.scheduled.refresh");
    expect(got).not.toBeNull();
    if (got === null) return;
    expect(got.processorId).toBe("dome.scheduled.refresh");
    expect(got.cron).toBe("0 * * * *");
    expect(got.lastFire).toBe("2026-01-01T00:00:00.000Z");
    expect(got.nextFire).toBe("2026-01-01T01:00:00.000Z");
  });

  it("upsertCursor overwrites an existing row for the same processor", () => {
    upsertCursor(db, {
      processorId: "dome.scheduled.refresh",
      cron: "0 * * * *",
      lastFire: "2026-01-01T00:00:00.000Z",
      nextFire: "2026-01-01T01:00:00.000Z",
    });
    upsertCursor(db, {
      processorId: "dome.scheduled.refresh",
      cron: "*/30 * * * *",
      lastFire: "2026-01-02T00:00:00.000Z",
      nextFire: "2026-01-02T00:30:00.000Z",
    });

    const got = getCursor(db, "dome.scheduled.refresh");
    expect(got?.cron).toBe("*/30 * * * *");
    expect(got?.lastFire).toBe("2026-01-02T00:00:00.000Z");
  });

  it("allCursors returns every cursor in processor_id order", () => {
    upsertCursor(db, {
      processorId: "b.proc",
      cron: "0 * * * *",
      lastFire: "2026-01-01T00:00:00.000Z",
      nextFire: "2026-01-01T01:00:00.000Z",
    });
    upsertCursor(db, {
      processorId: "a.proc",
      cron: "0 * * * *",
      lastFire: "2026-01-01T00:00:00.000Z",
      nextFire: "2026-01-01T01:00:00.000Z",
    });

    const got = allCursors(db);
    expect(got.length).toBe(2);
    expect(got[0]?.processorId).toBe("a.proc");
    expect(got[1]?.processorId).toBe("b.proc");
  });
});
