import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import App from "../src/App";

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("dome.token", "tok");
  globalThis.fetch = mock(async (req: Request) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/tasks") return new Response(JSON.stringify({ schema: "dome.daily.today/v1", date: "2026-06-17", openTasks: [], followups: [], questions: [], brief: null, calendar: null, hero: null, counts: { openTasks: 0, followups: 0, questions: 0 } }), { status: 200 });
    if (url.pathname === "/recents") return new Response(JSON.stringify({ schema: "dome.recents/v1", count: 0, entries: [] }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as never;
});

describe("App", () => {
  test("renders the brief (all-clear), recents, and composer when tokened", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getAllByText(/clear/i).length).toBeGreaterThan(0));
    expect(screen.getByPlaceholderText(/ask/i)).toBeDefined();
  });
});
