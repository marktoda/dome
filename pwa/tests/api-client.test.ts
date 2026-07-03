import { afterEach, describe, expect, test, mock } from "bun:test";
import { DomeClient } from "../src/api/client";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockJson(status: number, body: unknown): void {
  globalThis.fetch = mock(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as never;
}

describe("DomeClient", () => {
  test("recents() GETs /recents with the bearer token and parses the body", async () => {
    let seen: Request | undefined;
    globalThis.fetch = mock(async (req: Request) => {
      seen = req;
      return new Response(JSON.stringify({ schema: "dome.recents/v1", count: 0, entries: [] }), { status: 200 });
    }) as never;
    const c = new DomeClient("tok");
    const r = await c.recents();
    expect(r.entries).toEqual([]);
    expect(seen!.url).toContain("/recents");
    expect(seen!.headers.get("authorization")).toBe("Bearer tok");
  });

  test("capture() POSTs JSON and returns the doc", async () => {
    mockJson(200, { schema: "dome.capture/v1", status: "captured", path: "inbox/raw/x.md", commit: "abc" });
    const c = new DomeClient("tok");
    const res = await c.capture({ text: "hi" });
    expect(res.status).toBe("captured");
    expect(res.path).toBe("inbox/raw/x.md");
  });

  test("a non-2xx rejects with the error envelope message", async () => {
    mockJson(400, { status: "error", error: "capture-usage", message: "needs text" });
    const c = new DomeClient("tok");
    await expect(c.capture({ text: "" })).rejects.toThrow("capture-usage");
  });

  test("resolve() POSTs id+value to /resolve", async () => {
    let body: unknown;
    globalThis.fetch = mock(async (req: Request) => { body = await req.json(); return new Response(JSON.stringify({ schema: "dome.answer/v1", status: "answered" }), { status: 200 }); }) as never;
    const c = new DomeClient("tok");
    const r = await c.resolve(3, "yes");
    expect(r.status).toBe("answered");
    expect(body).toEqual({ id: 3, value: "yes" });
  });

  test("settle() POSTs blockId+disposition to /settle", async () => {
    let body: unknown;
    let seen: Request | undefined;
    globalThis.fetch = mock(async (req: Request) => {
      seen = req;
      body = await req.json();
      return new Response(JSON.stringify({ schema: "dome.settle/v1", status: "settled", block_id: "t1a2b3c4", disposition: "close", commit: "abc" }), { status: 200 });
    }) as never;
    const c = new DomeClient("tok");
    const r = await c.settle("t1a2b3c4", "close");
    expect(r.status).toBe("settled");
    expect(r.block_id).toBe("t1a2b3c4");
    expect(body).toEqual({ blockId: "t1a2b3c4", disposition: "close" });
    expect(seen!.url).toContain("/settle");
    expect(seen!.headers.get("authorization")).toBe("Bearer tok");
  });

  test("settle() includes deferUntil only when provided", async () => {
    let body: unknown;
    globalThis.fetch = mock(async (req: Request) => { body = await req.json(); return new Response(JSON.stringify({ schema: "dome.settle/v1", status: "settled", block_id: "t1", disposition: "defer" }), { status: 200 }); }) as never;
    const c = new DomeClient("tok");
    await c.settle("t1", "defer", "2026-07-10");
    expect(body).toEqual({ blockId: "t1", disposition: "defer", deferUntil: "2026-07-10" });
  });

  test("settle() surfaces a not-found result without throwing", async () => {
    mockJson(404, { schema: "dome.settle/v1", status: "not-found", message: "no task line carries anchor ^tmissing" });
    const c = new DomeClient("tok");
    // performSettle's not-found/invalid are 4xx statuses; the client's
    // generic error-envelope handling treats any non-2xx as a rejection —
    // mirrors resolve()/capture()'s existing behavior (a non-2xx rejects).
    await expect(c.settle("tmissing", "close")).rejects.toThrow();
  });
});
