import { describe, expect, test } from "bun:test";
import { lintPayloadSchema } from "../../src/surface/lint-view";

describe("lintPayloadSchema", () => {
  test("parses a full lint payload", () => {
    const r = lintPayloadSchema.parse({
      status: "fail",
      failOn: "error",
      checked: { markdownFiles: 12 },
      counts: { total: 3, info: 1, warning: 1, error: 1, block: 0 },
      shownIssues: 3,
      omittedIssues: 0,
      issues: [
        {
          severity: "error",
          code: "X",
          message: "m",
          sourceRefs: [{ path: "a.md", commit: "abc" }],
        },
      ],
    });
    expect(r.status).toBe("fail");
    expect(r.issues[0]?.sourceRefs[0]?.path).toBe("a.md");
  });

  test("backfills lenient defaults (missing counts → 0, missing failOn → error)", () => {
    const r = lintPayloadSchema.parse({
      status: "pass",
      checked: {},
      counts: {},
      issues: [],
    });
    expect(r.failOn).toBe("error");
    expect(r.counts.total).toBe(0);
    expect(r.checked.markdownFiles).toBe(0);
  });

  test("rejects a bad status (hard contract)", () => {
    expect(() => lintPayloadSchema.parse({ status: "weird" })).toThrow();
  });
});
