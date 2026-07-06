// dome.daily.carry-forward — near-duplicate open-loop folding (Task 11, the
// July-5 double-render bug). The same real-world task was written with
// different wording in a synthesis page and an older daily; exact-key dedup
// (openLoopIdentity / openLoopSurfaceKey) cannot fold different phrasings, so
// both copies rendered in the daily. `mergeRetainedOpenLoops`'s `append` now
// additionally scans for a semantic near-duplicate and folds it, replacing
// the incumbent IN PLACE with the more complete phrasing (anchored, then
// dated) when one exists.
//
// The bodies below are the REAL production bullets from
// wiki/dailies/2026-07-05.md, copied verbatim.

import { describe, expect, test } from "bun:test";

import carryForward from "../../assets/extensions/dome.daily/processors/carry-forward";
import { dailyPath, dailyPathSettings, localDateParts } from "../../assets/extensions/dome.daily/processors/daily-paths";
import type { PatchEffect } from "../../src/core/effect";
import { treeOid, type Snapshot } from "../../src/core/processor";
import { commitOid } from "../../src/core/source-ref";
import { makeProcessorContext } from "../../src/processors/context";

const HEAD_COMMIT = commitOid("6666666666666666666666666666666666666666");
const TREE = treeOid("7777777777777777777777777777777777777777");
const FIRED_AT = "2026-07-05T15:00:00.000Z";

// Pair 1: a synthesis-page phrasing vs. an anchored+dated daily phrasing.
const BODY_1 =
  "Send Danny the exact text passages he asked for (blame-forward lines vs. the ownership-first counterfactual) — receipts compiled on [[wiki/entities/danny]] #task";
const BODY_2 =
  "Send Danny the exact blame-forward passages vs. ownership-first counterfactual he asked for [[wiki/entities/danny]] #task 📅 2026-07-03";
// Pair 2: same shape, a different real task from the same daily.
const BODY_3 =
  "Post Mark's system-level ownership message in the rollout thread (drafted 7/02) #task";
const BODY_4 =
  "Post the system-level ownership message in the swapsteps rollout thread [[wiki/syntheses/per-hop-slippage-incident-2026-07]] #task 📅 2026-07-02";
// Negative control: two DISTINCT real tasks from the same daily — must
// survive as two separate lines.
const BODY_5 =
  "Confirm the fix-forward plan lands with a single named owner after Monday's session (Eric S booked it) #task";
const BODY_6 =
  "Decide whether per-hop floors block or gate the Guidestar ramp checkpoints (Cody's plan says continue; Nezlobin wants care in reading experiment data) #task";

