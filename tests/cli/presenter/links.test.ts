import { describe, expect, test } from "bun:test";
import { splitInlineLinks, hyperlink } from "../../../src/cli/presenter/links";
import type { Caps } from "../../../src/cli/presenter/caps";

const caps = (over: Partial<Caps> = {}): Caps => ({ color: true, unicode: true, width: 100, ...over });

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

describe("hyperlink", () => {
  test("emits an OSC 8 escape when hyperlinks are supported", () => {
    expect(hyperlink("thread", "https://x/y", caps({ hyperlinks: true }))).toBe(
      "\x1b]8;;https://x/y\x1b\\thread\x1b]8;;\x1b\\",
    );
  });
  test("returns the bare label when hyperlinks are off", () => {
    expect(hyperlink("thread", "https://x/y", caps({ hyperlinks: false }))).toBe("thread");
  });
  test("returns the bare label when url is empty", () => {
    expect(hyperlink("thread", "", caps({ hyperlinks: true }))).toBe("thread");
  });
});
