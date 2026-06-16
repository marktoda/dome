import { describe, expect, test } from "bun:test";
import { shortenLabel, stripEmphasis } from "../../../src/cli/presenter/width";

describe("shortenLabel", () => {
  test("returns the text unchanged when it already fits", () => {
    expect(shortenLabel("short task", 40)).toBe("short task");
  });
  test("never cuts mid-word — backs off to the last word boundary", () => {
    const out = shortenLabel("confirm RH Chain launch-day token catalog work", 24);
    expect(out.endsWith("…")).toBe(true);
    const head = out.slice(0, -1).trimEnd();
    expect("confirm RH Chain launch-day token catalog work".startsWith(head)).toBe(true);
    expect(head.endsWith("launch-day") || head.endsWith("Chain") || head.endsWith("token")).toBe(true);
  });
  test("prefers a clause boundary when one sits late in the fit", () => {
    const out = shortenLabel("Partner call: confirm the token catalog and the rest", 22);
    expect(out).toBe("Partner call:…");
  });
  test("ascii ellipsis when unicode is false", () => {
    expect(shortenLabel("one two three four five", 12, false).endsWith("...")).toBe(true);
  });
});

describe("stripEmphasis", () => {
  // --- strips **bold** (the only form we handle) ---
  test("**bold** → bare text", () => {
    expect(stripEmphasis("**bold**")).toBe("bold");
  });
  test("**a** and **b** → a and b", () => {
    expect(stripEmphasis("**a** and **b**")).toBe("a and b");
  });
  test("**bold** embedded in a sentence", () => {
    expect(stripEmphasis("**Re-look Erin promo doc** — check details")).toBe("Re-look Erin promo doc — check details");
  });
  test("plain text is unchanged", () => {
    expect(stripEmphasis("plain label")).toBe("plain label");
  });
  test("no-op on empty string", () => {
    expect(stripEmphasis("")).toBe("");
  });

  // --- safety: single markers and dunders are NOT stripped ---
  test("snake_case is unchanged (no over-strip)", () => {
    expect(stripEmphasis("foo_bar_baz")).toBe("foo_bar_baz");
  });
  test("URL with underscores is unchanged", () => {
    expect(stripEmphasis("https://x.com/path_with_underscores")).toBe("https://x.com/path_with_underscores");
  });
  test("__init__ is unchanged", () => {
    expect(stripEmphasis("__init__")).toBe("__init__");
  });
  test("math expression with * is unchanged", () => {
    expect(stripEmphasis("2 * 3 = 6")).toBe("2 * 3 = 6");
  });
  test("*italic* is unchanged (we do NOT strip single emphasis)", () => {
    expect(stripEmphasis("*italic*")).toBe("*italic*");
  });
  test("_emphasis_ is unchanged", () => {
    expect(stripEmphasis("_emphasis_")).toBe("_emphasis_");
  });
  test("__bold__ is unchanged (we do NOT strip double-underscore)", () => {
    expect(stripEmphasis("__bold__")).toBe("__bold__");
  });
});
