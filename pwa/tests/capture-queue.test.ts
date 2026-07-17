import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { CaptureQueue } from "../src/capture/captureQueue";

const VAULT = "vault-public-id";
const deps = {
  now: () => new Date("2026-07-11T12:00:00.000Z"),
  randomId: () => "device:capture-1",
};

describe("CaptureQueue", () => {
  test("save survives reopen with an opaque vault binding", async () => {
    const factory = new IDBFactory();
    await new CaptureQueue(factory).save({ text: " first " }, VAULT, deps);

    const reopened = new CaptureQueue(factory);
    expect(await reopened.all()).toEqual([{
      id: "device:capture-1",
      text: "first",
      createdAt: "2026-07-11T12:00:00.000Z",
      vaultId: VAULT,
      state: "saved-locally",
      attempts: 0,
    }]);
    expect(await reopened.exportJson()).toContain(VAULT);
  });

  test("validated committed receipt removes plaintext without claiming adoption", async () => {
    const factory = new IDBFactory();
    const queue = new CaptureQueue(factory);
    await queue.save({ text: "first" }, VAULT, deps);
    const seen: unknown[] = [];
    const done = await queue.drain(VAULT, async (request) => {
      seen.push(request);
      return capturedReceipt(request.captureId!);
    });

    expect(seen).toEqual([{ text: "first", captureId: "device:capture-1" }]);
    expect(done).toMatchObject([{
      id: "device:capture-1",
      text: "first",
      receipt: { status: "captured", adoption_status: "pending" },
    }]);
    expect(await queue.all()).toEqual([]);
  });

  test("receipt vault and capture identity must both match before deletion", async () => {
    const factory = new IDBFactory();
    const queue = new CaptureQueue(factory);
    await queue.save({ text: "first" }, VAULT, deps);
    await queue.drain(VAULT, async () => ({
      ...capturedReceipt("another-capture"),
      vault: "another-vault",
    }));
    expect(await queue.all()).toMatchObject([{
      state: "failed",
      attempts: 1,
      lastError: "capture receipt did not match the queued vault and capture identity",
    }]);
  });

  test("one failure stays visible without poisoning later bound captures", async () => {
    const factory = new IDBFactory();
    const queue = new CaptureQueue(factory);
    let next = 0;
    await queue.save({ text: "first" }, VAULT, { ...deps, randomId: () => `capture-${++next}` });
    await queue.save({ text: "second" }, VAULT, { ...deps, randomId: () => `capture-${++next}` });
    const seen: string[] = [];
    const done = await queue.drain(VAULT, async (request) => {
      seen.push(request.captureId!);
      if (request.captureId === "capture-1") throw new Error("offline once");
      return capturedReceipt(request.captureId!);
    });

    expect(seen).toEqual(["capture-1", "capture-2"]);
    expect(done.map((item) => item.id)).toEqual(["capture-2"]);
    expect(await queue.all()).toMatchObject([{
      id: "capture-1",
      state: "failed",
      attempts: 1,
      lastError: "offline once",
    }]);
  });

  test("unbound and mismatched rows never replay; unbound binding is explicit and one-way", async () => {
    const factory = new IDBFactory();
    const queue = new CaptureQueue(factory);
    let next = 0;
    await queue.save({ text: "legacy" }, null, { ...deps, randomId: () => `capture-${++next}` });
    await queue.save({ text: "other" }, "another-vault", { ...deps, randomId: () => `capture-${++next}` });
    let sends = 0;
    await queue.drain(VAULT, async (request) => { sends++; return capturedReceipt(request.captureId!); });
    expect(sends).toBe(0);

    expect(await queue.bind("capture-1", VAULT)).toBe(true);
    expect(await queue.bind("capture-1", "third-vault")).toBe(false);
    await queue.drain(VAULT, async (request) => { sends++; return capturedReceipt(request.captureId!); });
    expect(sends).toBe(1);
    expect(await queue.all()).toMatchObject([{ id: "capture-2", vaultId: "another-vault" }]);
  });

  test("legacy missing bindings and persisted sending normalize on reopen", async () => {
    const factory = new IDBFactory();
    await putLegacy(factory, {
      id: "legacy-capture",
      text: "recover me",
      createdAt: "2026-07-11T12:00:00.000Z",
      state: "sending",
      attempts: 2,
    });
    const queue = new CaptureQueue(factory);
    expect(await queue.all()).toEqual([{
      id: "legacy-capture",
      text: "recover me",
      createdAt: "2026-07-11T12:00:00.000Z",
      vaultId: null,
      state: "saved-locally",
      attempts: 2,
      lastError: undefined,
    }]);
    expect(await new CaptureQueue(factory).all()).toEqual(await queue.all());
  });

  test("a cross-instance delete cannot be resurrected by a late failure", async () => {
    const factory = new IDBFactory();
    const drainingQueue = new CaptureQueue(factory);
    const deletingQueue = new CaptureQueue(factory);
    await drainingQueue.save({ text: "first" }, VAULT, deps);
    let rejectSend!: (reason: Error) => void;
    let started!: () => void;
    const sendStarted = new Promise<void>((resolve) => { started = resolve; });
    const draining = drainingQueue.drain(VAULT, () => new Promise((_, reject) => {
      rejectSend = reject;
      started();
    }));

    await sendStarted;
    await deletingQueue.remove("device:capture-1");
    rejectSend(new Error("device-revoked"));
    await draining;
    expect(await drainingQueue.all()).toEqual([]);
  });

  test("a deletion after the drain snapshot prevents the network call", async () => {
    const factory = new IDBFactory();
    const drainingQueue = new CaptureQueue(factory);
    const deletingQueue = new CaptureQueue(factory);
    await drainingQueue.save({ text: "first" }, VAULT, deps);
    const originalAll = drainingQueue.all.bind(drainingQueue);
    drainingQueue.all = async () => {
      const staleSnapshot = await originalAll();
      await deletingQueue.remove("device:capture-1");
      return staleSnapshot;
    };
    let sends = 0;
    await drainingQueue.drain(VAULT, async () => {
      sends++;
      throw new Error("must not send a deleted capture");
    });
    expect(sends).toBe(0);
  });
});

function capturedReceipt(captureId: string) {
  return {
    schema: "dome.capture/v1" as const,
    status: "captured" as const,
    vault: VAULT,
    path: "inbox/raw/first.md",
    commit: "abc",
    capture_id: captureId,
    title: "first",
    captured_at: "2026-07-11T12:00:00.000Z",
    source: "http",
    branch: "main",
    serve_status: "running" as const,
    adopted_initialized: true,
    compile_pending: false,
    commit_status: "committed" as const,
    adoption_status: "pending" as const,
  };
}

async function putLegacy(factory: IDBFactory, value: unknown): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("dome-pwa", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("captures", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("captures", "readwrite");
    transaction.objectStore("captures").put(value);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}
