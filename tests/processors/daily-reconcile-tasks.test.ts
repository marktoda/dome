import { describe, expect, test } from "bun:test";

import { reconcileSettledOpenLoops } from "../../assets/extensions/dome.daily/processors/daily-shared";

describe("reconcileSettledOpenLoops", () => {
  test("propagates a resolved daily copy back to the origin task line", () => {
    const result = reconcileSettledOpenLoops({
      files: [
        {
          path: "wiki/dailies/2026-01-02.md",
          content: [
            "# 2026-01-02",
            "",
            "## Open Loops",
            "",
            "<!-- dome.daily:open-loops:start -->",
            "### Resolved Today",
            "- [x] ship it (from [[wiki/projects/conv]])",
            "<!-- dome.daily:open-loops:end -->",
            "",
          ].join("\n"),
        },
        {
          path: "wiki/projects/conv.md",
          content: ["# Conv", "", "- [ ] ship it #task ^t1a2b3c4", ""].join(
            "\n",
          ),
        },
      ],
    });

    expect(result).toEqual([
      {
        path: "wiki/projects/conv.md",
        content: ["# Conv", "", "- [x] ship it #task ^t1a2b3c4", ""].join("\n"),
      },
    ]);
  });

  test("skips (does not guess) when the origin has two open lines sharing the body", () => {
    const result = reconcileSettledOpenLoops({
      files: [
        {
          path: "wiki/dailies/2026-01-02.md",
          content: [
            "<!-- dome.daily:open-loops:start -->",
            "### Resolved Today",
            "- [x] ship it (from [[wiki/projects/conv]])",
            "<!-- dome.daily:open-loops:end -->",
            "",
          ].join("\n"),
        },
        {
          path: "wiki/projects/conv.md",
          content: [
            "# Conv",
            "",
            "- [ ] ship it #task ^t1a2b3c4",
            "- [ ] ship it #task ^tdeadbeef",
            "",
          ].join("\n"),
        },
      ],
    });
    // Ambiguous: two open same-body lines, one settled copy — close neither.
    expect(result).toEqual([]);
  });

  test("propagates a dismissed daily copy back as [-]", () => {
    const result = reconcileSettledOpenLoops({
      files: [
        {
          path: "wiki/dailies/2026-01-02.md",
          content: [
            "# 2026-01-02",
            "",
            "- [-] ship it (from [[wiki/projects/conv]])",
            "",
          ].join("\n"),
        },
        {
          path: "wiki/projects/conv.md",
          content: ["# Conv", "", "- [ ] ship it #task ^t1a2b3c4", ""].join(
            "\n",
          ),
        },
      ],
    });

    expect(result).toEqual([
      {
        path: "wiki/projects/conv.md",
        content: ["# Conv", "", "- [-] ship it #task ^t1a2b3c4", ""].join("\n"),
      },
    ]);
  });

  test("is idempotent: an already-settled origin line is not rewritten", () => {
    const result = reconcileSettledOpenLoops({
      files: [
        {
          path: "wiki/dailies/2026-01-02.md",
          content: [
            "# 2026-01-02",
            "",
            "- [x] ship it (from [[wiki/projects/conv]])",
            "",
          ].join("\n"),
        },
        {
          path: "wiki/projects/conv.md",
          content: ["# Conv", "", "- [x] ship it #task ^t1a2b3c4", ""].join(
            "\n",
          ),
        },
      ],
    });

    expect(result).toEqual([]);
  });

  test("no matching origin body leaves everything untouched", () => {
    const result = reconcileSettledOpenLoops({
      files: [
        {
          path: "wiki/dailies/2026-01-02.md",
          content: [
            "# 2026-01-02",
            "",
            "- [x] ship it (from [[wiki/projects/conv]])",
            "",
          ].join("\n"),
        },
        {
          path: "wiki/projects/conv.md",
          content: ["# Conv", "", "- [ ] something else #task", ""].join("\n"),
        },
      ],
    });

    expect(result).toEqual([]);
  });

  test("does not modify the daily's own generated copy line", () => {
    const dailyContent = [
      "# 2026-01-02",
      "",
      "- [x] ship it (from [[wiki/projects/conv]])",
      "",
    ].join("\n");
    const result = reconcileSettledOpenLoops({
      files: [
        { path: "wiki/dailies/2026-01-02.md", content: dailyContent },
        {
          path: "wiki/projects/conv.md",
          content: ["# Conv", "", "- [ ] ship it #task ^t1a2b3c4", ""].join(
            "\n",
          ),
        },
      ],
    });

    // Only the origin file is returned; the daily is never rewritten.
    expect(result.map((file) => file.path)).toEqual(["wiki/projects/conv.md"]);
  });

  test("re-running over the output is a fixed point", () => {
    const files = [
      {
        path: "wiki/dailies/2026-01-02.md",
        content: [
          "# 2026-01-02",
          "",
          "- [x] ship it (from [[wiki/projects/conv]])",
          "",
        ].join("\n"),
      },
      {
        path: "wiki/projects/conv.md",
        content: ["# Conv", "", "- [ ] ship it #task ^t1a2b3c4", ""].join("\n"),
      },
    ];
    const first = reconcileSettledOpenLoops({ files });
    expect(first).toHaveLength(1);

    const merged = files.map((file) => {
      const changed = first.find((f) => f.path === file.path);
      return changed ?? file;
    });
    const second = reconcileSettledOpenLoops({ files: merged });
    expect(second).toEqual([]);
  });
});
