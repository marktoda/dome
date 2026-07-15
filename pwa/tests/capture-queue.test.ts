import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { CaptureQueue } from "../src/capture/captureQueue";

const deps = {
  now: () => new Date("2026-07-11T12:00:00.000Z"),
  randomId: () => "device:capture-1",
};

describe("CaptureQueue", () => {
  test("save survives reopen and exports visible owner data", async () => {
    const factory = new IDBFactory();
    const q = new CaptureQueue(factory);
    await q.save({ text: " first " }, deps);

    const q2 = new CaptureQueue(factory);
    expect(await q2.all()).toEqual([{
      id: "device:capture-1",
      text: "first",
      createdAt: "2026-07-11T12:00:00.000Z",
      state: "saved-locally",
      attempts: 0,
    }]);
    expect(await q2.exportJson()).toContain("device:capture-1");
  });

  test("drain sends the stable id and removes only after committed receipt", async () => {
    const factory = new IDBFactory();
    const q = new CaptureQueue(factory);
    await q.save({ text: "first" }, deps);
    const seen: unknown[] = [];
    const done = await q.drain(async (request) => {
      seen.push(request);
      return {
        schema: "dome.capture/v1",
        status: "captured",
        vault: "/vault",
        path: "inbox/raw/first.md",
        commit: "abc",
        capture_id: "device:capture-1",
        title: "first",
        captured_at: "2026-07-11T12:00:00.000Z",
        source: "pwa",
        branch: "main",
        serve_status: "running",
        adopted_initialized: true,
        compile_pending: false,
        commit_status: "committed",
        adoption_status: "pending",
      };
    });
    expect(seen).toEqual([{ text: "first", captureId: "device:capture-1" }]);
    expect(done[0]?.receipt.status).toBe("captured");
    expect(await q.all()).toEqual([]);
  });

  test("failure remains visible and retry preserves logical identity", async () => {
    const factory = new IDBFactory();
    const q = new CaptureQueue(factory);
    await q.save({ text: "first" }, deps);
    await q.drain(async () => { throw new Error("offline"); });
    expect(await q.all()).toMatchObject([{
      id: "device:capture-1",
      state: "failed",
      attempts: 1,
      lastError: "offline",
    }]);

    const ids: string[] = [];
    await q.drain(async (request) => {
      ids.push(request.captureId ?? "");
      return {
        schema: "dome.capture/v1",
        status: "duplicate",
        vault: "/vault",
        path: "inbox/processed/first.md",
        capture_id: request.captureId!,
        commit_status: "already-committed",
        adoption_status: "unknown",
      };
    });
    expect(ids).toEqual(["device:capture-1"]);
    expect(await q.all()).toEqual([]);
  });

  test("a cross-instance local delete cannot be resurrected by a late drain failure", async () => {
    const factory = new IDBFactory();
    const drainingQueue = new CaptureQueue(factory);
    const deletingQueue = new CaptureQueue(factory);
    await drainingQueue.save({ text: "first" }, deps);
    let rejectSend!: (reason: Error) => void;
    const draining = drainingQueue.drain(() => new Promise((_, reject) => { rejectSend = reject; }));

    while ((await deletingQueue.all())[0]?.state !== "sending") await Promise.resolve();
    await deletingQueue.remove("device:capture-1");
    rejectSend(new Error("device-revoked"));
    await draining;

    expect(await drainingQueue.all()).toEqual([]);
  });

  test("a deletion after the drain snapshot prevents the sending transition and network call", async () => {
    const factory = new IDBFactory();
    const drainingQueue = new CaptureQueue(factory);
    const deletingQueue = new CaptureQueue(factory);
    await drainingQueue.save({ text: "first" }, deps);
    const originalAll = drainingQueue.all.bind(drainingQueue);
    let intercepted = false;
    drainingQueue.all = async () => {
      const staleSnapshot = await originalAll();
      if (!intercepted) {
        intercepted = true;
        await deletingQueue.remove("device:capture-1");
      }
      return staleSnapshot;
    };
    let sends = 0;

    await drainingQueue.drain(async () => {
      sends++;
      throw new Error("must not send a deleted capture");
    });

    expect(sends).toBe(0);
    expect(await deletingQueue.all()).toEqual([]);
  });
});
