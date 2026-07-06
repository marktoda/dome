// Smoke tests for src/projections/sinks.ts: the buildSqliteSinks factory
// composes the projection-store/outbox sinks against real sqlite handles, and
// passes through the two engine-layer injections (applyPatch, captureView)
// verbatim. Each test exercises one sink callback end-to-end
// by asserting a row is visible via the corresponding read accessor.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  diagnosticEffect,
  externalActionEffect,
  factEffect,
  outboxRecoveryEffect,
  patchEffect,
  quarantineRecoveryEffect,
  questionEffect,
  runRecoveryEffect,
  viewEffect,
  type PatchEffect,
  type QuarantineRecoveryEffect,
  type RunRecoveryEffect,
  type ViewEffect,
} from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { openProjectionDb, type ProjectionDb } from "../../src/projections/db";
import { openOutboxDb, type OutboxDb } from "../../src/outbox/db";
import { buildSqliteSinks } from "../../src/projections/sinks";
import { factsBySubject } from "../../src/projections/facts";
import { queryDiagnostics } from "../../src/projections/diagnostics";
import { answerQuestion, queryQuestions } from "../../src/projections/questions";
import { insertPending, markFailed, queryOutbox } from "../../src/outbox/dispatch";
import { openProposalsDb, type ProposalsDb } from "../../src/proposals/db";
import { getProposal } from "../../src/proposals/pending-proposals";
import type { ApplyEffectSinks } from "../../src/engine/core/apply-effect";
import type { RunId } from "../../src/engine/core/runner-contract";

const ADOPTED = commitOid("abcdef0000000000000000000000000000000000");
const REF = sourceRef({ commit: ADOPTED, path: "wiki/x.md" });

const PROCESSOR_ID = "test.proc";
const RUN_ID = "run-1" as RunId;

// Default no-op injections for the two engine-layer sinks. Individual tests
// override these to verify the pass-through invocation.
const noopApplyPatch: ApplyEffectSinks["applyPatch"] = async () => null;
const noopCaptureView: ApplyEffectSinks["captureView"] = async () => undefined;
const noopRecoverQuarantine: ApplyEffectSinks["recoverQuarantine"] =
  async () => true;
