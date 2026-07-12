import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import App from "../src/App";

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
});
