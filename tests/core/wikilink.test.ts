import { test, expect } from "bun:test";
import { stripWikilinks } from "../../src/core/wikilink";

test("alias form keeps the alias", () => {
  expect(stripWikilinks("see [[wiki/x|the X thing]] now")).toBe("see the X thing now");
});
test("bare path → last segment, drops .md", () => {
  expect(stripWikilinks("ref [[wiki/entities/cody-born]] and [[notes/plan.md]]")).toBe("ref cody-born and plan");
});
test("collapses leftover whitespace, trims", () => {
  expect(stripWikilinks("a   [[x]]   b")).toBe("a x b");
});
test("plain text unchanged", () => {
  expect(stripWikilinks("nothing here")).toBe("nothing here");
});