const noopRecoverRun: ApplyEffectSinks["recoverRun"] = async () => true;

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
    capabilityPolicyHash: "test-policy",
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
  it("returns a frozen object with all sink callbacks", () => {
    const sinks = buildSqliteSinks({
      projectionDb,
      outboxDb,
      adoptedCommit: ADOPTED,
      applyPatch: noopApplyPatch,
      captureView: noopCaptureView,
      recoverQuarantine: noopRecoverQuarantine,
      recoverRun: noopRecoverRun,
    });

    expect(Object.isFrozen(sinks)).toBe(true);
    expect(typeof sinks.applyPatch).toBe("function");
    expect(typeof sinks.recordDiagnostic).toBe("function");
    expect(typeof sinks.resolveDiagnostics).toBe("function");
    expect(typeof sinks.resolveFacts).toBe("function");
    expect(typeof sinks.resolveQuestions).toBe("function");
    expect(typeof sinks.recordFact).toBe("function");
    expect(typeof sinks.recordSearchDocument).toBe("function");
    expect(typeof sinks.recordQuestion).toBe("function");
    expect(typeof sinks.dispatchExternal).toBe("function");
    expect(typeof sinks.recoverOutbox).toBe("function");
    expect(typeof sinks.recoverQuarantine).toBe("function");
    expect(typeof sinks.recoverRun).toBe("function");
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
      recoverQuarantine: noopRecoverQuarantine,
      recoverRun: noopRecoverRun,
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

  it("resolveFacts clears stale page facts before replacement inserts", async () => {
    const sinks = buildSqliteSinks({
      projectionDb,
      outboxDb,
      adoptedCommit: ADOPTED,
      applyPatch: noopApplyPatch,
      captureView: noopCaptureView,
      recoverQuarantine: noopRecoverQuarantine,
      recoverRun: noopRecoverRun,
    });

    const stale = factEffect({
      subject: { kind: "page", path: "wiki/alice.md" },
      predicate: "dome.graph.links_to",
      object: { kind: "string", value: "old-target" },
      assertion: "extracted",
      sourceRefs: [REF],
    });
    const fresh = factEffect({
      subject: { kind: "page", path: "wiki/alice.md" },
      predicate: "dome.graph.links_to",
      object: { kind: "string", value: "new-target" },
      assertion: "extracted",
      sourceRefs: [REF],
    });

    await sinks.recordFact({
      effect: stale,
      processorId: PROCESSOR_ID,
      runId: RUN_ID,
    });
    await sinks.resolveFacts?.({
      processorId: PROCESSOR_ID,
      runId: RUN_ID,
      inspectedPaths: ["wiki/alice.md"],
    });
    await sinks.recordFact({
      effect: fresh,
      processorId: PROCESSOR_ID,
      runId: RUN_ID,
    });

    const got = factsBySubject(projectionDb, {
      kind: "page",
      path: "wiki/alice.md",
    });
    expect(got.length).toBe(1);
    expect(got[0]?.object).toEqual({ kind: "string", value: "new-target" });
  });

  it("recordDiagnostic writes a row visible via queryDiagnostics", async () => {
    const sinks = buildSqliteSinks({
      projectionDb,
      outboxDb,
      adoptedCommit: ADOPTED,
      applyPatch: noopApplyPatch,
      captureView: noopCaptureView,
      recoverQuarantine: noopRecoverQuarantine,
      recoverRun: noopRecoverRun,
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
      recoverQuarantine: noopRecoverQuarantine,
      recoverRun: noopRecoverRun,
    });

    const effect = questionEffect({
      question: "what is the dueDate?",
      sourceRefs: [REF],
      idempotencyKey: "q-1",
      metadata: {
        risk: "low",
        confidence: 1,
        automationPolicy: "agent-safe",
      },
    });
    await sinks.recordQuestion({
      effect,
      processorId: PROCESSOR_ID,
      runId: RUN_ID,
    });

    const got = queryQuestions(projectionDb);
    expect(got.length).toBe(1);
    expect(got[0]?.idempotencyKey).toBe("q-1");
    expect(got[0]?.metadata?.automationPolicy).toBe("agent-safe");
  });

  it("recordQuestion fires onQuestionsChanged for inserts/refreshes but NOT for answered rows", async () => {
    let fired = 0;
    const sinks = buildSqliteSinks({
      projectionDb,
      outboxDb,
      adoptedCommit: ADOPTED,
      applyPatch: noopApplyPatch,
      captureView: noopCaptureView,
      recoverQuarantine: noopRecoverQuarantine,
      recoverRun: noopRecoverRun,
      onQuestionsChanged: () => {
        fired += 1;
      },
    });

    const effect = questionEffect({
      question: "still current?",
      sourceRefs: [REF],
      idempotencyKey: "q-signal",
    });
    const input = { effect, processorId: PROCESSOR_ID, runId: RUN_ID };

    await sinks.recordQuestion(input); // fresh insert
    expect(fired).toBe(1);
    await sinks.recordQuestion(input); // refresh of the open row
    expect(fired).toBe(2);

    answerQuestion(projectionDb, { idempotencyKey: "q-signal", answer: "yes" });
    await sinks.recordQuestion(input); // skipped-answered: open set unchanged
    expect(fired).toBe(2);
  });

  it("resolveQuestions fires onQuestionsChanged only when stale rows were deleted", async () => {
    let fired = 0;
    const sinks = buildSqliteSinks({
      projectionDb,
      outboxDb,
      adoptedCommit: ADOPTED,
      applyPatch: noopApplyPatch,
      captureView: noopCaptureView,
      recoverQuarantine: noopRecoverQuarantine,
      recoverRun: noopRecoverRun,
      onQuestionsChanged: () => {
        fired += 1;
      },
    });

    const effect = questionEffect({
      question: "stale soon?",
      sourceRefs: [REF],
      idempotencyKey: "q-stale-signal",
    });
    await sinks.recordQuestion({
      effect,
      processorId: PROCESSOR_ID,
      runId: RUN_ID,
    });
    expect(fired).toBe(1);

    // Re-inspection that re-emits the same key deletes nothing — no signal.
    await sinks.resolveQuestions?.({
      processorId: PROCESSOR_ID,
      runId: RUN_ID,
      inspectedPaths: ["wiki/x.md"],
      emittedQuestions: [effect],
    });
    expect(fired).toBe(1);

    // Re-inspection with no re-emit deletes the stale row — signal fires.
    await sinks.resolveQuestions?.({
      processorId: PROCESSOR_ID,
      runId: RUN_ID,
      inspectedPaths: ["wiki/x.md"],
      emittedQuestions: [],
    });
    expect(fired).toBe(2);
  });

  it("dispatchExternal writes a row and dispatches through the outbox handler", async () => {
    const calls: string[] = [];
    const sinks = buildSqliteSinks({
      projectionDb,
      outboxDb,
      adoptedCommit: ADOPTED,
      applyPatch: noopApplyPatch,
      captureView: noopCaptureView,
      recoverQuarantine: noopRecoverQuarantine,
      recoverRun: noopRecoverRun,
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

  it("recoverOutbox retries and abandons failed rows", async () => {
    const sinks = buildSqliteSinks({
      projectionDb,
      outboxDb,
      adoptedCommit: ADOPTED,
      applyPatch: noopApplyPatch,
      captureView: noopCaptureView,
      recoverQuarantine: noopRecoverQuarantine,
      recoverRun: noopRecoverRun,
    });
    for (const key of ["retry-me", "abandon-me"] as const) {
      insertPending(outboxDb, {
        effect: externalActionEffect({
          capability: "calendar.write",
          idempotencyKey: key,
          payload: {},
          sourceRefs: [REF],
        }),
        runId: RUN_ID,
      });
      markFailed(outboxDb, key, "terminal");
    }

    await expect(sinks.recoverOutbox({
      effect: outboxRecoveryEffect({
        action: "retry",
        idempotencyKey: "retry-me",
        reason: "retry after credentials fixed",
        sourceRefs: [REF],
      }),
      processorId: PROCESSOR_ID,
      runId: RUN_ID,
    })).resolves.toBe(true);
    await expect(sinks.recoverOutbox({
      effect: outboxRecoveryEffect({
        action: "abandon",
        idempotencyKey: "abandon-me",
        reason: "no longer needed",
        sourceRefs: [REF],
      }),
      processorId: PROCESSOR_ID,
      runId: RUN_ID,
    })).resolves.toBe(true);

    expect(
      queryOutbox(outboxDb).map((row) => ({
        key: row.idempotencyKey,
        status: row.status,
        lastError: row.lastError,
      })),
    ).toEqual([
      { key: "retry-me", status: "pending", lastError: null },
      { key: "abandon-me", status: "abandoned", lastError: "terminal" },
    ]);
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
      recoverQuarantine: noopRecoverQuarantine,
      recoverRun: noopRecoverRun,
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
      recoverQuarantine: noopRecoverQuarantine,
      recoverRun: noopRecoverRun,
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

  it("recoverQuarantine is invoked with the input verbatim (pass-through)", async () => {
    const calls: Array<{
      effect: QuarantineRecoveryEffect;
      processorId: string;
      runId: string;
    }> = [];
    const spyRecoverQuarantine: ApplyEffectSinks["recoverQuarantine"] =
      async (input) => {
        calls.push({
          effect: input.effect,
          processorId: input.processorId,
          runId: input.runId,
        });
        return true;
      };

    const sinks = buildSqliteSinks({
      projectionDb,
      outboxDb,
      adoptedCommit: ADOPTED,
      applyPatch: noopApplyPatch,
      captureView: noopCaptureView,
      recoverQuarantine: spyRecoverQuarantine,
      recoverRun: noopRecoverRun,
    });

    const effect = quarantineRecoveryEffect({
      action: "reset",
      phase: "garden",
      processorId: "test.proc",
      processorVersion: "0.1.0",
      triggerHash: "trigger-1",
      quarantineId: "quarantine-1",
      quarantinedAt: "2026-05-29T00:00:00.000Z",
      consecutiveRetryableFailures: 3,
      reason: "reset",
      sourceRefs: [REF],
    });
    await sinks.recoverQuarantine({
      effect,
      processorId: PROCESSOR_ID,
      runId: RUN_ID,
    });

    expect(calls.length).toBe(1);
    expect(calls[0]?.effect).toBe(effect);
    expect(calls[0]?.processorId).toBe(PROCESSOR_ID);
    expect(calls[0]?.runId).toBe(RUN_ID);
  });

  it("recoverRun is invoked with the input verbatim (pass-through)", async () => {
    const calls: Array<{
      effect: RunRecoveryEffect;
      processorId: string;
      runId: string;
    }> = [];
    const spyRecoverRun: ApplyEffectSinks["recoverRun"] =
      async (input) => {
        calls.push({
          effect: input.effect,
          processorId: input.processorId,
          runId: input.runId,
        });
        return true;
      };

    const sinks = buildSqliteSinks({
      projectionDb,
      outboxDb,
      adoptedCommit: ADOPTED,
      applyPatch: noopApplyPatch,
      captureView: noopCaptureView,
      recoverQuarantine: noopRecoverQuarantine,
      recoverRun: spyRecoverRun,
    });

    const effect = runRecoveryEffect({
      action: "fail",
      runId: "run_1_orphan",
      startedAt: "2026-05-29T00:00:00.000Z",
      processorId: "test.proc",
      processorVersion: "0.1.0",
      phase: "garden",
      reason: "mark orphan failed",
      sourceRefs: [REF],
    });
    await sinks.recoverRun({
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

describe("buildSqliteSinks enqueueProposal", () => {
  let proposalsDb: ProposalsDb;

  beforeEach(async () => {
    const proposalsPath = join(root, ".dome", "state", "proposals.db");
    const result = await openProposalsDb({ path: proposalsPath });
    if (!result.ok) {
      throw new Error(`openProposalsDb failed: ${JSON.stringify(result.error)}`);
    }
    proposalsDb = result.value.db;
  });

  afterEach(() => {
    try {
      proposalsDb.close();
    } catch {
      // already closed
    }
  });

  const proposePatch: PatchEffect = patchEffect({
    mode: "propose",
    changes: [{ kind: "write", path: "wiki/x.md", content: "new\n" }],
    reason: "garden propose test",
    sourceRefs: [REF],
  });

  it("is omitted when proposalsDb/vaultPath are not supplied", () => {
    const sinks = buildSqliteSinks({
      projectionDb,
      outboxDb,
      adoptedCommit: ADOPTED,
      applyPatch: noopApplyPatch,
      captureView: noopCaptureView,
      recoverQuarantine: noopRecoverQuarantine,
      recoverRun: noopRecoverRun,
    });
    expect(sinks.enqueueProposal).toBeUndefined();
  });

  it("reads the CURRENT working-tree content into baseContents and inserts a row", async () => {
    mkdirSync(join(root, "wiki"), { recursive: true });
    writeFileSync(join(root, "wiki", "x.md"), "old\n", "utf8");

    const changed: string[] = [];
    const sinks = buildSqliteSinks({
      projectionDb,
      outboxDb,
      adoptedCommit: ADOPTED,
      applyPatch: noopApplyPatch,
      captureView: noopCaptureView,
      recoverQuarantine: noopRecoverQuarantine,
      recoverRun: noopRecoverRun,
      proposalsDb,
      vaultPath: root,
      onProposalsChanged: () => {
        changed.push("changed");
      },
    });

    const result = await sinks.enqueueProposal?.({
      effect: proposePatch,
      processorId: PROCESSOR_ID,
      extensionId: "dome.example",
      runId: RUN_ID,
      baseCommit: ADOPTED,
    });

    expect(result?.inserted).toBe(true);
    expect(result?.id).not.toBeNull();
    const row = getProposal(proposalsDb, result!.id!);
    expect(row).not.toBeNull();
    expect(row?.processorId).toBe(PROCESSOR_ID);
    expect(row?.extensionId).toBe("dome.example");
    expect(row?.runId).toBe(RUN_ID);
    expect(row?.baseCommit).toBe(ADOPTED);
    expect(row?.baseContents).toEqual({ "wiki/x.md": "old\n" });
    expect(changed).toEqual(["changed"]);
  });

  it("captures null baseContents for a path that does not exist yet", async () => {
    const sinks = buildSqliteSinks({
      projectionDb,
      outboxDb,
      adoptedCommit: ADOPTED,
      applyPatch: noopApplyPatch,
      captureView: noopCaptureView,
      recoverQuarantine: noopRecoverQuarantine,
      recoverRun: noopRecoverRun,
      proposalsDb,
      vaultPath: root,
    });

    const result = await sinks.enqueueProposal?.({
      effect: proposePatch,
      processorId: PROCESSOR_ID,
      extensionId: "dome.example",
      runId: RUN_ID,
      baseCommit: ADOPTED,
    });

    const row = getProposal(proposalsDb, result!.id!);
    expect(row?.baseContents).toEqual({ "wiki/x.md": null });
  });

  it("fires onProposalsChanged only on a fresh insert, not on a dedupe-hit re-enqueue", async () => {
    const changed: string[] = [];
    const sinks = buildSqliteSinks({
      projectionDb,
      outboxDb,
      adoptedCommit: ADOPTED,
      applyPatch: noopApplyPatch,
      captureView: noopCaptureView,
      recoverQuarantine: noopRecoverQuarantine,
      recoverRun: noopRecoverRun,
      proposalsDb,
      vaultPath: root,
      onProposalsChanged: () => {
        changed.push("changed");
      },
    });

    const first = await sinks.enqueueProposal?.({
      effect: proposePatch,
      processorId: PROCESSOR_ID,
      extensionId: "dome.example",
      runId: RUN_ID,
      baseCommit: ADOPTED,
    });
    const second = await sinks.enqueueProposal?.({
      effect: proposePatch,
      processorId: PROCESSOR_ID,
      extensionId: "dome.example",
      runId: RUN_ID,
      baseCommit: ADOPTED,
    });

    expect(first?.inserted).toBe(true);
    expect(second?.inserted).toBe(false);
    expect(second?.id).toBe(first?.id ?? null);
    expect(changed).toEqual(["changed"]);
  });
});
