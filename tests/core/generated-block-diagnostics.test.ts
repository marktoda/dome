// core/generated-block-diagnostics — anomaly → info DiagnosticEffect shaping.

import { describe, expect, test } from "bun:test";

import { generatedBlockAnomalyDiagnostics } from "../../src/core/generated-block-diagnostics";
import { sourceRef, type TextRange } from "../../src/core/source-ref";

const COMMIT = "8888888888888888888888888888888888888888";

function fakeSourceRef(path: string, range?: TextRange) {
  return sourceRef({
    commit: COMMIT as never,
    path,
    ...(range !== undefined ? { range } : {}),
  });
}

describe("generatedBlockAnomalyDiagnostics", () => {
  test("renders one info diagnostic per anomaly, anchored at the marker line", () => {
    const content = [
      "prose",
      "<!-- dome.daily:open-loops:start -->",
      "body",
      "<!-- dome.daily:open-loops:end -->",
      "<!-- dome.daily:open-loops:end -->",
      "<!-- dome.daily:open-loops:start -->",
    ].join("\n");

    const diagnostics = generatedBlockAnomalyDiagnostics({
      content,
      path: "wiki/dailies/2026-06-10.md",
      code: "dome.daily.generated-block-anomaly",
      blocks: [{ owner: "dome.daily", block: "open-loops" }],
      sourceRef: fakeSourceRef,
    });

    expect(diagnostics.map((d) => d.severity)).toEqual(["info", "info"]);
    expect(diagnostics.map((d) => d.code)).toEqual([
      "dome.daily.generated-block-anomaly",
      "dome.daily.generated-block-anomaly",
    ]);
    expect(diagnostics[0]?.message).toContain("dome.daily:open-loops");
    expect(diagnostics[0]?.message).toContain("orphan-end");
    expect(diagnostics[0]?.message).toContain("line 5");
    expect(diagnostics[0]?.sourceRefs[0]?.range).toEqual({
      startLine: 5,
      endLine: 5,
    });
    expect(diagnostics[1]?.message).toContain("unterminated");
    expect(diagnostics[1]?.sourceRefs[0]?.range).toEqual({
      startLine: 6,
      endLine: 6,
    });
  });

  test("clean content and absent blocks produce no diagnostics", () => {
    const clean = [
      "<!-- dome.daily:open-loops:start -->",
      "body",
      "<!-- dome.daily:open-loops:end -->",
    ].join("\n");
    for (const content of [clean, "no markers at all\n"]) {
      expect(
        generatedBlockAnomalyDiagnostics({
          content,
          path: "wiki/page.md",
          code: "dome.daily.generated-block-anomaly",
          blocks: [
            { owner: "dome.daily", block: "open-loops" },
            { owner: "dome.daily", block: "carried-forward" },
          ],
          sourceRef: fakeSourceRef,
        }),
      ).toEqual([]);
    }
  });
});