describe("dome.daily.carry-forward near-duplicate open-loop folding", () => {
  test("a daily that already retains both duplicate copies renders only the dated survivor after recompose", async () => {
    const targetPath = dailyPath(
      localDateParts(new Date(FIRED_AT)),
      dailyPathSettings(undefined),
    );
    const sourceA = "wiki/dailies/2026-07-03.md";
    const sourceB = "wiki/syntheses/danny-receipts.md";

    // The production bad state: both phrasings already sit in today's daily
    // as retained open-loop copies, each still backed by a live source line.
    const daily = [
      "# Daily",
      "",
      "## Open Loops",
      "",
      "<!-- dome.daily:open-loops:start -->",
      "### Source-backed Open Loops",
      `- [ ] ${BODY_1} (from [[${sourceA.replace(/\.md$/, "")}]])`,
      `- [ ] ${BODY_2} (from [[${sourceB.replace(/\.md$/, "")}]])`,
      "<!-- dome.daily:open-loops:end -->",
      "",
    ].join("\n");

    const files: Record<string, string> = {
      [targetPath]: daily,
      [sourceA]: ["# 2026-07-03", "", `- [ ] ${BODY_1}`, ""].join("\n"),
      [sourceB]: ["# Danny receipts", "", `- [ ] ${BODY_2}`, ""].join("\n"),
    };

    const ctx = makeProcessorContext({
      snapshot: fakeSnapshot(files),
      changedPaths: [],
      proposal: null,
      runId: "run-near-duplicate-fold",
      signal: new AbortController().signal,
      input: { kind: "schedule", cron: "0 6 * * *", firedAt: FIRED_AT },
    });

    const effects = await carryForward.run(ctx);
    const patch = effects.find(
      (effect): effect is PatchEffect => effect.kind === "patch",
    );
    expect(patch).toBeDefined();
    const change = patch?.changes[0];
    expect(change?.kind).toBe("write");
    const nextContent = change !== undefined && "content" in change
      ? change.content
      : "";

    const bulletLines = nextContent
      .split("\n")
      .filter((line) => line.startsWith("- ["));
    expect(bulletLines).toHaveLength(1);
    // The dated phrasing (BODY_2) is the survivor — it carries the 📅 due
    // token the incumbent (BODY_1) lacks.
    expect(bulletLines[0]).toContain("📅 2026-07-03");
    expect(bulletLines[0]).toContain(sourceB.replace(/\.md$/, ""));
    expect(nextContent).not.toContain("receipts compiled on");
  });

  test("a daily retaining the rollout-message duplicate pair collapses to the wikilinked/dated survivor", async () => {
    const targetPath = dailyPath(
      localDateParts(new Date(FIRED_AT)),
      dailyPathSettings(undefined),
    );
    const sourceA = "wiki/dailies/2026-07-02.md";
    const sourceB = "wiki/syntheses/per-hop-slippage-incident-2026-07.md";

    const daily = [
      "# Daily",
      "",
      "## Open Loops",
      "",
      "<!-- dome.daily:open-loops:start -->",
      "### Source-backed Open Loops",
      `- [ ] ${BODY_3} (from [[${sourceA.replace(/\.md$/, "")}]])`,
      `- [ ] ${BODY_4} (from [[${sourceB.replace(/\.md$/, "")}]])`,
      "<!-- dome.daily:open-loops:end -->",
      "",
    ].join("\n");

    const files: Record<string, string> = {
      [targetPath]: daily,
      [sourceA]: ["# 2026-07-02", "", `- [ ] ${BODY_3}`, ""].join("\n"),
      [sourceB]: ["# Per-hop slippage incident", "", `- [ ] ${BODY_4}`, ""].join(
        "\n",
      ),
    };

    const ctx = makeProcessorContext({
      snapshot: fakeSnapshot(files),
      changedPaths: [],
      proposal: null,
      runId: "run-near-duplicate-fold-2",
      signal: new AbortController().signal,
      input: { kind: "schedule", cron: "0 6 * * *", firedAt: FIRED_AT },
    });

    const effects = await carryForward.run(ctx);
    const patch = effects.find(
      (effect): effect is PatchEffect => effect.kind === "patch",
    );
    expect(patch).toBeDefined();
    const change = patch?.changes[0];
    const nextContent = change !== undefined && "content" in change
      ? change.content
      : "";

    const bulletLines = nextContent
      .split("\n")
      .filter((line) => line.startsWith("- ["));
    expect(bulletLines).toHaveLength(1);
    expect(bulletLines[0]).toContain("📅 2026-07-02");
    expect(bulletLines[0]).toContain(sourceB.replace(/\.md$/, ""));
  });

  test("two distinct real tasks from the same daily do NOT fold", async () => {
    const targetPath = dailyPath(
      localDateParts(new Date(FIRED_AT)),
      dailyPathSettings(undefined),
    );
    const sourceA = "wiki/dailies/2026-07-04.md";

    const daily = [
      "# Daily",
      "",
      "## Open Loops",
      "",
      "<!-- dome.daily:open-loops:start -->",
      "### Source-backed Open Loops",
      `- [ ] ${BODY_5} (from [[${sourceA.replace(/\.md$/, "")}]])`,
      `- [ ] ${BODY_6} (from [[${sourceA.replace(/\.md$/, "")}]])`,
      "<!-- dome.daily:open-loops:end -->",
      "",
    ].join("\n");

    const files: Record<string, string> = {
      [targetPath]: daily,
      [sourceA]: [
        "# 2026-07-04",
        "",
        `- [ ] ${BODY_5}`,
        `- [ ] ${BODY_6}`,
        "",
      ].join("\n"),
    };

    const ctx = makeProcessorContext({
      snapshot: fakeSnapshot(files),
      changedPaths: [],
      proposal: null,
      runId: "run-no-fold-distinct-tasks",
      signal: new AbortController().signal,
      input: { kind: "schedule", cron: "0 6 * * *", firedAt: FIRED_AT },
    });

    const effects = await carryForward.run(ctx);
    // No patch effect means the daily is already at its fixed point — both
    // distinct tasks are retained unchanged, exactly as they came in.
    const patch = effects.find(
      (effect): effect is PatchEffect => effect.kind === "patch",
    );
    if (patch === undefined) {
      // Fixed point: nothing to change is itself proof of no accidental
      // fold (a fold would have produced a rewrite dropping one bullet).
      return;
    }
    const change = patch.changes[0];
    const nextContent = change !== undefined && "content" in change
      ? change.content
      : "";
    const bulletLines = nextContent
      .split("\n")
      .filter((line) => line.startsWith("- ["));
    expect(bulletLines).toHaveLength(2);
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
            lastChangedAt: "2026-07-05T09:00:00.000Z",
            lastHumanChangedAt: "2026-07-05T09:00:00.000Z",
          },
  });
}
