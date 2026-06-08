// Smoke tests for src/processors/triggers.ts: matchTriggers per-kind dispatch
// (signal, path, schedule no-op, command no-op), pure-function determinism,
// and frozen outputs.

import { describe, test, expect } from "bun:test";
import { matchTriggers } from "../../src/processors/triggers";
import type { Trigger } from "../../src/core/processor";
import type { SignalEvent } from "../../src/engine/compile-range";

const events: ReadonlyArray<SignalEvent> = Object.freeze([
  Object.freeze<SignalEvent>({ signal: "file.created", path: "wiki/a.md" }),
  Object.freeze<SignalEvent>({ signal: "file.modified", path: "wiki/b.md" }),
  Object.freeze<SignalEvent>({ signal: "file.modified", path: "inbox/c.md" }),
  Object.freeze<SignalEvent>({ signal: "file.deleted", path: "wiki/d.md" }),
]);

describe("matchTriggers — signal triggers", () => {
  test("signal trigger with no pathPattern matches every SignalEvent whose signal matches", () => {
    const triggers: ReadonlyArray<Trigger> = [
      { kind: "signal", name: "file.modified" },
    ];
    const r = matchTriggers(triggers, events);
    expect(r.length).toBe(1);
    expect(r[0]?.trigger).toBe(triggers[0]!);
    expect(r[0]?.matchedSignals.map((e) => e.path)).toEqual([
      "wiki/b.md",
      "inbox/c.md",
    ]);
  });

  test("signal trigger with pathPattern filters to events whose path matches the glob", () => {
    const triggers: ReadonlyArray<Trigger> = [
      { kind: "signal", name: "file.modified", pathPattern: "wiki/**" },
    ];
    const r = matchTriggers(triggers, events);
    expect(r.length).toBe(1);
    expect(r[0]?.matchedSignals.map((e) => e.path)).toEqual(["wiki/b.md"]);
  });

  test("signal trigger whose name matches no event returns no TriggerMatch", () => {
    const triggers: ReadonlyArray<Trigger> = [
      { kind: "signal", name: "link.added" },
    ];
    const r = matchTriggers(triggers, events);
    expect(r.length).toBe(0);
  });
});

describe("matchTriggers — path triggers", () => {
  test("path trigger matches every SignalEvent whose path matches, regardless of signal", () => {
    const triggers: ReadonlyArray<Trigger> = [
      { kind: "path", pattern: "wiki/**/*.md" },
    ];
    const r = matchTriggers(triggers, events);
    expect(r.length).toBe(1);
    // wiki/a.md (created), wiki/b.md (modified), wiki/d.md (deleted)
    expect(r[0]?.matchedSignals.map((e) => e.path)).toEqual([
      "wiki/a.md",
      "wiki/b.md",
      "wiki/d.md",
    ]);
  });

  test("path trigger that matches no path returns no TriggerMatch", () => {
    const triggers: ReadonlyArray<Trigger> = [
      { kind: "path", pattern: "outbox/**" },
    ];
    const r = matchTriggers(triggers, events);
    expect(r.length).toBe(0);
  });
});

describe("matchTriggers — schedule + command no-ops (Phase 3 scope limit)", () => {
  test("schedule trigger returns no match — runtime owns schedule dispatch", () => {
    const triggers: ReadonlyArray<Trigger> = [
      { kind: "schedule", cron: "0 0 * * *" },
    ];
    const r = matchTriggers(triggers, events);
    expect(r.length).toBe(0);
  });

  test("command trigger returns no match — CLI/MCP layer owns command dispatch", () => {
    const triggers: ReadonlyArray<Trigger> = [
      { kind: "command", name: "doctor" },
    ];
    const r = matchTriggers(triggers, events);
    expect(r.length).toBe(0);
  });

  test("answer trigger returns no match — answer dispatcher owns answer dispatch", () => {
    const triggers: ReadonlyArray<Trigger> = [
      { kind: "answer", idempotencyKeyPrefix: "dome.agent." },
    ];
    const r = matchTriggers(triggers, events);
    expect(r.length).toBe(0);
  });
});

describe("matchTriggers — composition + invariants", () => {
  test("empty signals input → empty result", () => {
    const triggers: ReadonlyArray<Trigger> = [
      { kind: "signal", name: "file.modified" },
      { kind: "path", pattern: "wiki/**" },
    ];
    const r = matchTriggers(triggers, []);
    expect(r.length).toBe(0);
  });

  test("multiple matching triggers in one processor → all are returned in input order", () => {
    const triggers: ReadonlyArray<Trigger> = [
      { kind: "signal", name: "file.created" },
      { kind: "path", pattern: "wiki/**/*.md" },
    ];
    const r = matchTriggers(triggers, events);
    expect(r.length).toBe(2);
    expect(r[0]?.trigger.kind).toBe("signal");
    expect(r[1]?.trigger.kind).toBe("path");
  });

  test("each TriggerMatch's matchedSignals is a subset of input signals (no synthesis)", () => {
    const triggers: ReadonlyArray<Trigger> = [
      { kind: "signal", name: "file.modified" },
    ];
    const r = matchTriggers(triggers, events);
    expect(r.length).toBe(1);
    for (const matched of r[0]?.matchedSignals ?? []) {
      // Identity check: every matched event must be one of the input events.
      expect(events.includes(matched)).toBe(true);
    }
  });

  test("result and every TriggerMatch's matchedSignals array are frozen", () => {
    const triggers: ReadonlyArray<Trigger> = [
      { kind: "path", pattern: "wiki/**/*.md" },
    ];
    const r = matchTriggers(triggers, events);
    expect(Object.isFrozen(r)).toBe(true);
    expect(r.length).toBe(1);
    expect(Object.isFrozen(r[0]!)).toBe(true);
    expect(Object.isFrozen(r[0]!.matchedSignals)).toBe(true);
  });
});
