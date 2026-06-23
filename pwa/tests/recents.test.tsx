import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { Recents } from "../src/components/Recents";
import type { Recents as RecentsT } from "../src/api/types";

afterEach(cleanup);

describe("Recents", () => {
  test("lists entries by title", () => {
    const recents: RecentsT = { schema: "dome.recents/v1", count: 1, entries: [{ path: "wiki/entities/rh.md", title: "Robinhood Chain", lastChangedAt: new Date().toISOString(), changedBy: "engine", subject: "consolidate" }] };
    render(<Recents recents={recents} />);
    expect(screen.getByText("Robinhood Chain")).toBeDefined();
  });
  test("empty state when count is 0", () => {
    render(<Recents recents={{ schema: "dome.recents/v1", count: 0, entries: [] }} />);
    expect(screen.getByText(/nothing recent/i)).toBeDefined();
  });
});
