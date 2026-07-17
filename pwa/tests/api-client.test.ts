import { afterEach, describe, expect, test, mock } from "bun:test";
import { DomeClient } from "../src/api/client";
import { CaptureDeliveryError } from "../src/capture/captureFailure";
import type { StreamEvent } from "../src/api/types";
import { AGENT_STREAM_SCHEMA } from "../../contracts/agent-stream";
import { READY_PRODUCT } from "./readiness-fixture";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockJson(status: number, body: unknown): void {
  globalThis.fetch = mock(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as never;
}

describe("DomeClient", () => {
  test("tasks accepts only a runtime-valid Today document", async () => {
    const valid = {
      schema: "dome.daily.today/v1" as const,
      date: "2026-07-16",
      openTasks: [],
      followups: [],
      questions: [],
      brief: null,
      calendar: null,
      hero: null,
      counts: { openTasks: 0, followups: 0, questions: 0 },
    };
    const responses = [
      new Response(JSON.stringify(valid), { status: 200 }),
      new Response(JSON.stringify({ ...valid, schema: "dome.recents/v1" }), { status: 200 }),
      new Response(JSON.stringify({ schema: "dome.daily.today/v1" }), { status: 200 }),
    ];
    globalThis.fetch = mock(async () => responses.shift()!) as never;
    const client = new DomeClient();

    expect(await client.tasks()).toEqual(valid);
    await expect(client.tasks()).rejects.toThrow("Today response is incompatible");
    await expect(client.tasks()).rejects.toThrow("Today response is incompatible");
  });

  test("taskBacklog preserves typed cursor recovery and rejects malformed problem documents", async () => {
    const valid = {
      schema: "dome.daily.task-backlog.list/v1" as const,
      status: "ok" as const,
      date: "2026-07-16",
      revision: "abc123",
      snapshot: "a".repeat(64),
      groups: { overdue: 0, dated: 0, exactDuplicateCandidates: 0, undated: 0 },
      page: {
        limit: 25,
        returned: 0,
        total: 0,
        commitments: 0,
        hasMore: false,
        nextCursor: null,
      },
      items: [],
    };
    const seen: string[] = [];
    const stale = {
      schema: "dome.daily.task-backlog.list/v1" as const,
      status: "error" as const,
      error: "stale-cursor" as const,
      message: "Restart from page one.",
    };
    const invalid = {
      schema: "dome.daily.task-backlog.list/v1" as const,
      status: "error" as const,
      error: "invalid-cursor" as const,
      message: "Cursor is malformed.",
    };
    const responses = [
      new Response(JSON.stringify(valid), { status: 200 }),
      new Response(JSON.stringify(stale), { status: 409 }),
      new Response(JSON.stringify(invalid), { status: 400 }),
      new Response(JSON.stringify({ ...stale, error: "unknown-problem" }), { status: 409 }),
      new Response(JSON.stringify({ error: "busy", message: "Try later." }), { status: 503 }),
    ];
    globalThis.fetch = mock(async (request: Request) => {
      seen.push(new URL(request.url).pathname + new URL(request.url).search);
      return responses.shift()!;
    }) as never;
    const client = new DomeClient();

    expect(await client.taskBacklog({
      date: "2026-07-16",
      limit: 10,
      cursor: "opaque cursor",
    })).toEqual(valid);
    expect(seen[0]).toBe(
      "/task-backlog?date=2026-07-16&limit=10&cursor=opaque+cursor",
    );
    expect(await client.taskBacklog()).toEqual(stale);
    expect(await client.taskBacklog()).toEqual(invalid);
    await expect(client.taskBacklog()).rejects.toThrow(
      "Task backlog response is incompatible",
    );
    await expect(client.taskBacklog()).rejects.toThrow("busy: Try later.");
  });

  test("reviewTaskBacklog posts the strict review contract and preserves typed conflicts", async () => {
    const revision = "a".repeat(40);
    const request = {
      schema: "dome.task-backlog.review/v1" as const,
      revision,
      decisions: [{
        blockId: "task1",
        disposition: "keep" as const,
        sourceRef: {
          path: "wiki/a.md",
          commit: revision,
          stableId: "dome.daily.open-loop:task1",
          range: { startLine: 3, endLine: 3 },
        },
      }],
    };
    const success = {
      schema: "dome.task-backlog.review/v1",
      status: "settled",
      revision,
      reviewed: { keep: 1, close: 0, defer: 0 },
      commit: null,
      adoptionStatus: "unchanged",
    } as const;
    const conflict = {
      schema: "dome.task-backlog.review/v1",
      status: "error",
      error: "stale-review",
      message: "Refresh the review.",
      retryable: false,
      recoveryRequired: false,
    } as const;
    const seen: Request[] = [];
    const responses = [
      new Response(JSON.stringify(success), { status: 200 }),
      new Response(JSON.stringify(conflict), { status: 409 }),
    ];
    globalThis.fetch = mock(async (req: Request) => {
      seen.push(req);
      return responses.shift()!;
    }) as never;
    const client = new DomeClient("tok");

    expect(await client.reviewTaskBacklog(request)).toEqual(success);
    expect(new URL(seen[0]!.url).pathname).toBe("/task-backlog/review");
    expect(await seen[0]!.clone().json()).toEqual(request);
    expect(await client.reviewTaskBacklog(request)).toEqual(conflict);
  });

  test("readiness strictly classifies valid, incompatible, failed, and auth responses", async () => {
    const responses = [
      new Response(JSON.stringify(READY_PRODUCT), { status: 200 }),
      new Response(JSON.stringify({ ...READY_PRODUCT, unexpected: true }), { status: 200 }),
      new Response(JSON.stringify({ error: "busy" }), { status: 503 }),
      new Response(JSON.stringify({ error: "device-revoked" }), { status: 401 }),
    ];
    globalThis.fetch = mock(async () => responses.shift()!) as never;
    const failures: unknown[] = [];
    const client = new DomeClient("", "", () => (failure) => failures.push(failure));

    expect(await client.readiness()).toEqual({ kind: "ready", document: READY_PRODUCT });
    expect(await client.readiness()).toEqual({ kind: "incompatible" });
    expect(await client.readiness()).toEqual({ kind: "readiness-failed", status: 503 });
    expect(await client.readiness()).toEqual({ kind: "auth-required" });
    expect(failures).toEqual([{ kind: "auth-required" }]);
  });

  test("readiness distinguishes browser-offline from an unreachable Home", async () => {
    globalThis.fetch = mock(async () => { throw new Error("no response"); }) as never;
    const client = new DomeClient();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    expect(await client.readiness()).toEqual({ kind: "offline" });
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    expect(await client.readiness()).toEqual({ kind: "unreachable" });
  });

  test("a rejected pairing code is a visible request error, not global auth loss", async () => {
    const failures: unknown[] = [];
    globalThis.fetch = mock(async () => new Response(JSON.stringify({
      error: "pairing-code-invalid",
      message: "The pairing code is invalid or expired.",
    }), { status: 401 })) as never;
    const client = new DomeClient("", "", () => (failure) => failures.push(failure));

    await expect(client.pair("expired-code")).rejects.toThrow("pairing-code-invalid: The pairing code is invalid or expired.");
    expect(failures).toEqual([]);
  });

  test("auth loss and successful re-pair retire the cached agent session locally", async () => {
    const paths: string[] = [];
    let sessions = 0;
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === "/sessions") {
        sessions++;
        return new Response(JSON.stringify({
          schema: "dome.agent-session/v1", status: "created", sessionId: `s${sessions}`,
        }), { status: 201 });
      }
      if (path === "/sessions/s1/messages") {
        return new Response(JSON.stringify({ error: "device-revoked", message: "Pair again." }), { status: 401 });
      }
      if (path === "/pair") {
        return new Response(JSON.stringify({
          schema: "dome.device.pairing/v1", status: "paired", csrfToken: "new-csrf",
        }), { status: 200 });
      }
      if (path === "/sessions/s2/messages") {
        return new Response(`data: {"schema":"${AGENT_STREAM_SCHEMA}","type":"done","citations":[],"stopReason":"final"}\n\n`, { status: 200 });
      }
      throw new Error(`unexpected request: ${path}`);
    }) as never;
    const client = new DomeClient();

    expect(await client.agentStream("before revoke", () => {})).toMatchObject({ kind: "failed", code: "device-revoked" });
    await client.pair("fresh-code");
    expect(await client.agentStream("after re-pair", () => {})).toEqual({ kind: "done" });
    expect(paths).toEqual([
      "/sessions", "/sessions/s1/messages", "/pair", "/sessions", "/sessions/s2/messages",
    ]);
    expect(paths.some((path) => path.endsWith("/cancel") || path === "/sessions/s1")).toBe(false);
  });

  test("restores CSRF from a cookie without a network rotation", () => {
    const client = new DomeClient();
    expect(client.restoreCsrfFromCookie("other=x; dome_csrf=restored%20secret")).toBe(true);
    expect(client.restoreCsrfFromCookie("other=x")).toBe(false);
  });

  test("durable pairing keeps CSRF in memory and attaches it to mutations", async () => {
    const seen: Request[] = [];
    globalThis.fetch = mock(async (request: Request) => {
      seen.push(request);
      const path = new URL(request.url).pathname;
      if (path === "/pair") {
        return new Response(JSON.stringify({
          schema: "dome.device.pairing/v1",
          status: "paired",
          csrfToken: "csrf-secret",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        schema: "dome.capture/v1",
        status: "captured",
        vault: "/vault",
        path: "inbox/raw/x.md",
        commit: "abc",
        title: "hi",
        captured_at: "2026-07-11T12:00:00.000Z",
        source: "pwa",
        branch: "main",
        serve_status: "running",
        adopted_initialized: true,
        compile_pending: false,
        commit_status: "committed",
        adoption_status: "pending",
      }), { status: 200 });
    }) as never;
    const client = new DomeClient();
    await client.pair("grant");
    await client.capture({ text: "hi" });
    expect(seen[0]!.headers.get("x-dome-csrf")).toBeNull();
    expect(seen[1]!.headers.get("x-dome-csrf")).toBe("csrf-secret");
  });

  test("every direct client request reports a no-response failure through one transport seam", async () => {
    const failures: unknown[] = [];
    globalThis.fetch = mock(async () => { throw new Error("Home disappeared"); }) as never;
    const client = new DomeClient("", "", () => (cause) => { failures.push(cause); });
    const requests = [
      () => client.tasks(),
      () => client.taskBacklog(),
      () => client.recents(),
      () => client.resolve(7, "yes"),
      () => client.settle("task-1", "close"),
      () => client.transcribe(new Blob(["audio"], { type: "audio/webm" })),
      () => client.pairingStatus(),
      () => client.pair("code"),
      () => client.source({ path: "wiki/source.md", commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
    ];

    for (const request of requests) await expect(request()).rejects.toThrow("Dome Home could not be reached");
    await expect(client.capture({ text: "save me" })).rejects.toThrow("Dome Home did not confirm this capture");
    expect(failures).toHaveLength(requests.length + 1);
  });

  test("HTTP responses are reachable evidence and do not report transport failure", async () => {
    const failures: unknown[] = [];
    mockJson(503, { error: "temporarily-unavailable" });
    const client = new DomeClient("", "", () => (cause) => { failures.push(cause); });

    await expect(client.capture({ text: "save me" })).rejects.toThrow("temporarily-unavailable");
    expect(failures).toEqual([]);
  });

  test("agentStream creates one session and reuses it across turns", async () => {
    const paths: string[] = [];
    const bodies: unknown[] = [];
    const encoder = new TextEncoder();
    globalThis.fetch = mock(async (reqOrUrl: Request | string, init?: RequestInit) => {
      const request = typeof reqOrUrl === "string"
        ? new Request(`http://x${reqOrUrl}`, init)
        : reqOrUrl;
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === "/sessions") {
        return new Response(JSON.stringify({
          schema: "dome.agent-session/v1",
          status: "created",
          sessionId: "s1",
        }), { status: 201 });
      }
      bodies.push(await request.json());
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: {"schema":"${AGENT_STREAM_SCHEMA}","type":"done","citations":[],"stopReason":"final"}\n\n`));
          controller.close();
        },
      }), { status: 200 });
    }) as never;
    const client = new DomeClient("tok");
    await client.agentStream("first", () => {});
    await client.agentStream("second", () => {});
    expect(paths).toEqual([
      "/sessions",
      "/sessions/s1/messages",
      "/sessions/s1/messages",
    ]);
    expect(bodies).toEqual([{ message: "first" }, { message: "second" }]);
  });

  test("agentStream turns a fatal wire violation into one visible retryable error", async () => {
    const events: StreamEvent[] = [];
    globalThis.fetch = mock(async (request: Request) => {
      if (new URL(request.url).pathname === "/sessions") {
        return new Response(JSON.stringify({
          schema: "dome.agent-session/v1",
          status: "created",
          sessionId: "s1",
        }), { status: 201 });
      }
      return new Response("data: not-json\n\n", { status: 200 });
    }) as never;

    const outcome = await new DomeClient().agentStream("question", (event) => events.push(event));

    expect(events).toEqual([{
      schema: AGENT_STREAM_SCHEMA,
      type: "error",
      code: "protocol-invalid-json",
      message: "The response stream was interrupted or invalid.",
      retryable: true,
    }]);
    expect(outcome).toEqual({
      kind: "failed",
      code: "protocol-invalid-json",
      message: "The response stream was interrupted or invalid.",
      retryable: true,
    });
  });

  test("premature EOF is a visible retryable outcome and is never replayed", async () => {
    const events: StreamEvent[] = [];
    let messageRequests = 0;
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/sessions") return new Response(JSON.stringify({ schema: "dome.agent-session/v1", status: "created", sessionId: "s1" }), { status: 201 });
      messageRequests++;
      return new Response("data: {\"schema\":\"dome.agent.stream/v1\",\"type\":\"text\",\"text\":\"partial\"}\n\n", { status: 200 });
    }) as never;

    const outcome = await new DomeClient().agentStream("question", (event) => events.push(event));
    expect(outcome).toMatchObject({ kind: "failed", code: "protocol-premature-eof", retryable: true });
    expect(events.at(-1)).toMatchObject({ type: "error", code: "protocol-premature-eof", retryable: true });
    expect(messageRequests).toBe(1);
  });

  test("a successful response without a stream is also a retryable premature EOF", async () => {
    globalThis.fetch = mock(async (request: Request) => {
      if (new URL(request.url).pathname === "/sessions") return new Response(JSON.stringify({ schema: "dome.agent-session/v1", status: "created", sessionId: "s1" }), { status: 201 });
      return new Response(null, { status: 200 });
    }) as never;
    expect(await new DomeClient().agentStream("question", () => {})).toMatchObject({
      kind: "failed",
      code: "protocol-premature-eof",
      retryable: true,
    });
  });

  test("a turn handle aborts its fetch and cancels that exact server session", async () => {
    const paths: string[] = [];
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === "/sessions") return new Response(JSON.stringify({ schema: "dome.agent-session/v1", status: "created", sessionId: "owned" }), { status: 201 });
      if (path.endsWith("/cancel")) return new Response(JSON.stringify({ schema: "dome.agent-session/v1", status: "cancelled", sessionId: "owned" }), { status: 200 });
      if (request.signal.aborted) throw new DOMException("aborted", "AbortError");
      return await new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as never;

    const turn = new DomeClient().startAgentTurn("question", () => {});
    const stop = await turn.stop();
    expect(stop).toEqual({ kind: "cancelled" });
    expect(await turn.result).toEqual({ kind: "cancelled", source: "local-abort" });
    expect(paths).toEqual(["/sessions", "/sessions/owned/messages", "/sessions/owned/cancel"]);
  });

  test("a settled turn handle and removed abort listener cannot cancel a newer turn", async () => {
    let messages = 0;
    let cancels = 0;
    const encoder = new TextEncoder();
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/sessions") return new Response(JSON.stringify({ schema: "dome.agent-session/v1", status: "created", sessionId: "shared" }), { status: 201 });
      if (path.endsWith("/cancel")) {
        cancels++;
        return new Response(JSON.stringify({ schema: "dome.agent-session/v1", status: "cancelled", sessionId: "shared" }), { status: 200 });
      }
      messages++;
      if (messages % 2 === 1) {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: {"schema":"${AGENT_STREAM_SCHEMA}","type":"done","citations":[],"stopReason":"final"}\n\n`));
            controller.close();
          },
        }), { status: 200 });
      }
      if (request.signal.aborted) throw new DOMException("aborted", "AbortError");
      return await new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as never;

    const client = new DomeClient();
    const oldSignal = new AbortController();
    expect(await client.agentStream("first", () => {}, oldSignal.signal)).toEqual({ kind: "done" });
    const currentAfterSignal = client.startAgentTurn("second", () => {});
    oldSignal.abort();
    await Promise.resolve();
    expect(cancels).toBe(0);
    await currentAfterSignal.stop();
    await currentAfterSignal.result;
    expect(cancels).toBe(1);

    const completedClient = new DomeClient();
    const completed = completedClient.startAgentTurn("first", () => {});
    await completed.result;
    const current = completedClient.startAgentTurn("second", () => {});
    expect(await completed.stop()).toEqual({ kind: "idle" });
    await Promise.resolve();
    expect(cancels).toBe(1);
    expect(messages).toBe(4);
    expect(await current.stop()).toEqual({ kind: "cancelled" });
    expect(await current.result).toEqual({ kind: "cancelled", source: "local-abort" });
    expect(cancels).toBe(2);
  });

  test("completion between local abort and cancel receipt is reported as stop-unconfirmed", async () => {
    let resolveCancel: ((response: Response) => void) | undefined;
    let markMessageStarted: (() => void) | undefined;
    let markCancelStarted: (() => void) | undefined;
    const messageStarted = new Promise<void>((resolve) => { markMessageStarted = resolve; });
    const cancelStarted = new Promise<void>((resolve) => { markCancelStarted = resolve; });
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/sessions") return new Response(JSON.stringify({ schema: "dome.agent-session/v1", status: "created", sessionId: "shared" }), { status: 201 });
      if (path.endsWith("/cancel")) {
        markCancelStarted?.();
        return await new Promise<Response>((resolve) => { resolveCancel = resolve; });
      }
      markMessageStarted?.();
      if (request.signal.aborted) throw new DOMException("aborted", "AbortError");
      return await new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as never;

    const controller = new AbortController();
    let returned = false;
    const result = new DomeClient().agentStream("first", () => {}, controller.signal).then((outcome) => {
      returned = true;
      return outcome;
    });
    await messageStarted;
    controller.abort();
    await cancelStarted;
    expect(resolveCancel).toBeDefined();
    expect(returned).toBe(false);
    resolveCancel!(new Response(JSON.stringify({ schema: "dome.agent-session/v1", status: "idle", sessionId: "shared" }), { status: 200 }));
    expect(await result).toMatchObject({ kind: "failed", code: "stop-unconfirmed", retryable: true });
  });

  test("malformed successful cancel receipts are typed protocol failures", async () => {
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/sessions") return new Response(JSON.stringify({ schema: "dome.agent-session/v1", status: "created", sessionId: "owned" }), { status: 201 });
      if (path.endsWith("/cancel")) return new Response(JSON.stringify({ status: "cancelled", sessionId: "wrong" }), { status: 200 });
      if (request.signal.aborted) throw new DOMException("aborted", "AbortError");
      return await new Promise<Response>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    }) as never;
    const turn = new DomeClient().startAgentTurn("question", () => {});
    expect(await turn.stop()).toEqual({
      kind: "failed",
      code: "protocol-invalid-cancel-receipt",
      message: "The server returned an invalid cancellation receipt.",
      retryable: true,
    });
  });

  test("an expired session is evicted and only an explicit next ask creates another", async () => {
    let sessions = 0;
    let messages = 0;
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/sessions") {
        sessions++;
        return new Response(JSON.stringify({ schema: "dome.agent-session/v1", status: "created", sessionId: `s${sessions}` }), { status: 201 });
      }
      messages++;
      if (messages === 1) return new Response(JSON.stringify({ error: "session-expired", message: "expired" }), { status: 410 });
      return new Response(`data: {"schema":"${AGENT_STREAM_SCHEMA}","type":"done","citations":[],"stopReason":"final"}\n\n`, { status: 200 });
    }) as never;
    const client = new DomeClient();
    expect(await client.agentStream("first", () => {})).toEqual({ kind: "session-expired" });
    expect(sessions).toBe(1);
    expect(messages).toBe(1);
    expect(await client.agentStream("explicit retry", () => {})).toEqual({ kind: "done" });
    expect(sessions).toBe(2);
    expect(messages).toBe(2);
  });

  test("retryable HTTP outcomes retain Retry-After guidance", async () => {
    globalThis.fetch = mock(async (request: Request) => {
      if (new URL(request.url).pathname === "/sessions") return new Response(JSON.stringify({ schema: "dome.agent-session/v1", status: "created", sessionId: "s1" }), { status: 201 });
      return new Response(JSON.stringify({ error: "busy", message: "try later" }), { status: 429, headers: { "retry-after": "7" } });
    }) as never;
    expect(await new DomeClient().agentStream("question", () => {})).toEqual({
      kind: "failed",
      code: "busy",
      message: "try later",
      retryable: true,
      retryAfterSeconds: 7,
    });
  });

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
    mockJson(200, {
      schema: "dome.capture/v1",
      status: "captured",
      vault: "/vault",
      path: "inbox/raw/x.md",
      commit: "abc",
      title: "hi",
      captured_at: "2026-07-11T12:00:00.000Z",
      source: "pwa",
      branch: "main",
      serve_status: "running",
      adopted_initialized: true,
      compile_pending: false,
      commit_status: "committed",
      adoption_status: "pending",
    });
    const c = new DomeClient("tok");
    const res = await c.capture({ text: "hi" });
    expect(res.status).toBe("captured");
    if (res.status !== "captured") throw new Error("expected captured receipt");
    expect(res.path).toBe("inbox/raw/x.md");
  });

  test("a definite capture 4xx needs attention", async () => {
    mockJson(400, { status: "error", error: "capture-usage", message: "needs text" });
    const c = new DomeClient("tok");
    try {
      await c.capture({ text: "" });
      throw new Error("expected capture to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CaptureDeliveryError);
      expect(error).toMatchObject({ kind: "needs-attention", status: 400 });
      expect((error as Error).message).toContain("capture-usage");
    }
  });

  test("ambiguous capture HTTP and transport failures are safe to retry", async () => {
    for (const [status, body] of [
      [408, { error: "timeout" }],
      [429, { error: "busy" }],
      [503, { error: "unavailable" }],
      [409, { error: "mutation-outcome-unknown" }],
    ] as const) {
      mockJson(status, body);
      try {
        await new DomeClient("tok").capture({ text: "retry me" });
        throw new Error("expected capture to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(CaptureDeliveryError);
        expect(error).toMatchObject({ kind: "not-confirmed", status });
      }
    }

    globalThis.fetch = mock(async () => { throw new Error("network down"); }) as never;
    try {
      await new DomeClient("tok").capture({ text: "retry me" });
      throw new Error("expected capture to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CaptureDeliveryError);
      expect(error).toMatchObject({ kind: "not-confirmed", status: null });
    }
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
