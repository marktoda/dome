import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import App, { reconcileStoppedTurn } from "../src/App";
import { CaptureQueue } from "../src/capture/captureQueue";
import { READY_PRODUCT, readinessResponse } from "./readiness-fixture";

const originalFetch = globalThis.fetch;
const originalAnchorClick = HTMLAnchorElement.prototype.click;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

async function clearCaptureQueue(): Promise<void> {
  const queue = new CaptureQueue();
  for (const item of await queue.all()) await queue.remove(item.id);
}

afterEach(async () => {
  cleanup();
  await clearCaptureQueue();
  globalThis.fetch = originalFetch;
  HTMLAnchorElement.prototype.click = originalAnchorClick;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  document.cookie = "dome_csrf=; Max-Age=0; Path=/";
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});

const TODAY_BODY = JSON.stringify({ schema: "dome.daily.today/v1", date: "2026-06-17", openTasks: [], followups: [], questions: [], brief: null, calendar: null, hero: null, counts: { openTasks: 0, followups: 0, questions: 0 } });
const RECENTS_BODY = JSON.stringify({ schema: "dome.recents/v1", count: 0, entries: [] });

beforeEach(async () => {
  await clearCaptureQueue();
  localStorage.clear();
  // agentStream calls fetch(string, opts); tasks/recents call fetch(new Request(...))
  globalThis.fetch = mock(async (reqOrUrl: Request | string) => {
    const rawUrl = typeof reqOrUrl === "string" ? reqOrUrl : reqOrUrl.url;
    const url = new URL(rawUrl, "http://x");
    if (url.pathname === "/readyz") return readinessResponse();
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

  test("does not show healthy connection before post-pair readiness validates", async () => {
    let releaseReadiness!: (response: Response) => void;
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/pair/status") return new Response(JSON.stringify({ schema: "dome.device.pairing/v1", available: true, paired: false }), { status: 200 });
      if (path === "/pair") return new Response(JSON.stringify({
        schema: "dome.device.pairing/v1", status: "paired", csrfToken: "new-csrf",
      }), { status: 200 });
      if (path === "/readyz") return await new Promise<Response>((resolve) => { releaseReadiness = resolve; });
      if (path === "/tasks") return new Response(TODAY_BODY, { status: 200 });
      if (path === "/recents") return new Response(RECENTS_BODY, { status: 200 });
      throw new Error(`unexpected request: ${path}`);
    }) as never;
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/pairing code/i)).toBeDefined());
    fireEvent.change(screen.getByLabelText(/pairing code/i), { target: { value: "pair-me" } });
    fireEvent.click(screen.getByRole("button", { name: /pair device/i }));
    await waitFor(() => expect(screen.getByText("Checking Dome Home")).toBeDefined());
    expect(document.querySelector(".availability-dot.available")).toBeNull();
    expect((screen.getByRole("button", { name: "send" }) as HTMLButtonElement).disabled).toBe(true);

    releaseReadiness(readinessResponse());
    await waitFor(() => expect(screen.getByText(/you're clear/i)).toBeDefined());
    expect(document.querySelector(".availability-dot.available")).not.toBeNull();
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
      if (url.pathname === "/readyz") return readinessResponse();
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
      if (path === "/readyz") return readinessResponse();
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
    expect(screen.queryByText("Dome Home unavailable")).toBeNull();
  });

  test("unmount stops an active server turn", async () => {
    let messageStarted = false;
    let cancelRequests = 0;
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/readyz") return readinessResponse();
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
      if (path === "/readyz") return readinessResponse();
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
    expect(input.disabled).toBe(false); // local capture remains available after a remote session ends
    expect((screen.getByRole("button", { name: "send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(input.closest("form")!);
    expect(messages).toBe(1);
    expect(sessions).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry question" }));
    await waitFor(() => expect(messages).toBe(2));
    expect(sessions).toBe(2);
    expect(screen.getByText("Retrying may repeat actions from the previous response.")).toBeDefined();
  });

  test("an offline paired device renders honest limited mode without remote requests", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    document.cookie = "dome_csrf=offline-app; Path=/";
    const requests = mock(async () => { throw new Error("remote fetch is forbidden offline"); });
    globalThis.fetch = requests as never;
    render(<App />);
    await waitFor(() => expect(screen.getByText("Offline")).toBeDefined());
    expect(screen.getByText(/Live data is unavailable/i)).toBeDefined();
    const input = screen.getByLabelText("ask your brain") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "offline app capture" } });
    expect((screen.getByRole("button", { name: "send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "capture thought" }));
    await waitFor(() => expect(screen.getByText("offline app capture")).toBeDefined());
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(true);
    expect(requests).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /delete pending capture/i }));
  });

  test("reports two HTTP view failures without falsely calling Home unreachable", async () => {
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/readyz") return readinessResponse();
      if (path === "/pair/status") {
        return new Response(JSON.stringify({ schema: "dome.pairing/v1", available: true, paired: true }), { status: 200 });
      }
      if (path === "/tasks" || path === "/recents") return new Response("{}", { status: 503 });
      return new Response("{}", { status: 200 });
    }) as never;
    render(<App />);
    await waitFor(() => expect(screen.getByText("Live views incomplete")).toBeDefined());
    expect(screen.getByText(/Today and Activity could not be refreshed\. Home is connected/i)).toBeDefined();
    expect(screen.queryByText("Dome Home unavailable")).toBeNull();
  });

  test("reports a partial view failure while preserving the successful Today view", async () => {
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/readyz") return readinessResponse();
      if (path === "/pair/status") {
        return new Response(JSON.stringify({ schema: "dome.pairing/v1", available: true, paired: true }), { status: 200 });
      }
      if (path === "/tasks") return new Response(TODAY_BODY, { status: 200 });
      if (path === "/recents") return new Response("{}", { status: 503 });
      return new Response("{}", { status: 200 });
    }) as never;
    render(<App />);
    await waitFor(() => expect(screen.getByText(/you're clear/i)).toBeDefined());
    expect(screen.getByText(/Activity could not be refreshed\. Today is current/i)).toBeDefined();
    expect(screen.queryByText("Dome Home unavailable")).toBeNull();
  });

  test("a reachable readiness failure is visibly stale and never looks healthy", async () => {
    document.cookie = "dome_csrf=readiness-failure; Path=/";
    let readinessCalls = 0;
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/readyz") {
        readinessCalls++;
        return readinessCalls === 1
          ? readinessResponse()
          : new Response(JSON.stringify({ error: "readiness-unavailable" }), { status: 503 });
      }
      if (path === "/tasks") return new Response(TODAY_BODY, { status: 200 });
      if (path === "/recents") return new Response(RECENTS_BODY, { status: 200 });
      throw new Error(`unexpected request: ${path}`);
    }) as never;
    render(<App />);
    await waitFor(() => expect(screen.getByText(/you're clear/i)).toBeDefined());
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(screen.getByText("Product readiness unavailable")).toBeDefined());
    expect(screen.getByText(/Last known details are context only/i)).toBeDefined();
    expect(screen.getByText(/Connection · readiness unavailable/i)).toBeDefined();
    expect(document.querySelector(".availability-dot.available")).toBeNull();
    expect((screen.getByRole("button", { name: "send" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("optional providers and write admission gate only their dependent affordances", async () => {
    const limited = {
      ...READY_PRODUCT,
      writesAdmitted: false,
      model: { state: "unconfigured" as const },
      transcription: { state: "unreachable" as const },
      nextActions: [{ code: "configure-model", label: "Configure the model provider" }],
    };
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/readyz") return readinessResponse(limited);
      if (path === "/pair/status") return new Response(JSON.stringify({ schema: "dome.pairing/v1", available: true, paired: true }), { status: 200 });
      if (path === "/tasks") return new Response(TODAY_BODY, { status: 200 });
      if (path === "/recents") return new Response(RECENTS_BODY, { status: 200 });
      throw new Error(`unexpected remote request: ${path}`);
    }) as never;
    render(<App />);
    await waitFor(() => expect(screen.getByText(/you're clear/i)).toBeDefined());
    expect((screen.getByRole("button", { name: "send" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "record" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText(/Connection · ready/i));
    expect(screen.getByText("Configure the model provider")).toBeDefined();
    expect(screen.getByText(/Available now: read/i)).toBeDefined();

    const input = screen.getByLabelText("ask your brain") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "still saved locally" } });
    fireEvent.click(screen.getByRole("button", { name: "capture thought" }));
    await waitFor(() => expect(screen.getByText("still saved locally")).toBeDefined());
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /delete pending capture/i }));
  });

  test("revoked auth returns to re-pair without deleting the local capture queue", async () => {
    HTMLAnchorElement.prototype.click = mock(() => {});
    const createObjectURL = mock(() => "blob:test-export");
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = mock(() => {});
    document.cookie = "dome_csrf=soon-revoked; Path=/";
    let pairedAgain = false;
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/readyz") return readinessResponse(pairedAgain
        ? { ...READY_PRODUCT, writesAdmitted: false }
        : READY_PRODUCT);
      if (path === "/tasks") return new Response(TODAY_BODY, { status: 200 });
      if (path === "/recents") return new Response(RECENTS_BODY, { status: 200 });
      if (path === "/capture") return new Response(JSON.stringify({ error: "device-revoked" }), { status: 401 });
      if (path === "/pair") {
        pairedAgain = true;
        return new Response(JSON.stringify({
          schema: "dome.device.pairing/v1", status: "paired", csrfToken: "new-csrf",
        }), { status: 200 });
      }
      throw new Error(`unexpected remote request: ${path}`);
    }) as never;
    render(<App />);
    await waitFor(() => expect(screen.getByText(/you're clear/i)).toBeDefined());
    const input = screen.getByLabelText("ask your brain") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "survive revoked auth" } });
    fireEvent.click(screen.getByRole("button", { name: "capture thought" }));
    await waitFor(() => expect(screen.getByLabelText("New pairing code")).toBeDefined());
    expect(screen.getByText("survive revoked auth")).toBeDefined();
    expect(screen.getByText(/you're clear/i)).toBeDefined();
    await waitFor(() => expect(screen.getByText(/failed · device-revoked/i)).toBeDefined());

    fireEvent.change(input, { target: { value: "local during repair" } });
    fireEvent.click(screen.getByRole("button", { name: "capture thought" }));
    await waitFor(() => expect(screen.getByText("local during repair")).toBeDefined());
    const repairItem = screen.getByText("local during repair").closest(".capture-outbox-item");
    expect(repairItem).not.toBeNull();
    fireEvent.click(repairItem!.querySelector("button")!);
    await waitFor(() => expect(screen.queryByText("local during repair")).toBeNull());
    await waitFor(async () => expect((await new CaptureQueue().all()).some((item) => item.text === "local during repair")).toBe(false));
    expect(screen.getByText("survive revoked auth")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("New pairing code"), { target: { value: "fresh-code" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair again" }));
    await waitFor(() => expect(screen.getByText("survive revoked auth")).toBeDefined());
    await waitFor(() => expect(screen.queryByLabelText("New pairing code")).toBeNull());
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /delete pending capture/i }));
  });

  test("two transport failures feed unreachable truth back to the pairing owner", async () => {
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/readyz") return readinessResponse();
      if (path === "/pair/status") {
        return new Response(JSON.stringify({ schema: "dome.device.pairing/v1", available: true, paired: true }), { status: 200 });
      }
      throw new Error("transport down");
    }) as never;
    document.cookie = "dome_csrf=transport-evidence; Path=/";
    render(<App />);
    await waitFor(() => expect(screen.getByText("Dome Home unavailable")).toBeDefined());
    expect((screen.getByRole("button", { name: "send" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Retry connection" })).toBeDefined();
  });

  test("a queued capture transport failure visibly downgrades all live controls", async () => {
    document.cookie = "dome_csrf=capture-transport; Path=/";
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/readyz") return readinessResponse();
      if (path === "/pair/status") {
        return new Response(JSON.stringify({ schema: "dome.device.pairing/v1", available: true, paired: true }), { status: 200 });
      }
      if (path === "/tasks") return new Response(TODAY_BODY, { status: 200 });
      if (path === "/recents") return new Response(RECENTS_BODY, { status: 200 });
      if (path === "/capture") throw new Error("capture transport lost");
      return new Response("{}", { status: 200 });
    }) as never;

    render(<App />);
    await waitFor(() => expect(screen.getByText(/you're clear/i)).toBeDefined());
    const input = screen.getByLabelText("ask your brain") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "keep this locally" } });
    fireEvent.click(screen.getByRole("button", { name: "capture thought" }));

    await waitFor(() => expect(screen.getByText("Dome Home unavailable")).toBeDefined());
    expect(screen.getByText("keep this locally")).toBeDefined();
    expect((screen.getByRole("button", { name: "send" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "record" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /delete pending capture/i }));
  });

  test("a failed answer stays visible and is never acknowledged as answered", async () => {
    document.cookie = "dome_csrf=resolve-transport; Path=/";
    const todayWithQuestion = JSON.stringify({
      schema: "dome.daily.today/v1",
      date: "2026-06-17",
      openTasks: [],
      followups: [],
      questions: [{ id: 7, question: "Hourly or daily?", resolveCommand: "dome resolve 7 <value>", options: ["hourly", "daily"] }],
      brief: null,
      calendar: null,
      hero: null,
      counts: { openTasks: 0, followups: 0, questions: 1 },
    });
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/readyz") return readinessResponse();
      if (path === "/pair/status") {
        return new Response(JSON.stringify({ schema: "dome.device.pairing/v1", available: true, paired: true }), { status: 200 });
      }
      if (path === "/tasks") return new Response(todayWithQuestion, { status: 200 });
      if (path === "/recents") return new Response(RECENTS_BODY, { status: 200 });
      if (path === "/resolve") throw new Error("resolve transport lost");
      return new Response("{}", { status: 200 });
    }) as never;

    render(<App />);
    await waitFor(() => expect(screen.getByText("Hourly or daily?")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "hourly" }));

    await waitFor(() => expect(screen.getByText("Dome Home unavailable")).toBeDefined());
    expect(screen.getByText("Hourly or daily?")).toBeDefined();
    expect(screen.getByText("Answer not saved · Try again")).toBeDefined();
    expect(screen.queryByText(/Answer saved|Answered/)).toBeNull();
  });

  test("an Ask transport failure visibly downgrades live controls", async () => {
    document.cookie = "dome_csrf=ask-transport; Path=/";
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/readyz") return readinessResponse();
      if (path === "/pair/status") {
        return new Response(JSON.stringify({ schema: "dome.device.pairing/v1", available: true, paired: true }), { status: 200 });
      }
      if (path === "/tasks") return new Response(TODAY_BODY, { status: 200 });
      if (path === "/recents") return new Response(RECENTS_BODY, { status: 200 });
      if (path === "/sessions") throw new Error("agent transport lost");
      return new Response("{}", { status: 200 });
    }) as never;

    render(<App />);
    await waitFor(() => expect(screen.getByText(/you're clear/i)).toBeDefined());
    const input = screen.getByLabelText("ask your brain") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "question during outage" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => expect(screen.getByText("Dome Home unavailable")).toBeDefined());
    expect(screen.getByText("question during outage")).toBeDefined();
    expect((screen.getByRole("button", { name: "send" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "record" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Retry connection" })).toBeDefined();
  });

  test("explicit connection recovery re-enables live controls and drains local capture", async () => {
    let serverUp = false;
    let captureCalls = 0;
    document.cookie = "dome_csrf=recovery-evidence; Path=/";
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/readyz") return readinessResponse();
      if (!serverUp) throw new Error("host unavailable");
      if (path === "/pair/status") {
        return new Response(JSON.stringify({ schema: "dome.device.pairing/v1", available: true, paired: true }), { status: 200 });
      }
      if (path === "/tasks") return new Response(TODAY_BODY, { status: 200 });
      if (path === "/recents") return new Response(RECENTS_BODY, { status: 200 });
      if (path === "/capture") {
        captureCalls++;
        return new Response(JSON.stringify({
          schema: "dome.capture/v1", status: "captured", vault: "vault", path: "inbox/raw/recovered.md",
          commit: "abc", title: "recovered", captured_at: "2026-07-15T12:00:00.000Z", source: "pwa",
          branch: "main", serve_status: "running", adopted_initialized: true, compile_pending: false,
          commit_status: "committed", adoption_status: "pending",
        }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as never;
    render(<App />);
    await waitFor(() => expect(screen.getByText("Dome Home unavailable")).toBeDefined());
    const input = screen.getByLabelText("ask your brain") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "replay after reconnect" } });
    fireEvent.click(screen.getByRole("button", { name: "capture thought" }));
    await waitFor(() => expect(screen.getByText("replay after reconnect")).toBeDefined());
    serverUp = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    await waitFor(() => expect(captureCalls).toBe(1));
    await waitFor(() => expect(screen.queryByText("replay after reconnect")).toBeNull());
    fireEvent.change(input, { target: { value: "ask after reconnect" } });
    expect((screen.getByRole("button", { name: "send" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("delayed old view failures cannot downgrade a successful connection recheck", async () => {
    document.cookie = "dome_csrf=view-generation; Path=/";
    let readinessCalls = 0;
    let taskCalls = 0;
    let recentCalls = 0;
    let rejectOldTasks!: (reason: unknown) => void;
    let rejectOldRecents!: (reason: unknown) => void;
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/readyz") {
        readinessCalls++;
        if (readinessCalls === 2) throw new Error("temporary readiness transport failure");
        return readinessResponse();
      }
      if (path === "/tasks") {
        taskCalls++;
        if (taskCalls === 1) return await new Promise<Response>((_resolve, reject) => { rejectOldTasks = reject; });
        return new Response(TODAY_BODY, { status: 200 });
      }
      if (path === "/recents") {
        recentCalls++;
        if (recentCalls === 1) return await new Promise<Response>((_resolve, reject) => { rejectOldRecents = reject; });
        return new Response(RECENTS_BODY, { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as never;
    render(<App />);
    await waitFor(() => expect(rejectOldTasks).toBeDefined());
    await waitFor(() => expect(rejectOldRecents).toBeDefined());
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(screen.getByText("Dome Home unavailable")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    await waitFor(() => expect(screen.getByText(/you're clear/i)).toBeDefined());
    rejectOldTasks(new Error("old tasks transport failure"));
    rejectOldRecents(new Error("old recents transport failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Dome Home unavailable")).toBeNull();
    expect(screen.queryByText("Live views incomplete")).toBeNull();
  });
});
