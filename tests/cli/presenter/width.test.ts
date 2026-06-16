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
  test("**bold** → bare text", () => {
    expect(stripEmphasis("**bold**")).toBe("bold");
  });
  test("__bold__ → bare text", () => {
    expect(stripEmphasis("__bold__")).toBe("bold");
  });
  test("*italic* → bare text", () => {
    expect(stripEmphasis("*italic*")).toBe("italic");
  });
  test("_italic_ → bare text", () => {
    expect(stripEmphasis("_italic_")).toBe("italic");
  });
  test("emphasis embedded in a sentence", () => {
    expect(stripEmphasis("**Re-look Erin promo doc** — check details")).toBe("Re-look Erin promo doc — check details");
  });
  test("multiple emphasis spans", () => {
    expect(stripEmphasis("**A** and **B** done")).toBe("A and B done");
  });
  test("plain text is unchanged", () => {
    expect(stripEmphasis("plain label")).toBe("plain label");
  });
  test("unpaired single asterisk left untouched (a*b)", () => {
    // a*b — no matching pair around non-space content
    expect(stripEmphasis("a*b")).toBe("a*b");
  });
  test("snake_case left untouched (no surrounding pair)", () => {
    // snake_case has no matching closing _
    expect(stripEmphasis("snake_case")).toBe("snake_case");
  });
  test("no-op on empty string", () => {
    expect(stripEmphasis("")).toBe("");
  });
});
