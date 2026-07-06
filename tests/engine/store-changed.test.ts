// store-changed — the operational dispatch channel for engine store-change
// signals (docs/wiki/specs/processors.md §"Triggers and signals"). Mirrors
// tests/engine/questions-changed.test.ts: the store-change signals
// `outbox.changed`, `quarantine.changed`, and `proposals.changed` generalize
// the same pattern.
//
// Surfaces under test:
//   1. `runStoreChangedSubscribers` (src/engine/operational/store-changed.ts)
//      dispatches every garden processor subscribed to
//      `{ kind: "signal", name: <store signal> }` with a synthesized envelope
//      byte-compatible with runtime.ts real signal fires (no compileRange, no
//      path filtering — `SignalEvent.path` is "").
//   2. The FIRING SITES that set the host tick-flag: the two internal
//      terminal-failure sites in the outbox dispatcher fire `onOutboxChanged`
//      (a non-terminal retryable attempt does NOT), and the quarantine store
//      fires `onQuarantineChanged` at the threshold-trip and at every clear
//      (a sub-threshold counter tick does NOT). `proposals.changed`'s flag is
//      set by the (later) proposal-enqueue sink; this file only exercises the
//      shared dispatch channel for it.

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

import { externalActionEffect } from "../../src/core/effect";
import { defineProcessor, treeOid } from "../../src/core/processor";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { noopSinks } from "../../src/engine/core/apply-effect";
import type { EngineVault } from "../../src/engine/core/vault-shape";
import type { GardenRunDeps } from "../../src/engine/garden/garden-run";
import {
  runStoreChangedSubscribers,
  type StoreChangeSignal,
} from "../../src/engine/operational/store-changed";
import type { LedgerDb } from "../../src/ledger/db";
import { openOutboxDb, type OutboxDb } from "../../src/outbox/db";
import {
  dispatchExternalEffect,
  dispatchPendingOutbox,
  recoverExpiredDispatching,
} from "../../src/outbox/dispatch";
import { buildProcessorExecutionState } from "../../src/processors/execution-state";
import { buildRegistry, type ProcessorRegistry } from "../../src/processors/registry";
import { openTestLedger } from "../support/test-ledger";

const ADOPTED = commitOid("adopted0000000000000000000000000000000000");
const TREE = treeOid("tree000000000000000000000000000000000000");

// ----- runStoreChangedSubscribers -------------------------------------------

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
  const root = mkdtempSync(join(tmpdir(), "dome-store-changed-vault-"));
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

describe("runStoreChangedSubscribers", () => {
  for (const signal of [
    "outbox.changed",
    "quarantine.changed",
    "proposals.changed",
  ] as const satisfies ReadonlyArray<StoreChangeSignal>) {
    test(`dispatches exactly the ${signal} subscribers with the synthesized garden envelope`, async () => {
      const vault = makeVault();

      const trigger = { kind: "signal", name: signal } as const;
      let subscriberInput: unknown;
      const subscriber = defineProcessor({
        id: "test.store-subscriber",
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

      const outcome = await runStoreChangedSubscribers({
        ...baseDeps(vault),
        storeSignal: signal,
        registry: registryOf([subscriber, bystander]),
      });

      expect(outcome.dispatched).toBe(1);
      expect(bystanderRan).toBe(false);
      expect(subscriberInput).toEqual({
        kind: "garden",
        matchedTriggers: [
          { trigger, matchedSignals: [{ signal, path: "" }] },
        ],
      });
    });
  }

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

    const outcome = await runStoreChangedSubscribers({
      ...baseDeps(vault),
      storeSignal: "outbox.changed",
      registry: registryOf([scheduled]),
    });

    expect(outcome.dispatched).toBe(0);
    expect(outcome.diagnostics).toEqual([]);
    expect(ran).toBe(false);
  });
});

// ----- outbox.changed firing sites ------------------------------------------

const REF = sourceRef({ commit: ADOPTED, path: "wiki/x.md" });

function outboxEffect(idempotencyKey: string) {
  return externalActionEffect({
    capability: "calendar.write",
    idempotencyKey,
    payload: { event: "x" },
    sourceRefs: [REF],
  });
}

