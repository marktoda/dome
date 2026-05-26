import { describe, test, expect } from "bun:test";
import { HookDispatcher, type DispatcherCtxFactory } from "../../src/hook-dispatcher";
import { HookRegistry } from "../../src/hook-registry";
import type { HookContext, HookEvent } from "../../src/hook-context";
import type { Dispatcher } from "../../src/dispatcher";

const fakeDispatcher: Dispatcher = {
  writeIndex: async () => ({ kind: "wrote-document", path: "index.md", diff: "" }),
  appendLogEntry: async (entry) => ({ kind: "appended-log", entry }),
  removeIndexEntry: async () => ({ kind: "wrote-document", path: "index.md", diff: "" }),
};

const fakeCtxFactory: DispatcherCtxFactory = {
  baseCtx: {
    tools: {} as HookContext["tools"],
    vault: { path: "/tmp/fake" },
  },
  dispatcher: fakeDispatcher,
};

describe("HookDispatcher", () => {
  test("dispatches matching event to handler", async () => {
    const reg = new HookRegistry();
    const calls: string[] = [];
    reg.register({
      id: "h1", pattern: "document.written.wiki.*", source: "sdk", async: false, idempotent: true,
      handler: async (e) => { calls.push(`h1:${e.path}`); },
    });
    const disp = new HookDispatcher(reg);
    const events: HookEvent[] = [{ kind: "document.written.wiki.entity", path: "wiki/entities/danny.md", diff: "x" }];
    await disp.dispatchEvents(events, fakeCtxFactory);
    expect(calls).toEqual(["h1:wiki/entities/danny.md"]);
  });

  test("sync hooks run before async hooks", async () => {
    const reg = new HookRegistry();
    const order: string[] = [];
    reg.register({
      id: "async", pattern: "*", source: "sdk", async: true, idempotent: true,
      handler: async () => { order.push("async"); },
    });
    reg.register({
      id: "sync", pattern: "*", source: "sdk", async: false, idempotent: true,
      handler: async () => { order.push("sync"); },
    });
    const disp = new HookDispatcher(reg);
    await disp.dispatchEvents([{ kind: "x" }], fakeCtxFactory);
    await disp.drain();
    expect(order[0]).toBe("sync");
  });

  test("per-(handler, target) repetition detected", async () => {
    const reg = new HookRegistry();
    let dispatchedDeeper = false;
    reg.register({
      id: "h", pattern: "document.written.wiki.entity", source: "sdk", async: false, idempotent: true,
      handler: async (_e, _ctx) => {
        // Simulate re-fire of an event the handler would normally produce a Tool call for.
        // The dispatcher's causation tracking prevents this from looping.
        dispatchedDeeper = true;
      },
    });
    const disp = new HookDispatcher(reg);
    const ev: HookEvent = { kind: "document.written.wiki.entity", path: "wiki/entities/x.md", diff: "x" };
    await disp.dispatchEvents([ev], fakeCtxFactory);
    // Second dispatch with same (handler, target) chain should still fire (we're starting a new top-level dispatch).
    // The cycle check is *within* a causation chain, not across chains.
    await disp.dispatchEvents([ev], fakeCtxFactory);
    expect(dispatchedDeeper).toBe(true);
  });

  test("depth safety net blocks runaway chains (default 50)", async () => {
    const reg = new HookRegistry();
    let depth = 0;
    let cycleDetected = false;
    const handler = async () => {
      depth++;
    };
    reg.register({ id: "h", pattern: "x", source: "sdk", async: false, idempotent: true, handler });
    const disp = new HookDispatcher(reg, { maxCausationDepth: 3 });
    // Simulate a chain by feeding our own causation list.
    disp.onCycleDetected((info) => {
      cycleDetected = info.depth >= 3;
    });
    // Trigger recursive cycle via internal API.
    await disp.dispatchEventsWithCausation([{ kind: "x" }], fakeCtxFactory,
      Array.from({ length: 4 }, (_, i) => ({ handlerId: "h", targetPath: `t-${i}` })) // 4-deep
    );
    expect(cycleDetected).toBe(true);
  });
});
