// Smoke tests for src/projections/sinks.ts: the buildSqliteSinks factory
// composes the five projection-store sinks against a real projection.db +
// outbox.db, and passes through the two engine-layer injections (applyPatch,
// captureView) verbatim. Each test exercises one sink callback end-to-end
// by asserting a row is visible via the corresponding read accessor.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  diagnosticEffect,
  externalActionEffect,
  factEffect,
  jobEffect,
  patchEffect,
  questionEffect,
  viewEffect,
  type PatchEffect,
  type ViewEffect,
} from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { openProjectionDb, type ProjectionDb } from "../../src/projections/db";
import { openOutboxDb, type OutboxDb } from "../../src/outbox/db";
import { buildSqliteSinks } from "../../src/projections/sinks";
import { factsBySubject } from "../../src/projections/facts";
import { queryDiagnostics } from "../../src/projections/diagnostics";
import { queryQuestions } from "../../src/projections/questions";
import { nextEligibleJob } from "../../src/projections/jobs";
import { queryOutbox } from "../../src/outbox/dispatch";
import type { ApplyEffectSinks } from "../../src/engine/apply-effect";
import type { RunId } from "../../src/engine/runner-contract";

const ADOPTED = commitOid("abcdef0000000000000000000000000000000000");
const REF = sourceRef({ commit: ADOPTED, path: "wiki/x.md" });

const PROCESSOR_ID = "test.proc";
const RUN_ID = "run-1" as RunId;

// Default no-op injections for the two engine-layer sinks. Individual tests
// override these to verify the pass-through invocation.
const noopApplyPatch: ApplyEffectSinks["applyPatch"] = async () => null;
const noopCaptureView: ApplyEffectSinks["captureView"] = async () => undefined;

let root: string;
let projectionDb: ProjectionDb;
let outboxDb: OutboxDb;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "dome-sinks-"));
  const projectionPath = join(root, ".dome", "state", "projection.db");
  const outboxPath = join(root, ".dome", "state", "outbox.db");
  const p = await openProjectionDb({
    path: projectionPath,
    extensionSet: [],
    processorVersions: [],
  });
  if (!p.ok) throw new Error(`openProjectionDb failed: ${JSON.stringify(p.error)}`);
  projectionDb = p.value.db;

  const o = await openOutboxDb({ path: outboxPath });
  if (!o.ok) throw new Error(`openOutboxDb failed: ${JSON.stringify(o.error)}`);
  outboxDb = o.value.db;
});

afterEach(() => {
  try {
    projectionDb.close();
  } catch {
    // already closed
  }
  try {
    outboxDb.close();
  } catch {
    // already closed
  }
  rmSync(root, { recursive: true, force: true });
});

describe("buildSqliteSinks shape", () => {
  it("returns a frozen object with all seven sink callbacks", () => {
    const sinks = buildSqliteSinks({
      projectionDb,
      outboxDb,
      adoptedCommit: ADOPTED,
      applyPatch: noopApplyPatch,
      captureView: noopCaptureView,
    });

    expect(Object.isFrozen(sinks)).toBe(true);
    expect(typeof sinks.applyPatch).toBe("function");
    expect(typeof sinks.recordDiagnostic).toBe("function");
    expect(typeof sinks.recordFact).toBe("function");
    expect(typeof sinks.recordQuestion).toBe("function");
    expect(typeof sinks.enqueueJob).toBe("function");
    expect(typeof sinks.dispatchExternal).toBe("function");
    expect(typeof sinks.captureView).toBe("function");
  });
});