describe("outbox.changed firing sites", () => {
  let root: string;
  let db: OutboxDb;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "dome-store-changed-outbox-"));
    const r = await openOutboxDb({ path: join(root, "outbox.db") });
    if (!r.ok) throw new Error(`openOutboxDb failed: ${JSON.stringify(r.error)}`);
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

  test("recordFailedAttempt terminal branch fires onOutboxChanged (missing handler → immediate terminal)", async () => {
    let fired = 0;
    const result = await dispatchExternalEffect(db, {
      effect: outboxEffect("terminal-1"),
      runId: "run-1",
      handlers: {}, // no handler for calendar.write → terminal failure
      onOutboxChanged: () => {
        fired += 1;
      },
    });
    expect(result.kind).toBe("failed");
    expect(fired).toBe(1);
  });

  test("a non-terminal retryable attempt does NOT fire onOutboxChanged", async () => {
    let fired = 0;
    const result = await dispatchExternalEffect(db, {
      effect: outboxEffect("retry-1"),
      runId: "run-1",
      handlers: {
        "calendar.write": async () => {
          throw new Error("transient");
        },
      },
      onOutboxChanged: () => {
        fired += 1;
      },
    });
    // attempts 1 < max 3 → pending, not terminal.
    expect(result.kind).toBe("pending");
    expect(fired).toBe(0);
  });

  test("recoverExpiredDispatching terminal branch fires onOutboxChanged", () => {
    const past = new Date("2020-01-01T00:00:00.000Z").toISOString();
    // A dispatching row whose lease already expired and is one attempt shy of
    // max — recovery consumes the last attempt and sends it terminal.
    db.raw
      .query(
        "INSERT INTO outbox (capability, idempotency_key, payload_json, source_refs, status, attempts, max_attempts, enqueued_at, next_attempt_at, run_id) " +
          "VALUES ('calendar.write', 'expired-1', '{}', '[]', 'dispatching', 2, 3, ?, ?, 'seed')",
      )
      .run(past, past);

    let fired = 0;
    recoverExpiredDispatching(db, new Date(), () => {
      fired += 1;
    });
    expect(fired).toBe(1);
  });

  test("dispatchPendingOutbox threads onOutboxChanged to the terminal drain", async () => {
    // Seed a pending row with no handler; the drain marks it terminally failed.
    const past = new Date(Date.now() - 60_000);
    await dispatchExternalEffect(db, {
      effect: outboxEffect("drain-terminal"),
      runId: "run-1",
      handlers: {},
      now: past,
    }).catch(() => undefined);
    // The row is now failed already from the insert-time dispatch; re-seed a
    // fresh pending row instead to exercise the drain path.
    db.raw
      .query(
        "INSERT INTO outbox (capability, idempotency_key, payload_json, source_refs, status, attempts, max_attempts, enqueued_at, next_attempt_at, run_id) " +
          "VALUES ('calendar.write', 'drain-pending', '{}', '[]', 'pending', 0, 3, ?, ?, 'seed')",
      )
      .run(past.toISOString(), past.toISOString());

    let fired = 0;
    await dispatchPendingOutbox(db, {
      handlers: {}, // missing handler → terminal
      now: new Date(),
      onOutboxChanged: () => {
        fired += 1;
      },
    });
    expect(fired).toBeGreaterThanOrEqual(1);
  });
});

// ----- quarantine.changed firing sites --------------------------------------

const QKEY = Object.freeze({
  phase: "garden" as const,
  processorId: "test.quarantined",
  processorVersion: "0.1.0",
  triggerHash: "trigger-hash-1",
});

describe("quarantine.changed firing sites", () => {
  test("fires exactly once at the threshold-trip, not on sub-threshold ticks", () => {
    let fired = 0;
    const state = buildProcessorExecutionState({
      quarantineThreshold: 3,
      onQuarantineChanged: () => {
        fired += 1;
      },
    });

    state.recordRetryableTerminalFailure(QKEY, "first");
    expect(fired).toBe(0);
    state.recordRetryableTerminalFailure(QKEY, "second");
    expect(fired).toBe(0);
    state.recordRetryableTerminalFailure(QKEY, "third"); // trip
    expect(fired).toBe(1);
    // Further failures on an already-quarantined key do not re-trip.
    state.recordRetryableTerminalFailure(QKEY, "fourth");
    expect(fired).toBe(1);
  });

  test("a sub-threshold counter tick cleared by success does NOT fire", () => {
    let fired = 0;
    const state = buildProcessorExecutionState({
      quarantineThreshold: 3,
      onQuarantineChanged: () => {
        fired += 1;
      },
    });
    state.recordRetryableTerminalFailure(QKEY, "first"); // count 1, no quarantine
    state.recordSuccess(QKEY); // deletes a non-quarantined counter
    expect(fired).toBe(0);
  });

  test("clearQuarantineIfCurrent fires on a successful clear", () => {
    let fired = 0;
    const state = buildProcessorExecutionState({
      quarantineThreshold: 1,
      onQuarantineChanged: () => {
        fired += 1;
      },
    });
    const snapshot = state.recordRetryableTerminalFailure(QKEY, "boom");
    expect(fired).toBe(1);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;
    const cleared = state.clearQuarantineIfCurrent({
      ...QKEY,
      quarantineId: snapshot.quarantineId,
      consecutiveRetryableFailures: snapshot.consecutiveRetryableFailures,
      quarantinedAt: snapshot.quarantinedAt,
    });
    expect(cleared).toBe(true);
    expect(fired).toBe(2);
  });

  test("clearQuarantine fires when it removes a quarantined entry", () => {
    let fired = 0;
    const state = buildProcessorExecutionState({
      quarantineThreshold: 1,
      onQuarantineChanged: () => {
        fired += 1;
      },
    });
    state.recordRetryableTerminalFailure(QKEY, "boom"); // trip (threshold 1)
    expect(fired).toBe(1);
    state.clearQuarantine(QKEY);
    expect(fired).toBe(2);
  });
});
