import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import App, { reconcileStoppedTurn } from "../src/App";

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const TODAY_BODY = JSON.stringify({ schema: "dome.daily.today/v1", date: "2026-06-17", openTasks: [], followups: [], questions: [], brief: null, calendar: null, hero: null, counts: { openTasks: 0, followups: 0, questions: 0 } });
const RECENTS_BODY = JSON.stringify({ schema: "dome.recents/v1", count: 0, entries: [] });

beforeEach(() => {
  localStorage.clear();
  // agentStream calls fetch(string, opts); tasks/recents call fetch(new Request(...))
  globalThis.fetch = mock(async (reqOrUrl: Request | string) => {
    const rawUrl = typeof reqOrUrl === "string" ? reqOrUrl : reqOrUrl.url;
    const url = new URL(rawUrl, "http://x");
    if (url.pathname === "/pair/status") return new Response(JSON.stringify({ schema: "dome.pairing/v1", available: true, paired: true }), { status: 200 });
    if (url.pathname === "/tasks") return new Response(TODAY_BODY, { status: 200 });
    if (url.pathname === "/recents") return new Response(RECENTS_BODY, { status: 200 });
    if (url.pathname === "/sessions") return new Response(JSON.stringify({ schema: "dome.agent-session/v1", status: "created", sessionId: "s1" }), { status: 201 });
    return new Response("{}", { status: 200 });
  }) as never;
});

