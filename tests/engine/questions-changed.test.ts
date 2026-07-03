// questions.changed — the operational dispatch channel for question-store
// changes (docs/wiki/specs/processors.md §"Triggers and signals").
//
// Two surfaces under test:
//   1. `insertQuestion` (src/projections/questions.ts) discriminates its
//      outcome — "inserted" | "refreshed" | "skipped-answered" — so the sink
//      layer can decide whether the open-question set actually changed
//      (a re-emit against an answered row must NOT count as a change).
//   2. `runQuestionsChangedSubscribers` (src/engine/operational/
//      questions-changed.ts) dispatches every garden processor subscribed to
//      `{ kind: "signal", name: "questions.changed" }` with a synthesized
//      envelope byte-compatible with what runtime.ts hands real signal fires:
//      `{ kind: "garden", matchedTriggers: [{ trigger,
//         matchedSignals: [{ signal: "questions.changed", path: "" }] }] }`.
//      No compileRange, no path filtering — this signal is store-change-
//      derived, not tree-diff-derived.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { questionEffect } from "../../src/core/effect";
import { defineProcessor, treeOid } from "../../src/core/processor";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { noopSinks } from "../../src/engine/core/apply-effect";
import type { EngineVault } from "../../src/engine/core/vault-shape";
import type { GardenRunDeps } from "../../src/engine/garden/garden-run";
import { runQuestionsChangedSubscribers } from "../../src/engine/operational/questions-changed";
import type { LedgerDb } from "../../src/ledger/db";
import { openProjectionDb, type ProjectionDb } from "../../src/projections/db";
import {
  answerQuestion,
  insertQuestion,
} from "../../src/projections/questions";
import { buildRegistry, type ProcessorRegistry } from "../../src/processors/registry";
import { openTestLedger } from "../support/test-ledger";

const ADOPTED = commitOid("adopted0000000000000000000000000000000000");
const TREE = treeOid("tree000000000000000000000000000000000000");

// ----- insertQuestion result discrimination ---------------------------------

describe("insertQuestion result", () => {
  let root: string;
  let db: ProjectionDb;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "dome-questions-changed-"));
    const r = await openProjectionDb({
      path: join(root, "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    if (!r.ok) {
      throw new Error(`openProjectionDb failed: ${JSON.stringify(r.error)}`);
    }
    db = r.value.db;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(root, { recursive: true, force: true });
  });

  const ref = sourceRef({
    commit: ADOPTED,
    path: "wiki/a.md",
    range: { startLine: 1, endLine: 1 },
  });

  const effect = questionEffect({
    question: "is this the current owner?",
    sourceRefs: [ref],
    idempotencyKey: "q-changed-1",
  });

  const insertOpts = {
    effect,
    processorId: "p1",
    runId: "run-test",
    adoptedCommit: ADOPTED,
  };

  test("returns 'inserted' for a fresh idempotency key", () => {
    expect(insertQuestion(db, insertOpts)).toBe("inserted");
  });

  test("returns 'refreshed' for a re-emit against an unanswered row", () => {
    insertQuestion(db, insertOpts);
    expect(insertQuestion(db, insertOpts)).toBe("refreshed");
  });

  test("returns 'skipped-answered' once the row is answered", () => {
    insertQuestion(db, insertOpts);
    answerQuestion(db, { idempotencyKey: "q-changed-1", answer: "yes" });
    expect(insertQuestion(db, insertOpts)).toBe("skipped-answered");
  });
});

// ----- runQuestionsChangedSubscribers ---------------------------------------

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

let ledger: LedgerDb;
beforeAll(async () => {
  ledger = await openTestLedger();
});
afterAll(() => {
  ledger.close();
});

function makeVault(): EngineVault {
  const root = mkdtempSync(join(tmpdir(), "dome-questions-changed-vault-"));
  roots.push(root);
  return { path: root, config: { git: { auto_commit_workflows: false } } };
}

function baseDeps(vault: EngineVault): GardenRunDeps {
  return {
    vault,
    adopted: ADOPTED,
    resolveTree: async () => TREE,
    sinks: noopSinks(),
    resolveGrants: () => [],
    extensionIdFor: () => "test",
    applyGardenPatchToCandidate: async () => null,
    ledger,
  };
}

function registryOf(
  processors: Parameters<typeof buildRegistry>[0],
): ProcessorRegistry {
  const r = buildRegistry(processors);
  if (!r.ok) throw new Error(`buildRegistry failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

describe("runQuestionsChangedSubscribers", () => {
  test("dispatches exactly the questions.changed subscribers with the synthesized garden envelope", async () => {
    const vault = makeVault();

    const trigger = {
      kind: "signal",
      name: "questions.changed",
    } as const;
    let subscriberInput: unknown;
    const subscriber = defineProcessor({
      id: "test.questions-subscriber",
      version: "0.0.1",
      phase: "garden",
      triggers: [trigger],
      capabilities: [],
      run: async (ctx) => {
        subscriberInput = ctx.input;
        return [];
      },
    });

    // A garden processor on a DIFFERENT signal must not fire on this channel.
    let bystanderRan = false;
    const bystander = defineProcessor({
      id: "test.other-signal",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "signal", name: "file.modified" }],
      capabilities: [],
      run: async () => {
        bystanderRan = true;
        return [];
      },
    });

    const outcome = await runQuestionsChangedSubscribers({
      ...baseDeps(vault),
      registry: registryOf([subscriber, bystander]),
    });

    expect(outcome.dispatched).toBe(1);
    expect(bystanderRan).toBe(false);
    // Envelope byte-compatible with runtime.ts real signal fires.
    expect(subscriberInput).toEqual({
      kind: "garden",
      matchedTriggers: [
        {
          trigger,
          matchedSignals: [{ signal: "questions.changed", path: "" }],
        },
      ],
    });
  });

  test("dispatches nothing when no garden processor subscribes", async () => {
    const vault = makeVault();
    let ran = false;
    const scheduled = defineProcessor({
      id: "test.scheduled-only",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "schedule", cron: "* * * * *" }],
      capabilities: [],
      run: async () => {
        ran = true;
        return [];
      },
    });

    const outcome = await runQuestionsChangedSubscribers({
      ...baseDeps(vault),
      registry: registryOf([scheduled]),
    });

    expect(outcome.dispatched).toBe(0);
    expect(outcome.diagnostics).toEqual([]);
    expect(ran).toBe(false);
  });
});
