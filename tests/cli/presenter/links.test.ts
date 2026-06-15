import { describe, expect, test } from "bun:test";
import { splitInlineLinks } from "../../../src/cli/presenter/links";

describe("splitInlineLinks", () => {
  test("pulls one trailing link out and drops the dangling bullet separator", () => {
    const r = splitInlineLinks("Reply to Charlie re: Shankman · [thread](https://x/y)");
    expect(r.text).toBe("Reply to Charlie re: Shankman");
    expect(r.links).toEqual([{ label: "thread", url: "https://x/y" }]);
  });
  test("pulls multiple links in order", () => {
    const r = splitInlineLinks("Recruiting round w/ Guillaume [thread](https://a) [doc](https://b)");
    expect(r.text).toBe("Recruiting round w/ Guillaume");
    expect(r.links).toEqual([
      { label: "thread", url: "https://a" },
      { label: "doc", url: "https://b" },
    ]);
  });
  test("leaves link-free text untouched", () => {
    const r = splitInlineLinks("call the landlord");
    expect(r.text).toBe("call the landlord");
    expect(r.links).toEqual([]);
  });
  test("ignores image syntax", () => {
    const r = splitInlineLinks("see ![chart](https://img)");
    expect(r.text).toBe("see ![chart](https://img)");
    expect(r.links).toEqual([]);
  });
});
