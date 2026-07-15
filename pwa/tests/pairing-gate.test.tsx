import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PairingGate } from "../src/auth/PairingGate";

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  document.cookie = "dome_csrf=; Max-Age=0; Path=/";
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});

describe("PairingGate", () => {
  test("renders children immediately for an existing paired cookie", async () => {
    localStorage.setItem("dome.token", "legacy-master-token");
    globalThis.fetch = mock(async () => new Response(JSON.stringify({
      schema: "dome.pairing/v1",
      available: true,
      paired: true,
    }), { status: 200 })) as never;
    render(<PairingGate>{() => <div>connected</div>}</PairingGate>);
    await waitFor(() => expect(screen.getByText("connected")).toBeDefined());
    expect(localStorage.getItem("dome.token")).toBeNull();
  });

  test("restores an in-memory CSRF token from the readable cookie", async () => {
    const paths: string[] = [];
    document.cookie = "dome_csrf=restored; Path=/";
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      return new Response(JSON.stringify({
        schema: "dome.device.pairing/v1", available: true, paired: true,
      }), { status: 200 });
    }) as never;
    render(<PairingGate>{() => <div>connected</div>}</PairingGate>);
    await waitFor(() => expect(screen.getByText("connected")).toBeDefined());
    expect(paths).toEqual(["/pair/status"]);
  });

  test("exchanges a code without writing browser storage", async () => {
    const requests: Array<{
      path: string;
      body: unknown;
      authorization: string | null;
      credentials: RequestCredentials;
    }> = [];
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      requests.push({
        path,
        body: request.body === null ? null : await request.json(),
        authorization: request.headers.get("authorization"),
        credentials: request.credentials,
      });
      return new Response(JSON.stringify(path === "/pair/status"
        ? { schema: "dome.pairing/v1", available: true, paired: false }
        : { schema: "dome.pairing/v1", status: "paired", expires_at: "2026-07-12T00:00:00Z" }),
      { status: 200 });
    }) as never;
    localStorage.clear();
    render(<PairingGate>{() => <div>connected</div>}</PairingGate>);
    await waitFor(() => expect(screen.getByLabelText(/pairing code/i)).toBeDefined());
    fireEvent.change(screen.getByLabelText(/pairing code/i), { target: { value: "local-code-123" } });
    fireEvent.click(screen.getByRole("button", { name: /pair device/i }));
    await waitFor(() => expect(screen.getByText("connected")).toBeDefined());
    expect(requests).toEqual([
      { path: "/pair/status", body: null, authorization: null, credentials: "same-origin" },
      { path: "/pair", body: { code: "local-code-123" }, authorization: null, credentials: "same-origin" },
    ]);
    expect(localStorage.getItem("dome.token")).toBeNull();
  });

  test("classifies a pair transport rejection as unreachable instead of unpaired", async () => {
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/pair/status") {
        return new Response(JSON.stringify({ schema: "dome.device.pairing/v1", available: true, paired: false }), { status: 200 });
      }
      throw new Error("Home disappeared during pairing");
    }) as never;
    render(<PairingGate>{() => <div>connected</div>}</PairingGate>);
    await waitFor(() => expect(screen.getByLabelText(/pairing code/i)).toBeDefined());
    fireEvent.change(screen.getByLabelText(/pairing code/i), { target: { value: "local-code" } });
    fireEvent.click(screen.getByRole("button", { name: /pair device/i }));

    await waitFor(() => expect(screen.getByText(/Connect to your Home before pairing/i)).toBeDefined());
    expect(screen.queryByLabelText(/pairing code/i)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("boots the limited shell offline only with local pairing evidence", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    document.cookie = "dome_csrf=local-evidence; Path=/";
    const requests = mock(async () => { throw new Error("must not fetch offline"); });
    globalThis.fetch = requests as never;
    render(<PairingGate>{(_client, availability) => <div>shell {availability}</div>}</PairingGate>);
    await waitFor(() => expect(screen.getByText("shell offline")).toBeDefined());
    expect(requests).not.toHaveBeenCalled();
  });

  test("requires a connection instead of showing a pairing form when evidence is absent", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    globalThis.fetch = mock(async () => { throw new Error("must not fetch offline"); }) as never;
    render(<PairingGate>{() => <div>shell</div>}</PairingGate>);
    await waitFor(() => expect(screen.getByText(/Connect to your Home before pairing/i)).toBeDefined());
    expect(screen.queryByLabelText(/pairing code/i)).toBeNull();
  });

  test("labels a failed online probe as unreachable and rechecks on reconnect", async () => {
    document.cookie = "dome_csrf=local-evidence; Path=/";
    let attempts = 0;
    globalThis.fetch = mock(async () => {
      attempts++;
      if (attempts === 1) throw new Error("host down");
      return new Response(JSON.stringify({ schema: "dome.device.pairing/v1", available: true, paired: true }), { status: 200 });
    }) as never;
    render(<PairingGate>{(_client, availability) => <div>shell {availability}</div>}</PairingGate>);
    await waitFor(() => expect(screen.getByText("shell unreachable")).toBeDefined());
    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(screen.getByText("shell available")).toBeDefined());
    expect(attempts).toBe(2);
  });

  test("visibility revalidation downgrades a previously available shell", async () => {
    document.cookie = "dome_csrf=visibility-evidence; Path=/";
    let attempts = 0;
    globalThis.fetch = mock(async () => {
      attempts++;
      if (attempts === 1) {
        return new Response(JSON.stringify({ schema: "dome.device.pairing/v1", available: true, paired: true }), { status: 200 });
      }
      throw new Error("host disappeared");
    }) as never;
    render(<PairingGate>{(_client, availability) => <div>shell {availability}</div>}</PairingGate>);
    await waitFor(() => expect(screen.getByText("shell available")).toBeDefined());
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(screen.getByText("shell unreachable")).toBeDefined());
    expect(attempts).toBe(2);
  });

  test("a source transport failure reports to the same pairing owner", async () => {
    document.cookie = "dome_csrf=source-evidence; Path=/";
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/pair/status") {
        return new Response(JSON.stringify({ schema: "dome.device.pairing/v1", available: true, paired: true }), { status: 200 });
      }
      throw new Error("source transport lost");
    }) as never;
    render(<PairingGate>{(client, availability) => (
      <div>shell {availability}<button type="button" onClick={() => {
        void client.source({ path: "wiki/x.md", commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }).catch(() => {});
      }}>open source fixture</button></div>
    )}</PairingGate>);
    await waitFor(() => expect(screen.getByText(/shell available/)).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "open source fixture" }));
    await waitFor(() => expect(screen.getByText(/shell unreachable/)).toBeDefined());
  });

  test("explicit retry upgrades an unreachable shell and coalesces concurrent retries", async () => {
    document.cookie = "dome_csrf=retry-evidence; Path=/";
    let attempts = 0;
    let release!: () => void;
    globalThis.fetch = mock(async () => {
      attempts++;
      if (attempts === 1) throw new Error("host unavailable");
      await new Promise<void>((resolve) => { release = resolve; });
      return new Response(JSON.stringify({ schema: "dome.device.pairing/v1", available: true, paired: true }), { status: 200 });
    }) as never;
    render(<PairingGate>{(_client, availability, connection) => (
      <div>shell {availability}<button type="button" onClick={() => { connection.recheck(); connection.recheck(); }}>retry fixture</button></div>
    )}</PairingGate>);
    await waitFor(() => expect(screen.getByText(/shell unreachable/)).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "retry fixture" }));
    await waitFor(() => expect(release).toBeDefined());
    expect(attempts).toBe(2);
    release();
    await waitFor(() => expect(screen.getByText(/shell available/)).toBeDefined());
  });

  test("a delayed successful probe cannot overwrite newer offline evidence", async () => {
    document.cookie = "dome_csrf=monotonic-evidence; Path=/";
    let attempts = 0;
    let release!: (response: Response) => void;
    globalThis.fetch = mock(async () => {
      attempts++;
      if (attempts === 1) {
        return new Response(JSON.stringify({ schema: "dome.device.pairing/v1", available: true, paired: true }), { status: 200 });
      }
      return await new Promise<Response>((resolve) => { release = resolve; });
    }) as never;
    render(<PairingGate>{(_client, availability) => <div>shell {availability}</div>}</PairingGate>);
    await waitFor(() => expect(screen.getByText("shell available")).toBeDefined());
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(release).toBeDefined());
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    window.dispatchEvent(new Event("offline"));
    await waitFor(() => expect(screen.getByText("shell offline")).toBeDefined());
    release(new Response(JSON.stringify({ schema: "dome.device.pairing/v1", available: true, paired: true }), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText("shell offline")).toBeDefined();
  });

  test("a delayed pair success cannot overwrite newer offline evidence", async () => {
    let releasePair!: (response: Response) => void;
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/pair/status") {
        return new Response(JSON.stringify({ schema: "dome.device.pairing/v1", available: true, paired: false }), { status: 200 });
      }
      return await new Promise<Response>((resolve) => { releasePair = resolve; });
    }) as never;
    render(<PairingGate>{() => <div>connected</div>}</PairingGate>);
    await waitFor(() => expect(screen.getByLabelText(/pairing code/i)).toBeDefined());
    fireEvent.change(screen.getByLabelText(/pairing code/i), { target: { value: "delayed-code" } });
    fireEvent.click(screen.getByRole("button", { name: /pair device/i }));
    await waitFor(() => expect(releasePair).toBeDefined());

    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    window.dispatchEvent(new Event("offline"));
    await waitFor(() => expect(screen.getByText(/Connect to your Home before pairing/i)).toBeDefined());
    releasePair(new Response(JSON.stringify({
      schema: "dome.device.pairing/v1",
      status: "paired",
      csrfToken: "stale-token",
    }), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText("connected")).toBeNull();
    expect(screen.queryByLabelText(/pairing code/i)).toBeNull();
    expect(screen.getByText(/Connect to your Home before pairing/i)).toBeDefined();
  });

  test("a delayed pair transport rejection cannot replace offline evidence with an unpaired form", async () => {
    let rejectPair!: (reason: unknown) => void;
    globalThis.fetch = mock(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/pair/status") {
        return new Response(JSON.stringify({ schema: "dome.device.pairing/v1", available: true, paired: false }), { status: 200 });
      }
      return await new Promise<Response>((_resolve, reject) => { rejectPair = reject; });
    }) as never;
    render(<PairingGate>{() => <div>connected</div>}</PairingGate>);
    await waitFor(() => expect(screen.getByLabelText(/pairing code/i)).toBeDefined());
    fireEvent.change(screen.getByLabelText(/pairing code/i), { target: { value: "delayed-code" } });
    fireEvent.click(screen.getByRole("button", { name: /pair device/i }));
    await waitFor(() => expect(rejectPair).toBeDefined());

    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    window.dispatchEvent(new Event("offline"));
    await waitFor(() => expect(screen.getByText(/Connect to your Home before pairing/i)).toBeDefined());
    rejectPair(new Error("late pair transport failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText("connected")).toBeNull();
    expect(screen.queryByLabelText(/pairing code/i)).toBeNull();
    expect(screen.getByText(/Connect to your Home before pairing/i)).toBeDefined();
  });
});
