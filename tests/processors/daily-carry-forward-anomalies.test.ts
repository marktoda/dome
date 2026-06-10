// dome.daily.carry-forward — generated-block anomaly surfacing.
//
// The splice into the daily note is immune to smuggled / half-open markers
// (the line-anchored scanner binds only the first pair), but the anomaly
// must not stay invisible: carry-forward surfaces each scanner anomaly as an
// info-severity diagnostic (`dome.daily.generated-block-anomaly`) anchored
// at the anomalous marker line. See [[wiki/linters/generated-block-splice-guard]].

import { describe, expect, test } from "bun:test";

import carryForward from "../../assets/extensions/dome.daily/processors/carry-forward";
import {
  dailyPath,
  dailyPathSettings,
  localDateParts,
} from "../../assets/extensions/dome.daily/processors/daily-shared";
import type { DiagnosticEffect } from "../../src/core/effect";
import { treeOid, type Snapshot } from "../../src/core/processor";
import { commitOid } from "../../src/core/source-ref";
import { makeProcessorContext } from "../../src/processors/context";

const HEAD_COMMIT = commitOid("6666666666666666666666666666666666666666");
const TREE = treeOid("7777777777777777777777777777777777777777");
const FIRED_AT = "2026-06-05T15:00:00.000Z";

describe("dome.daily.carry-forward generated-block anomalies", () => {
  test("surfaces a smuggled duplicate open-loops pair as info diagnostics", async () => {
    const targetPath = dailyPath(
      localDateParts(new Date(FIRED_AT)),
      dailyPathSettings(undefined),
    );
    const daily = [
      "# Daily",
      "",
      "## Open Loops",
      "",
      "<!-- dome.daily:open-loops:start -->",
      "### Source-backed Open Loops",
      "- [ ] Keep the project moving (from [[wiki/projects/x]])",
      "<!-- dome.daily:open-loops:end -->",
      "",
      "<!-- dome.daily:open-loops:start -->",
      "- smuggled duplicate pair",
      "<!-- dome.daily:open-loops:end -->",
      "",
    ].join("\n");

    const ctx = makeProcessorContext({
      snapshot: fakeSnapshot({ [targetPath]: daily }),
      changedPaths: [],
      proposal: null,
      runId: "run-carry-forward-anomalies",
      signal: new AbortController().signal,
      input: { kind: "schedule", cron: "0 6 * * *", firedAt: FIRED_AT },
    });

    const effects = await carryForward.run(ctx);
    const diagnostics = effects.filter(
      (effect): effect is DiagnosticEffect => effect.kind === "diagnostic",
    );
    expect(diagnostics).toHaveLength(2);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.severity).toBe("info");
      expect(diagnostic.code).toBe("dome.daily.generated-block-anomaly");
      expect(diagnostic.message).toContain("dome.daily:open-loops");
      expect(diagnostic.message).toContain(targetPath);
      expect(diagnostic.sourceRefs.map((ref) => String(ref.path))).toEqual([
        targetPath,
      ]);
    }
    expect(diagnostics[0]?.message).toContain("extra-start");
    expect(diagnostics[0]?.sourceRefs[0]?.range).toEqual({
      startLine: 10,
      endLine: 10,
    });
    expect(diagnostics[1]?.message).toContain("extra-end");
  });

  test("emits no anomaly diagnostics for a clean daily note", async () => {
    const targetPath = dailyPath(
      localDateParts(new Date(FIRED_AT)),
      dailyPathSettings(undefined),
    );
    const daily = [
      "# Daily",
      "",
      "## Open Loops",
      "",
      "<!-- dome.daily:open-loops:start -->",
      "### Source-backed Open Loops",
      "- [ ] Keep the project moving (from [[wiki/projects/x]])",
      "<!-- dome.daily:open-loops:end -->",
      "",
    ].join("\n");

    const ctx = makeProcessorContext({
      snapshot: fakeSnapshot({ [targetPath]: daily }),
      changedPaths: [],
      proposal: null,
      runId: "run-carry-forward-clean",
      signal: new AbortController().signal,
      input: { kind: "schedule", cron: "0 6 * * *", firedAt: FIRED_AT },
    });

    const effects = await carryForward.run(ctx);
    expect(effects.filter((effect) => effect.kind === "diagnostic")).toEqual(
      [],
    );
  });
});

function fakeSnapshot(files: Readonly<Record<string, string>>): Snapshot {
  return Object.freeze({
    commit: HEAD_COMMIT,
    tree: TREE,
    readFile: async (path: string) => files[path] ?? null,
    listMarkdownFiles: async () =>
      Object.freeze(Object.keys(files).filter((path) => path.endsWith(".md"))),
    getFileInfo: async (path: string) =>
      files[path] === undefined
        ? null
        : {
            lastChangedCommit: HEAD_COMMIT,
            lastChangedAt: "2026-06-05T09:00:00.000Z",
            lastHumanChangedAt: "2026-06-05T09:00:00.000Z",
          },
  });
}
