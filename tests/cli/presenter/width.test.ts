import { describe, expect, test } from "bun:test";
import { shortenLabel } from "../../../src/cli/presenter/width";

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
