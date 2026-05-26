import { describe, test, expect } from "bun:test";
import { parseWikilinks, isFullPathLink } from "../src/wikilinks";

describe("parseWikilinks", () => {
  test("extracts full-path wikilinks", () => {
    const links = parseWikilinks("See [[wiki/entities/danny]] and [[wiki/concepts/team]].");
    expect(links.length).toBe(2);
    expect(links[0]!.target).toBe("wiki/entities/danny");
    expect(links[0]!.isFullPath).toBe(true);
  });

  test("flags short-form wikilinks as non-full-path", () => {
    const links = parseWikilinks("See [[Danny]] short form.");
    expect(links.length).toBe(1);
    expect(links[0]!.isFullPath).toBe(false);
  });

  test("ignores wikilinks inside inline code (single backticks)", () => {
    const links = parseWikilinks("Example: `[[wiki/entities/danny]]` — that's a literal.");
    expect(links.length).toBe(0);
  });

  test("ignores wikilinks inside fenced code blocks (triple backticks)", () => {
    const body = "Setup:\n\n```ts\nconst link = '[[wiki/entities/x]]';\n```\n\nReal link: [[wiki/entities/danny]].";
    const links = parseWikilinks(body);
    expect(links.length).toBe(1);
    expect(links[0]!.target).toBe("wiki/entities/danny");
  });

  test("ignores wikilinks inside tilde-fenced code blocks", () => {
    const body = "~~~\n[[wiki/entities/inside]]\n~~~\n\n[[wiki/entities/outside]]";
    const links = parseWikilinks(body);
    expect(links.length).toBe(1);
    expect(links[0]!.target).toBe("wiki/entities/outside");
  });

  test("ignores short-form wikilinks used as examples in inline code", () => {
    // The hook-non-idempotent.md substrate page does this: it discusses
    // wikilinks by name (`[[wikilink]]`) in prose without intending a link.
    const links = parseWikilinks("Writes `[[wikilink]]` text to the page.");
    expect(links.length).toBe(0);
  });
});

describe("isFullPathLink", () => {
  test("recognizes the 4 typed vault surfaces", () => {
    expect(isFullPathLink("wiki/entities/danny")).toBe(true);
    expect(isFullPathLink("raw/2026-05-25-note")).toBe(true);
    expect(isFullPathLink("notes/draft")).toBe(true);
    expect(isFullPathLink("inbox/raw/capture")).toBe(true);
  });

  test("accepts known vault-root files (VISION, README, CLAUDE)", () => {
    expect(isFullPathLink("VISION")).toBe(true);
    expect(isFullPathLink("README")).toBe(true);
    expect(isFullPathLink("CLAUDE")).toBe(true);
  });

  test("accepts paths under external/tolerated subdirectories (e.g., cohesive/)", () => {
    // Per vault-layout.md, unknown top-level subdirs are tolerated as `external`.
    // Wikilinks pointing at them are full-path (they contain a slash).
    expect(isFullPathLink("cohesive/brainstorms/2026-05-25-dome-vision")).toBe(true);
  });

  test("rejects unprefixed bare names (short-form)", () => {
    expect(isFullPathLink("Danny")).toBe(false);
    expect(isFullPathLink("some-concept")).toBe(false);
  });
});