describe("App", () => {
  test("stop reconciliation preserves authoritative stream terminals", () => {
    const cancelFailed = { kind: "failed", code: "network", message: "cancel failed", retryable: true } as const;
    const streamFailed = { kind: "failed", code: "model", message: "model failed", retryable: true } as const;
    expect(reconcileStoppedTurn(streamFailed, { kind: "idle" })).toBe(streamFailed);
    expect(reconcileStoppedTurn({ kind: "done" }, cancelFailed)).toEqual({ kind: "done" });
    expect(reconcileStoppedTurn({ kind: "cancelled", source: "server" }, cancelFailed)).toEqual({ kind: "cancelled", source: "server" });
    expect(reconcileStoppedTurn({ kind: "cancelled", source: "local-abort" }, cancelFailed)).toBe(cancelFailed);
    expect(reconcileStoppedTurn({ kind: "cancelled", source: "local-abort" }, { kind: "idle" })).toMatchObject({ kind: "failed", code: "stop-unconfirmed" });
  });

  test("renders the brief (all-clear), recents, and composer when paired", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/you're clear/i)).toBeDefined());
    expect(screen.getByPlaceholderText(/ask/i)).toBeDefined();
  });

  test("refetches the brief after the agent reports a write", async () => {
    // Build an SSE ReadableStream that emits a done event with changes.
    // We construct it directly so happy-dom's getReader() can consume it.
    const doneEvent = JSON.stringify({ schema: "dome.agent.stream/v1", type: "done", citations: [], stopReason: "final", changes: [{ path: "wiki/todo.md", kind: "edit" }] });
    const ssePayload = `data: ${doneEvent}\n\n`;
    const encoder = new TextEncoder();
    const encoded = encoder.encode(ssePayload);

    let taskCallCount = 0;
    let recentsCallCount = 0;
    globalThis.fetch = mock(async (reqOrUrl: Request | string) => {
      // agentStream calls fetch(string, opts); tasks/recents call fetch(new Request(...))
      const rawUrl = typeof reqOrUrl === "string" ? reqOrUrl : reqOrUrl.url;
      const url = new URL(rawUrl, "http://x");
      if (url.pathname === "/pair/status") return new Response(JSON.stringify({ schema: "dome.pairing/v1", available: true, paired: true }), { status: 200 });
      if (url.pathname === "/tasks") { taskCallCount++; return new Response(TODAY_BODY, { status: 200 }); }
      if (url.pathname === "/recents") { recentsCallCount++; return new Response(RECENTS_BODY, { status: 200 }); }
      if (url.pathname === "/sessions") {
        return new Response(JSON.stringify({ schema: "dome.agent-session/v1", status: "created", sessionId: "s1" }), { status: 201 });
      }
      if (url.pathname === "/sessions/s1/messages") {
        // Build a minimal Response-like object with a streaming body that
        // happy-dom can consume via getReader(). We can't easily patch a real
        // Response's body getter, so we craft a plain object matching the
        // interface DomeClient.agentStream uses: ok, body.getReader().
        let called = false;
        const fakeRes = {
          ok: true,
          status: 200,
          body: {
            getReader() {
              return {
                read(): Promise<{ done: boolean; value?: Uint8Array }> {
                  if (!called) { called = true; return Promise.resolve({ done: false, value: encoded }); }
                  return Promise.resolve({ done: true, value: undefined });
                },
                cancel() { return Promise.resolve(); },
              };
            },
          },
        };
        return fakeRes as never;
      }
      return new Response("{}", { status: 200 });
    }) as never;

    render(<App />);
    // Wait for mount fetch to complete
    await waitFor(() => expect(screen.getByText(/you're clear/i)).toBeDefined());
    const tasksAfterMount = taskCallCount;
    const recentsAfterMount = recentsCallCount;

    // Trigger an ask
    const input = screen.getByPlaceholderText(/ask/i);
    fireEvent.change(input, { target: { value: "update my todo" } });
    fireEvent.submit(input.closest("form")!);

    // Wait for the agent to complete and trigger a refresh
    await waitFor(() => expect(taskCallCount).toBeGreaterThan(tasksAfterMount));
    expect(recentsCallCount).toBeGreaterThan(recentsAfterMount);
  });

  test("stop stays pending through server cancellation and overlapping asks are ignored", async () => {
    let messageRequests = 0;
    let resolveCancel: ((response: Response) => void) | undefined;
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/pair/status") return new Response(JSON.stringify({ schema: "dome.pairing/v1", available: true, paired: true }), { status: 200 });
      if (path === "/tasks") return new Response(TODAY_BODY, { status: 200 });
      if (path === "/recents") return new Response(RECENTS_BODY, { status: 200 });
      if (path === "/sessions") return new Response(JSON.stringify({ schema: "dome.agent-session/v1", status: "created", sessionId: "s1" }), { status: 201 });
      if (path === "/sessions/s1/cancel") return await new Promise<Response>((resolve) => { resolveCancel = resolve; });
      if (path === "/sessions/s1/messages") {
        messageRequests++;
        return new Response(new ReadableStream({
          start(controller) {
            request.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
          },
        }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as never;

    render(<App />);
    await waitFor(() => expect(screen.getByText(/you're clear/i)).toBeDefined());
    const input = screen.getByPlaceholderText(/ask/i);
    fireEvent.change(input, { target: { value: "keep this question" } });
    fireEvent.submit(input.closest("form")!);
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(messageRequests).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "stop response" }));
    expect(screen.getByText("Stopping…")).toBeDefined();
    await waitFor(() => expect(resolveCancel).toBeDefined());
    resolveCancel!(new Response(JSON.stringify({ schema: "dome.agent-session/v1", status: "cancelled", sessionId: "s1" }), { status: 200 }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry question" })).toBeDefined());
    expect(screen.getByText("keep this question")).toBeDefined();
    expect(screen.getByText("Cancellation confirmed by the server.")).toBeDefined();
  });

  test("unmount stops an active server turn", async () => {
    let messageStarted = false;
    let cancelRequests = 0;
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/pair/status") return new Response(JSON.stringify({ schema: "dome.pairing/v1", available: true, paired: true }), { status: 200 });
      if (path === "/tasks") return new Response(TODAY_BODY, { status: 200 });
      if (path === "/recents") return new Response(RECENTS_BODY, { status: 200 });
      if (path === "/sessions") return new Response(JSON.stringify({ schema: "dome.agent-session/v1", status: "created", sessionId: "s1" }), { status: 201 });
      if (path.endsWith("/cancel")) {
        cancelRequests++;
        return new Response(JSON.stringify({ schema: "dome.agent-session/v1", status: "cancelled", sessionId: "s1" }), { status: 200 });
      }
      messageStarted = true;
      if (request.signal.aborted) throw new DOMException("aborted", "AbortError");
      return await new Promise<Response>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    }) as never;

    const view = render(<App />);
    await waitFor(() => expect(screen.getByText(/you're clear/i)).toBeDefined());
    const input = screen.getByPlaceholderText(/ask/i);
    fireEvent.change(input, { target: { value: "active" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(messageStarted).toBe(true));
    view.unmount();
    await waitFor(() => expect(cancelRequests).toBe(1));
  });

  test("a missing server session preserves transcript and requires an explicit warned recovery", async () => {
    let sessions = 0;
    let messages = 0;
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/pair/status") return new Response(JSON.stringify({ schema: "dome.pairing/v1", available: true, paired: true }), { status: 200 });
      if (path === "/tasks") return new Response(TODAY_BODY, { status: 200 });
      if (path === "/recents") return new Response(RECENTS_BODY, { status: 200 });
      if (path === "/sessions") {
        sessions++;
        return new Response(JSON.stringify({ schema: "dome.agent-session/v1", status: "created", sessionId: `s${sessions}` }), { status: 201 });
      }
      if (path.endsWith("/messages")) {
        messages++;
        if (messages === 1) return new Response(JSON.stringify({ error: "session-not-found", message: "host restarted" }), { status: 404 });
        return new Response(`data: {"schema":"dome.agent.stream/v1","type":"done","citations":[],"stopReason":"final"}\n\n`, { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as never;

    render(<App />);
    await waitFor(() => expect(screen.getByText(/you're clear/i)).toBeDefined());
    const input = screen.getByPlaceholderText(/ask/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "preserve this question" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(screen.getByText(/Conversation ended\. Retry may repeat actions/i)).toBeDefined());
    expect(screen.getByText("preserve this question")).toBeDefined();
    expect(input.disabled).toBe(true);
    fireEvent.submit(input.closest("form")!);
    expect(messages).toBe(1);
    expect(sessions).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry question" }));
    await waitFor(() => expect(messages).toBe(2));
    expect(sessions).toBe(2);
    expect(screen.getByText("Retrying may repeat actions from the previous response.")).toBeDefined();
  });
});
