import { describe, expect, test } from "bun:test";

import { duplicateTaskAnchorFindings } from "../../src/engine/host/health";

describe("duplicateTaskAnchorFindings", () => {
  test("reports duplicate task anchors across origin task lines", () => {
    const findings = duplicateTaskAnchorFindings({
      files: [
        {
          path: "wiki/projects/alpha.md",
          content: "- [x] closed one ^tdeadbeef\n",
        },
        {
          path: "wiki/projects/beta.md",
          content: "- [ ] still open #task ^tdeadbeef\n",
        },
      ],
    });

    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.code).toBe("task.duplicate-anchor");
    expect(finding.severity).toBe("warning");
    if (finding.code !== "task.duplicate-anchor") return;
    expect(finding.taskAnchor.anchor).toBe("tdeadbeef");
    expect(finding.taskAnchor.occurrences).toEqual([
      {
        path: "wiki/projects/alpha.md",
        line: 1,
        text: "- [x] closed one ^tdeadbeef",
      },
      {
        path: "wiki/projects/beta.md",
        line: 1,
        text: "- [ ] still open #task ^tdeadbeef",
      },
    ]);
  });

  test("ignores repeated anchors inside generated open-loop projections", () => {
    const findings = duplicateTaskAnchorFindings({
      files: [
        {
          path: "wiki/projects/alpha.md",
          content: "- [ ] origin task #task ^tdeadbeef\n",
        },
        {
          path: "wiki/dailies/2026-06-24.md",
          content: [
            "# 2026-06-24",
            "",
            "<!-- dome.daily:open-loops:start -->",
            "### Source-backed Open Loops",
            "- [ ] origin task #task (from [[wiki/projects/alpha]]) ^tdeadbeef",
            "<!-- dome.daily:open-loops:end -->",
            "",
          ].join("\n"),
        },
      ],
    });

    expect(findings).toEqual([]);
  });

  test("includes captured-block task origins in the duplicate scan", () => {
    const findings = duplicateTaskAnchorFindings({
      files: [
        {
          path: "wiki/dailies/2026-06-24.md",
          content: [
            "# 2026-06-24",
            "",
            "<!-- dome.daily:captured:start -->",
            "- [ ] captured task ^tcafebabe",
            "<!-- dome.daily:captured:end -->",
            "- [ ] second origin ^tcafebabe",
            "",
          ].join("\n"),
        },
      ],
    });

    expect(findings.map((finding) => finding.code)).toEqual([
      "task.duplicate-anchor",
    ]);
  });
});