describe("buildSqliteSinks projection-store sinks", () => {
  it("recordFact writes a row visible via factsBySubject", async () => {
    const sinks = buildSqliteSinks({
      projectionDb,
      outboxDb,
      adoptedCommit: ADOPTED,
      applyPatch: noopApplyPatch,
      captureView: noopCaptureView,
    });

    const effect = factEffect({
      subject: { kind: "page", path: "wiki/alice.md" },
      predicate: "dome.tasks.dueDate",
      object: { kind: "string", value: "2026-01-01" },
      assertion: "explicit",
      sourceRefs: [REF],
    });
    await sinks.recordFact({ effect, processorId: PROCESSOR_ID, runId: RUN_ID });

    const got = factsBySubject(projectionDb, {
      kind: "page",
      path: "wiki/alice.md",
    });
    expect(got.length).toBe(1);
    expect(got[0]?.predicate).toBe("dome.tasks.dueDate");
  });

  it("recordDiagnostic writes a row visible via queryDiagnostics", async () => {
    const sinks = buildSqliteSinks({
      projectionDb,
      outboxDb,
      adoptedCommit: ADOPTED,
      applyPatch: noopApplyPatch,
      captureView: noopCaptureView,
    });

    const effect = diagnosticEffect({
      severity: "warning",
      code: "stale-link",
      message: "stale link to wiki/y.md",
      sourceRefs: [REF],
    });
    await sinks.recordDiagnostic({
      effect,
      processorId: PROCESSOR_ID,
      runId: RUN_ID,
      proposalId: "prop_1",
    });

    const got = queryDiagnostics(projectionDb);
    expect(got.length).toBe(1);
    expect(got[0]?.code).toBe("stale-link");
  });

  it("recordQuestion writes a row visible via queryQuestions", async () => {
    const sinks = buildSqliteSinks({
      projectionDb,
      outboxDb,
      adoptedCommit: ADOPTED,
      applyPatch: noopApplyPatch,
      captureView: noopCaptureView,
    });

    const effect = questionEffect({
      question: "what is the dueDate?",
      sourceRefs: [REF],
      idempotencyKey: "q-1",
    });
    await sinks.recordQuestion({
      effect,
      processorId: PROCESSOR_ID,
      runId: RUN_ID,
    });

    const got = queryQuestions(projectionDb);
    expect(got.length).toBe(1);
    expect(got[0]?.idempotencyKey).toBe("q-1");
  });

  it("enqueueJob writes a row visible via nextEligibleJob", async () => {
    const sinks = buildSqliteSinks({
      projectionDb,
      outboxDb,
      adoptedCommit: ADOPTED,
      applyPatch: noopApplyPatch,
      captureView: noopCaptureView,
    });

    const effect = jobEffect({
      processorId: "dome.target",
      input: { x: 1 },
      idempotencyKey: "j-1",
    });
    await sinks.enqueueJob({
      effect,
      processorId: PROCESSOR_ID,
      runId: RUN_ID,
    });

    const next = nextEligibleJob(projectionDb, new Date());
    expect(next).not.toBeNull();
    expect(next?.idempotencyKey).toBe("j-1");
  });

  it("dispatchExternal writes a row and dispatches through the outbox handler", async () => {
    const calls: string[] = [];
    const sinks = buildSqliteSinks({
      projectionDb,
      outboxDb,
      adoptedCommit: ADOPTED,
      applyPatch: noopApplyPatch,
      captureView: noopCaptureView,
      externalHandlers: {
        "calendar.write": async ({ idempotencyKey }) => {
          calls.push(idempotencyKey);
          return { externalId: "ext-1" };
        },
      },
    });

    const effect = externalActionEffect({
      capability: "calendar.write",
      idempotencyKey: "ext-1",
      payload: { event: "x" },
      sourceRefs: [REF],
    });
    await sinks.dispatchExternal({
      effect,
      processorId: PROCESSOR_ID,
      runId: RUN_ID,
    });

    const got = queryOutbox(outboxDb);
    expect(got.length).toBe(1);
    expect(got[0]?.idempotencyKey).toBe("ext-1");
    expect(got[0]?.status).toBe("sent");
    expect(got[0]?.externalId).toBe("ext-1");
    expect(calls).toEqual(["ext-1"]);
  });
});

describe("buildSqliteSinks pass-through injections", () => {
  it("applyPatch is invoked with the input verbatim (pass-through)", async () => {
    const calls: Array<{
      effect: PatchEffect;
      processorId: string;
      runId: string;
      candidate: string;
    }> = [];
    const spyApplyPatch: ApplyEffectSinks["applyPatch"] = async (input) => {
      calls.push({
        effect: input.effect,
        processorId: input.processorId,
        runId: input.runId,
        candidate: input.candidate,
      });
      return null;
    };

    const sinks = buildSqliteSinks({
      projectionDb,
      outboxDb,
      adoptedCommit: ADOPTED,
      applyPatch: spyApplyPatch,
      captureView: noopCaptureView,
    });

    const effect = patchEffect({
      mode: "auto",
      changes: [{ kind: "write", path: "wiki/x.md", content: "x\n" }],
      reason: "fix",
      sourceRefs: [REF],
    });
    await sinks.applyPatch({
      effect,
      processorId: PROCESSOR_ID,
      runId: RUN_ID,
      candidate: ADOPTED,
    });

    expect(calls.length).toBe(1);
    expect(calls[0]?.effect).toBe(effect);
    expect(calls[0]?.processorId).toBe(PROCESSOR_ID);
    expect(calls[0]?.runId).toBe(RUN_ID);
    expect(calls[0]?.candidate).toBe(ADOPTED);
  });

  it("captureView is invoked with the input verbatim (pass-through)", async () => {
    const calls: Array<{
      effect: ViewEffect;
      processorId: string;
      runId: string;
    }> = [];
    const spyCaptureView: ApplyEffectSinks["captureView"] = async (input) => {
      calls.push({
        effect: input.effect,
        processorId: input.processorId,
        runId: input.runId,
      });
    };

    const sinks = buildSqliteSinks({
      projectionDb,
      outboxDb,
      adoptedCommit: ADOPTED,
      applyPatch: noopApplyPatch,
      captureView: spyCaptureView,
    });

    const effect = viewEffect({
      name: "test-view",
      content: { kind: "markdown", body: "# hi" },
      scope: [REF],
    });
    await sinks.captureView({
      effect,
      processorId: PROCESSOR_ID,
      runId: RUN_ID,
    });

    expect(calls.length).toBe(1);
    expect(calls[0]?.effect).toBe(effect);
    expect(calls[0]?.processorId).toBe(PROCESSOR_ID);
    expect(calls[0]?.runId).toBe(RUN_ID);
  });
});
