import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DomeClient } from "../src/api/client";
import { Recents } from "../src/components/Recents";
import type { Recents as RecentsT } from "../src/api/types";

afterEach(cleanup);

describe("Recents", () => {
  const client = new DomeClient();
  const entry = { path: "wiki/entities/rh.md", title: "Robinhood Chain", lastChangedAt: new Date().toISOString(), changedBy: "engine" as const, subject: "consolidate", commit: "a".repeat(40) };

  test("lists entries by title", () => {
    const recents: RecentsT = { schema: "dome.recents/v1", count: 1, entries: [entry] };
    render(<Recents recents={recents} client={client} interactive />);
    expect(screen.getByText("Robinhood Chain")).toBeDefined();
    expect(screen.getByRole("button", { name: /Robinhood Chain/ })).toBeDefined();
  });
  test("empty state when count is 0", () => {
    render(<Recents recents={{ schema: "dome.recents/v1", count: 0, entries: [] }} client={client} interactive />);
    expect(screen.getByText(/No recent activity/i)).toBeDefined();
  });

  test("opens exact adopted source evidence and restores row focus on Escape", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (request: Request) => {
      const url = new URL(request.url);
      expect(url.searchParams.get("path")).toBe(entry.path);
      expect(url.searchParams.get("commit")).toBe(entry.commit);
      return new Response(JSON.stringify({
        schema: "dome.source-document/v1",
        status: "ok",
        path: entry.path,
        commit: entry.commit,
        content: "# Adopted activity evidence\n",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      render(<Recents recents={{ schema: "dome.recents/v1", count: 1, entries: [entry] }} client={client} interactive />);
      const row = screen.getByRole("button", { name: /Robinhood Chain/ });
      fireEvent.click(row);
      await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
      await waitFor(() => expect(screen.getByText("Adopted activity evidence", { exact: false })).toBeDefined());
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(document.activeElement).toBe(row);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("read capability gates Activity source opening", () => {
    render(<Recents recents={{ schema: "dome.recents/v1", count: 1, entries: [entry] }} client={client} interactive={false} />);
    expect((screen.getByRole("button", { name: /Robinhood Chain/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
