import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { CaptureQueue } from "../src/capture/captureQueue";

describe("CaptureQueue", () => {
  test("enqueue → all → remove (FIFO, survives reopen)", async () => {
    const factory = new IDBFactory();
    const q = new CaptureQueue(factory);
    await q.enqueue({ id: "1", text: "first" });
    await q.enqueue({ id: "2", text: "second" });
    expect((await q.all()).map((c) => c.text)).toEqual(["first", "second"]);
    await q.remove("1");
    // a fresh instance over the same factory sees the persisted state
    const q2 = new CaptureQueue(factory);
    expect((await q2.all()).map((c) => c.id)).toEqual(["2"]);
  });
});
