// Smoke tests for the per-table accessor files under src/projections/:
//   - facts.ts        — insertFact / factsBySubject / factsByPredicate
//   - diagnostics.ts  — insertDiagnostic / queryDiagnostics / resolveDiagnostic
//   - questions.ts    — insertQuestion / queryQuestions / answerQuestion
//   - jobs.ts         — enqueueJob / nextEligibleJob / markJob{Running,
//                       Succeeded,Failed}
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
  factsByPredicate,
  factsBySubject,
  insertFact,
} from "../../src/projections/facts";
import {
  insertDiagnostic,
  queryDiagnostics,
  resolveDiagnostic,
} from "../../src/projections/diagnostics";
import {
  answerQuestion,
  insertQuestion,
  queryQuestions,
} from "../../src/projections/questions";
import {
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
    expect(got[0]?.subject).toEqual({ kind: "page", path: "wiki/alice.md" });
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
});

// ----- diagnostics ---------------------------------------------------------

describe("diagnostics accessor", () => {
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
    // source_refs_hash) means a re-emission of the same diagnostic at the
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
    expect(next.processorId).toBe("p.emitter");
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
