import { describe, expect, test } from "bun:test";

import {
  fetchResponseWithin,
  fetchTextWithin,
  pollJsonWithin,
  readControlledResponseText,
  type FixtureFetch,
} from "./support/bounded-http";
import { cleanupOwnedProductFixtures } from "./support/owned-fixture-cleanup";

describe("Product Host bounded HTTP fixtures", () => {
  test("a pre-header stall is aborted before fixture root removal", async () => {
    let aborted = false;
    const events: string[] = [];
    const fetchImpl = stalledBeforeHeaders(() => { aborted = true; });

    await expect(runThenCleanup(
      () => fetchResponseWithin("headers", 5, "http://fixture", {}, fetchImpl),
      events,
    )).rejects.toThrow("headers exceeded 5ms");
    expect(aborted).toBeTrue();
    expect(events).toEqual(["close", "remove:vault"]);
  });

  test("a stalled response body is aborted before fixture root removal", async () => {
    let aborted = false;
    const events: string[] = [];
    const fetchImpl = stalledBody(() => { aborted = true; });

    await expect(runThenCleanup(async () => {
      const controlled = await fetchResponseWithin(
        "headers",
        20,
        "http://fixture",
        {},
        fetchImpl,
      );
      await readControlledResponseText(controlled, 5, "body");
    }, events)).rejects.toThrow("body exceeded 5ms");
    expect(aborted).toBeTrue();
    expect(events).toEqual(["close", "remove:vault"]);
  });

  test("a stalled readiness body is aborted before fixture root removal", async () => {
    let aborted = false;
    const events: string[] = [];
    const fetchImpl = stalledBody(() => { aborted = true; });

    await expect(runThenCleanup(
      () => pollJsonWithin<{ ready: boolean }>({
        operation: "readiness",
        totalMs: 10,
        requestMs: 5,
        url: "http://fixture/readyz",
        init: {},
        accept: (value) => value.ready,
        fetchImpl,
      }),
      events,
    )).rejects.toThrow("readiness exceeded");
    expect(aborted).toBeTrue();
    expect(events).toEqual(["close", "remove:vault"]);
  });

  test("the complete text helper aborts a body stall", async () => {
    let aborted = false;
    await expect(fetchTextWithin(
      "complete response",
      5,
      "http://fixture",
      {},
      undefined,
      stalledBody(() => { aborted = true; }),
    )).rejects.toThrow("complete response exceeded 5ms");
    expect(aborted).toBeTrue();
  });
});

async function runThenCleanup<T>(operation: () => Promise<T>, events: string[]): Promise<T> {
  const hosts = [{ close: async () => { events.push("close"); } }];
  const roots = ["vault"];
  try {
    return await operation();
  } finally {
    await cleanupOwnedProductFixtures(hosts, roots, {
      removeRoot: async (root) => { events.push(`remove:${root}`); },
      timeoutMs: 20,
    });
  }
}

function stalledBeforeHeaders(onAbort: () => void): FixtureFetch {
  return (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal === undefined || signal === null) throw new Error("missing fixture signal");
    signal.addEventListener("abort", () => {
      onAbort();
      reject(signal.reason);
    }, { once: true });
  });
}

function stalledBody(onAbort: () => void): FixtureFetch {
  return async (_input, init) => {
    const signal = init?.signal;
    if (signal === undefined || signal === null) throw new Error("missing fixture signal");
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener("abort", () => {
          onAbort();
          controller.error(signal.reason);
        }, { once: true });
      },
    }));
  };
}
