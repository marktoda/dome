import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PairingGate } from "../src/auth/PairingGate";

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
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
});
