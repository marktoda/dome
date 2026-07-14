import { describe, expect, test } from "bun:test";

import {
  AgentRuntimeError,
  createAgentRuntime,
  type AgentEvent,
  type AgentRun,
} from "../../src/assistant/runtime";
import type { AgentMessage } from "../../src/assistant/types";

function stream(text: string): AgentRun {
  return {
    text: (async function* (): AsyncIterable<string> {
      yield text;
    })(),
    finished: Promise.resolve({
      citations: [{ path: "wiki/source.md", commit: "c1" }],
      changes: [],
      stopReason: "final",
    }),
  };
}

async function drainText(events: AsyncIterable<{ kind: string; text?: string }>): Promise<string> {
  let text = "";
  for await (const event of events) {
    if (event.kind === "text") text += event.text ?? "";
  }
  return text;
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function context(deviceId: string) {
  return { deviceId, capabilities: new Set(["converse" as const]) };
}

describe("AgentRuntime", () => {
  test("passes a matching per-turn mutation actor and omits device-mismatched attribution", async () => {
    const seen: unknown[] = [];
    const runtime = createAgentRuntime({
      runTurn: ({ mutationActor }) => {
        seen.push(mutationActor);
        return stream("ok");
      },
    });
    const session = runtime.createSession({ deviceId: "device-1", capabilities: new Set(["capture"]) });
    const actor = { requestId: "request-1", actorId: "owner" as const, deviceId: "device-1", credentialId: "credential-1", transport: "cookie" as const };
    await collect(session.send("one", undefined, actor).events);
    await collect(session.send("two", undefined, { ...actor, requestId: "request-2", deviceId: "device-2" }).events);
    expect(seen).toEqual([actor, undefined]);
    runtime.close();
  });
  test("preserves prose history across turns in one session", async () => {
    const seen: Array<ReadonlyArray<AgentMessage>> = [];
    const runtime = createAgentRuntime({
      createId: () => "session-1",
      runTurn: ({ question, history }) => {
        seen.push(history);
        return stream(`answer:${question}`);
      },
    });
    const session = runtime.createSession();

    expect(await drainText(session.send("first").events)).toBe("answer:first");
    expect(await drainText(session.send("second").events)).toBe("answer:second");

    expect(seen[0]).toEqual([]);
    expect(seen[1]).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "answer:first" },
    ]);
  });

  test("isolates histories between sessions", async () => {
    let id = 0;
    const seen = new Map<string, number>();
    const runtime = createAgentRuntime({
      createId: () => `s${++id}`,
      runTurn: ({ question, history }) => {
        seen.set(question, history.length);
        return stream("ok");
      },
    });
    const one = runtime.createSession();
    const two = runtime.createSession();

    await drainText(one.send("one-a").events);
    await drainText(one.send("one-b").events);
    await drainText(two.send("two-a").events);

    expect(seen.get("one-b")).toBe(2);
    expect(seen.get("two-a")).toBe(0);
  });

  test("closed and missing sessions cannot be resumed", () => {
    const runtime = createAgentRuntime({
      createId: () => "s1",
      runTurn: () => stream("unused"),
    });
    runtime.createSession();
    expect(runtime.getSession("s1")?.id).toBe("s1");
    expect(runtime.closeSession("s1")).toBe(true);
    expect(runtime.getSession("s1")).toBeNull();
    expect(runtime.closeSession("s1")).toBe(false);
  });

  test("bounds total and per-device sessions with typed admission failures", () => {
    let id = 0;
    const runtime = createAgentRuntime({
      createId: () => `s${++id}`,
      runTurn: () => stream("unused"),
      limits: { maxSessions: 3, maxSessionsPerDevice: 1 },
    });
    runtime.createSession(context("phone"));
    const sameDevice = runtime.tryCreateSession(context("phone"));
    expect(sameDevice).toMatchObject({
      ok: false,
      failure: { code: "device-session-limit", retryable: true },
    });
    runtime.createSession(context("desktop"));
    runtime.createSession(context("tablet"));
    expect(runtime.tryCreateSession(context("watch"))).toMatchObject({
      ok: false,
      failure: { code: "session-limit", retryable: true },
    });
    expect(() => runtime.createSession(context("watch"))).toThrow(AgentRuntimeError);
    try {
      runtime.createSession(context("watch"));
    } catch (error) {
      expect(error).toMatchObject({ code: "session-limit", retryable: true });
    }
  });

  test("expires idle and absolute sessions on deterministic access and create cleanup", async () => {
    let at = 0;
    let id = 0;
    const runtime = createAgentRuntime({
      createId: () => `s${++id}`,
      now: () => at,
      runTurn: () => stream("ok"),
      limits: {
        maxSessions: 1,
        maxSessionsPerDevice: 1,
        idleTtlMs: 10,
        absoluteTtlMs: 20,
      },
    });
    const idle = runtime.createSession(context("phone"));
    at = 10;
    expect(runtime.lookupSession(idle.id)).toEqual({ kind: "expired", ownerDeviceId: "phone" });
    const replacement = runtime.createSession(context("phone"));
    await collect(replacement.send("hello").events);
    at = 30;
    expect(runtime.lookupSession(replacement.id)).toEqual({ kind: "expired", ownerDeviceId: "phone" });
    expect(runtime.getSession(replacement.id)).toBeNull();
  });

  test("bounds completed turns, message size, and retained history", async () => {
    const seen: ReadonlyArray<AgentMessage>[] = [];
    const runtime = createAgentRuntime({
      createId: () => "bounded",
      runTurn: ({ history }) => {
        seen.push(history);
        return stream("answer");
      },
      limits: {
        maxCompletedTurns: 3,
        maxMessageChars: 8,
        maxHistoryMessages: 2,
        maxHistoryChars: 100,
      },
    });
    const session = runtime.createSession();
    expect(session.send("123456789").failure).toMatchObject({ code: "message-too-large" });
    await collect(session.send("one").events);
    await collect(session.send("two").events);
    await collect(session.send("three").events);
    expect(seen[0]).toEqual([]);
    expect(seen[1]).toEqual([
      { role: "user", content: "one" },
      { role: "assistant", content: "answer" },
    ]);
    expect(seen[2]).toEqual([
      { role: "user", content: "two" },
      { role: "assistant", content: "answer" },
    ]);
    expect(session.send("four").failure).toMatchObject({
      code: "turn-limit",
      retryable: false,
    });
  });

  test("enforces global and per-device active-turn limits", async () => {
    let releasePhone!: () => void;
    let releaseDesktop!: () => void;
    const phoneGate = new Promise<void>((resolve) => { releasePhone = resolve; });
    const desktopGate = new Promise<void>((resolve) => { releaseDesktop = resolve; });
    const runtime = createAgentRuntime({
      createId: (() => { let id = 0; return () => `s${++id}`; })(),
      runTurn: ({ question }) => ({
        text: (async function* () {
          await (question === "phone" ? phoneGate : desktopGate);
          yield "done";
        })(),
        finished: (question === "phone" ? phoneGate : desktopGate).then(() => ({
          citations: [], changes: [], stopReason: "final" as const,
        })),
      }),
      limits: { maxActiveTurns: 2, maxActiveTurnsPerDevice: 1 },
    });
    const phoneOne = runtime.createSession(context("phone"));
    const phoneTwo = runtime.createSession(context("phone"));
    const desktop = runtime.createSession(context("desktop"));
    const tablet = runtime.createSession(context("tablet"));
    const phoneDrain = collect(phoneOne.send("phone").events);
    await Promise.resolve();
    expect(phoneTwo.send("phone-two").failure).toMatchObject({
      code: "device-turn-capacity",
    });
    const desktopDrain = collect(desktop.send("desktop").events);
    await Promise.resolve();
    expect(tablet.send("tablet").failure).toMatchObject({ code: "turn-capacity" });
    releasePhone();
    releaseDesktop();
    await Promise.all([phoneDrain, desktopDrain]);
    expect(tablet.send("tablet").failure).toBeUndefined();
  });

  test("cancellation aborts the runner but holds its slot until cooperative exit", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let runnerSignal: AbortSignal | undefined;
    const runtime = createAgentRuntime({
      createId: (() => { let id = 0; return () => `s${++id}`; })(),
      runTurn: ({ signal }) => {
        runnerSignal = signal;
        return {
          text: (async function* () {
            // Deliberately ignores abort until the provider operation returns.
            await gate;
            yield "late";
          })(),
          finished: gate.then(() => ({ citations: [], changes: [], stopReason: "final" as const })),
        };
      },
      limits: { maxActiveTurns: 1, maxActiveTurnsPerDevice: 1 },
    });
    const first = runtime.createSession(context("phone"));
    const second = runtime.createSession(context("desktop"));
    const draining = collect(first.send("wait").events);
    await Promise.resolve();
    expect(first.cancel()).toEqual({ kind: "cancelled" });
    expect(runnerSignal?.aborted).toBe(true);
    expect(second.send("blocked").failure).toMatchObject({ code: "turn-capacity" });
    release();
    expect(await draining).toContainEqual({
      kind: "error",
      code: "turn-cancelled",
      message: "agent turn cancelled",
    });
    const after = second.send("now available");
    expect(after.failure).toBeUndefined();
    release();
    await collect(after.events);
  });

  test("turn timeout aborts the runner and reports a typed terminal error", async () => {
    const runtime = createAgentRuntime({
      runTurn: ({ signal }) => {
        const aborted = new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }));
        return {
          text: (async function* () { await aborted; yield "late"; })(),
          finished: aborted.then(() => ({
            citations: [], changes: [], stopReason: "final" as const,
          })),
        };
      },
      limits: { turnTimeoutMs: 5 },
    });
    expect(await collect(runtime.createSession().send("wait").events)).toContainEqual({
      kind: "error",
      code: "turn-timeout",
      message: "agent turn timed out",
    });
  });

  test("an unconsumed admitted turn releases capacity at its timeout", async () => {
    const runtime = createAgentRuntime({
      runTurn: () => stream("unused"),
      limits: { maxActiveTurns: 1, turnTimeoutMs: 5 },
    });
    runtime.createSession(context("phone")).send("never consumed");
    const second = runtime.createSession(context("desktop"));
    expect(second.send("blocked").failure?.code).toBe("turn-capacity");
    await Bun.sleep(10);
    expect(second.send("available").failure).toBeUndefined();
  });

  test("late consumption preserves timeout causes after abort-reason collection", async () => {
    const runtime = createAgentRuntime({
      runTurn: () => stream("unused"),
      limits: {
        maxSessions: 10,
        maxSessionsPerDevice: 10,
        maxActiveTurns: 10,
        maxActiveTurnsPerDevice: 10,
        turnTimeoutMs: 1,
      },
    });
    const turns = Array.from(
      { length: 10 },
      () => runtime.createSession(context("phone")).send("never consumed"),
    );

    await Bun.sleep(5);
    Bun.gc(true);

    const terminalEvents = await Promise.all(turns.map((turn) => collect(turn.events)));
    expect(terminalEvents.map((events) => events[0])).toEqual(
      Array.from({ length: 10 }, () => ({
        kind: "error",
        code: "turn-timeout",
        message: "agent turn timed out",
      })),
    );
  });

  test("late consumption of a timed-out turn cannot release its replacement turn", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = createAgentRuntime({
      runTurn: ({ question }) => question === "new"
        ? {
            text: (async function* () { await gate; yield "done"; })(),
            finished: gate.then(() => ({ citations: [], changes: [], stopReason: "final" as const })),
          }
        : stream("stale"),
      limits: { maxActiveTurns: 1, turnTimeoutMs: 5 },
    });
    const session = runtime.createSession(context("phone"));
    const stale = session.send("old");
    await Bun.sleep(10);
    const current = collect(session.send("new").events);
    await Promise.resolve();
    expect(await collect(stale.events)).toContainEqual({
      kind: "error", code: "turn-timeout", message: "agent turn timed out",
    });
    expect(runtime.createSession(context("desktop")).send("third").failure?.code)
      .toBe("turn-capacity");
    release();
    await current;
  });

  test("cancelling an unconsumed turn cannot let its old timer release a replacement", async () => {
    const runtime = createAgentRuntime({
      runTurn: () => stream("unused"),
      limits: { maxActiveTurns: 1, turnTimeoutMs: 30 },
    });
    const session = runtime.createSession(context("phone"));
    session.send("old unconsumed");
    await Bun.sleep(20);
    expect(session.cancel()).toEqual({ kind: "cancelled" });
    session.send("replacement unconsumed");
    await Bun.sleep(15);
    expect(runtime.createSession(context("desktop")).send("third").failure?.code)
      .toBe("turn-capacity");
  });

  test("absolute session expiry aborts an active runner and retains its slot until exit", async () => {
    let at = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = createAgentRuntime({
      now: () => at,
      runTurn: () => ({
        text: (async function* () { await gate; yield "late"; })(),
        finished: gate.then(() => ({ citations: [], changes: [], stopReason: "final" as const })),
      }),
      limits: { absoluteTtlMs: 5, turnTimeoutMs: 50, maxActiveTurns: 1 },
    });
    const first = runtime.createSession(context("phone"));
    const draining = collect(first.send("wait").events);
    await Promise.resolve();
    at = 5;
    expect(runtime.lookupSession(first.id)).toMatchObject({ kind: "expired", ownerDeviceId: "phone" });
    const second = runtime.createSession(context("desktop"));
    expect(second.send("blocked").failure?.code).toBe("turn-capacity");
    release();
    expect(await draining).toContainEqual({
      kind: "error", code: "session-expired", message: "agent session expired",
    });
    expect(second.send("available").failure).toBeUndefined();
  });

  test("expired ownership tombstones are bounded", () => {
    let at = 0;
    let id = 0;
    const runtime = createAgentRuntime({
      now: () => at,
      createId: () => `expired-${++id}`,
      runTurn: () => stream("unused"),
      limits: { maxSessions: 1, idleTtlMs: 5, absoluteTtlMs: 100 },
    });
    const first = runtime.createSession(context("phone"));
    at = 5; runtime.createSession(context("phone"));
    at = 10; runtime.createSession(context("phone"));
    at = 15; runtime.createSession(context("phone"));
    expect(runtime.lookupSession(first.id)).toEqual({ kind: "not-found" });
    expect(runtime.lookupSession("expired-2")).toMatchObject({
      kind: "expired", ownerDeviceId: "phone",
    });
  });

  test("closing an unconsumed turn immediately releases session capacity", () => {
    const runtime = createAgentRuntime({
      runTurn: () => stream("unused"),
      limits: { maxSessions: 1 },
    });
    const first = runtime.createSession();
    first.send("unconsumed");
    expect(runtime.closeSession(first.id)).toBe(true);
    expect(runtime.tryCreateSession()).toMatchObject({ ok: true });
  });
});
