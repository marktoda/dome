import { describe, expect, test } from "bun:test";

import { normalizeTaskSyntax } from "../../assets/extensions/dome.daily/processors/action-extraction";

describe("normalizeTaskSyntax", () => {
  test("returns null for an Obsidian Tasks query-dashboard file", () => {
    const content = "# Tasks\n\n```tasks\nnot done\n```\n\n- [X] loose   spacing #task\n";
    expect(normalizeTaskSyntax(content)).toBeNull();
  });

  test("lowercases an uppercase checkbox marker", () => {
    expect(normalizeTaskSyntax("- [X] foo\n")).toBe("- [x] foo\n");
  });

  test("collapses the run of spaces after the marker to exactly one", () => {
    expect(normalizeTaskSyntax("- [x]   foo\n")).toBe("- [x] foo\n");
  });

  test("trims trailing whitespace on a task line", () => {
    expect(normalizeTaskSyntax("- [x] foo   \n")).toBe("- [x] foo\n");
  });

  test("preserves a trailing ^block-anchor while trimming after it", () => {
    expect(normalizeTaskSyntax("- [ ] foo ^t1a2b3c4   \n")).toBe(
      "- [ ] foo ^t1a2b3c4\n",
    );
  });

  test("keeps the anchor intact on an otherwise clean anchored line", () => {
    expect(normalizeTaskSyntax("- [ ] foo ^t1a2b3c4\n")).toBeNull();
  });

  test("leaves [ ] and [-] markers as-is", () => {
    expect(normalizeTaskSyntax("- [ ] foo\n- [-] bar\n")).toBeNull();
  });

  test("returns null when nothing changes (idempotent fixed point)", () => {
    expect(normalizeTaskSyntax("- [x] foo\n")).toBeNull();
  });

  test("re-running over the output returns null (idempotent)", () => {
    const out = normalizeTaskSyntax("- [X]   foo   \n")!;
    expect(out).toBe("- [x] foo\n");
    expect(normalizeTaskSyntax(out)).toBeNull();
  });

  test("does not alter non-task prose", () => {
    const content = "# Heading\n\njust some prose   \nwith [X] not a checkbox\n";
    expect(normalizeTaskSyntax(content)).toBeNull();
  });

  test("does not collapse spacing elsewhere in the body", () => {
    expect(normalizeTaskSyntax("- [x] foo    bar\n")).toBeNull();
  });

  test("preserves line count and surrounding lines verbatim", () => {
    const content = "# Conv\n\nprose line\n\n- [X]   do it\n\nmore prose\n";
    const out = normalizeTaskSyntax(content)!;
    expect(out.split("\n")).toHaveLength(content.split("\n").length);
    expect(out).toContain("# Conv");
    expect(out).toContain("prose line");
    expect(out).toContain("more prose");
    expect(out).toContain("- [x] do it");
  });

  test("normalizes multiple task lines in one pass", () => {
    expect(normalizeTaskSyntax("- [X] a\n- [x]   b\n")).toBe(
      "- [x] a\n- [x] b\n",
    );
  });

  test("does not change semantics of [ ] / [-] / [x] markers", () => {
    // Only casing/spacing changes; an already-clean dismissed task is untouched.
    expect(normalizeTaskSyntax("- [-] dismissed\n")).toBeNull();
  });
});
