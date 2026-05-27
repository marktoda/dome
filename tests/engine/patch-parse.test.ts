// Smoke tests for src/engine/patch-parse.ts: unified-diff path extraction
// used by the closure-commit and capability-broker pipelines.

import { describe, test, expect } from "bun:test";
import { firstPatchPath, parsePatchPaths } from "../../src/engine/patch-parse";

describe("parsePatchPaths", () => {
  test("returns unique paths in insertion order for a standard unified diff", () => {
    const patch = [
      "--- a/wiki/foo.md",
      "+++ b/wiki/foo.md",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
    ].join("\n");
    const paths = parsePatchPaths(patch);
    expect(paths).toEqual(["wiki/foo.md"]);
  });

  test("strips `a/` and `b/` prefixes from headers", () => {
    const patch = [
      "--- a/notes/x.md",
      "+++ b/notes/x.md",
    ].join("\n");
    const paths = parsePatchPaths(patch);
    expect(paths).toEqual(["notes/x.md"]);
  });

  test("skips `/dev/null` (file creation)", () => {
    const patch = [
      "--- /dev/null",
      "+++ b/notes/new.md",
    ].join("\n");
    const paths = parsePatchPaths(patch);
    expect(paths).toEqual(["notes/new.md"]);
  });

  test("handles multiple files in one patch (unique, insertion order)", () => {
    const patch = [
      "--- a/wiki/a.md",
      "+++ b/wiki/a.md",
      "@@ ...",
      "--- a/wiki/b.md",
      "+++ b/wiki/b.md",
    ].join("\n");
    const paths = parsePatchPaths(patch);
    expect(paths).toEqual(["wiki/a.md", "wiki/b.md"]);
  });

  test("empty patch text returns an empty frozen array", () => {
    const paths = parsePatchPaths("");
    expect(paths).toEqual([]);
    expect(Object.isFrozen(paths)).toBe(true);
  });
});

describe("firstPatchPath", () => {
  test("returns the first parsed path", () => {
    const patch = [
      "--- a/wiki/first.md",
      "+++ b/wiki/first.md",
    ].join("\n");
    expect(firstPatchPath(patch)).toBe("wiki/first.md");
  });

  test("returns null when no headers parse", () => {
    expect(firstPatchPath("not a diff")).toBeNull();
  });
});
