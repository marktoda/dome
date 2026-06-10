// dome.daily.carry-forward — the unified yesterday block (D2).
//
// One yesterday surface: the mechanical "since yesterday" digest is the
// fallback BODY of the dual-writer dome.agent.brief:yesterday block, seeded
// by dome.daily only when the block is absent. The retired
// dome.daily:start-context marker is migrated away from TODAY's daily
// (once, idempotently) and never written again; historical dailies keep
// theirs. Normative: [[wiki/specs/daily-surface]] §"The one yesterday block".

import { describe, expect, test } from "bun:test";

import carryForward from "../../assets/extensions/dome.daily/processors/carry-forward";
import {
  dailyPath,
  dailyPathSettings,
  localDateParts,
  previousLocalDate,
} from "../../assets/extensions/dome.daily/processors/daily-shared";
import type { PatchEffect } from "../../src/core/effect";
import { treeOid, type Snapshot } from "../../src/core/processor";
import { commitOid } from "../../src/core/source-ref";
import { makeProcessorContext } from "../../src/processors/context";

const HEAD_COMMIT = commitOid("6666666666666666666666666666666666666666");
const TREE = treeOid("7777777777777777777777777777777777777777");
const FIRED_AT = "2026-06-05T15:00:00.000Z";

const SETTINGS = dailyPathSettings(undefined);
const TODAY = localDateParts(new Date(FIRED_AT));
const TODAY_PATH = dailyPath(TODAY, SETTINGS);
const YESTERDAY_PATH = dailyPath(previousLocalDate(TODAY), SETTINGS);

const YESTERDAY_DAILY = [
  "# 2026-06-04",
  "",
  "## Decisions",
  "",
  "- Keep alpha review in the weekly plan.",
  "",
  "## Done",
  "",
  "- Sent Ada the staffing note.",
  "",
  "## Story of the Day",
  "",
  "The staffing packet landed.",
  "",
].join("\n");

async function runCarryForward(
  files: Readonly<Record<string, string>>,
): Promise<{
  readonly patch: PatchEffect | undefined;
  readonly written: string | null;
}> {
  const ctx = makeProcessorContext({
    snapshot: fakeSnapshot(files),
    changedPaths: [],
    proposal: null,
    runId: "run-yesterday-fallback",
    signal: new AbortController().signal,
    input: { kind: "schedule", cron: "0 6 * * *", firedAt: FIRED_AT },
  });
  const effects = await carryForward.run(ctx);
  const patch = effects.find(
    (effect): effect is PatchEffect => effect.kind === "patch",
  );
  const change = patch?.changes.find((c) => String(c.path) === TODAY_PATH);
  return {
    patch,
    written: change?.kind === "write" ? change.content : null,
  };
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe("dome.daily.carry-forward unified yesterday block (D2)", () => {
  test("migrates a legacy start-context block: removed once, fallback present exactly once, historical daily untouched", async () => {
    const today = [
      "# 2026-06-05",
      "",
      "## Start Here",
      "",
      "<!-- dome.daily:start-context:start -->",
      "### Since Yesterday",
      "- Previous daily: [[wiki/dailies/2026-06-04]]",
      "<!-- dome.daily:start-context:end -->",
      "",
      "Human prose stays.",
      "",
      "## Open Loops",
      "",
      "## Notes",
      "",
    ].join("\n");
    const historicalWithStartContext = [
      "# 2026-06-04 (historical)",
      "",
      "<!-- dome.daily:start-context:start -->",
      "### Since Yesterday",
      "- Previous daily: [[wiki/dailies/2026-06-03]]",
      "<!-- dome.daily:start-context:end -->",
      YESTERDAY_DAILY,
    ].join("\n");

    const { patch, written } = await runCarryForward({
      [TODAY_PATH]: today,
      [YESTERDAY_PATH]: historicalWithStartContext,
    });

    expect(patch).toBeDefined();
    // Only TODAY's daily is patched — the historical daily (a closed record)
    // keeps its legacy start-context block.
    expect(patch!.changes.map((c) => String(c.path))).toEqual([TODAY_PATH]);
    expect(written).not.toBeNull();
    expect(written!).not.toContain("dome.daily:start-context");
    expect(written!).not.toContain("### Since Yesterday");
    expect(written!).toContain("Human prose stays.");
    // Exactly ONE yesterday block, carrying the mechanical fallback body.
    expect(
      occurrences(written!, "<!-- dome.agent.brief:yesterday:start -->"),
    ).toBe(1);
    expect(written!).toContain("### Yesterday");
    expect(written!).toContain(
      "- Previous daily: [[wiki/dailies/2026-06-04]]",
    );
    expect(written!).toContain("- Done yesterday: Sent Ada the staffing note.");

    // Idempotent: a second run over the migrated content emits no patch —
    // the retired block never reappears, the fallback is never duplicated.
    const second = await runCarryForward({
      [TODAY_PATH]: written!,
      [YESTERDAY_PATH]: historicalWithStartContext,
    });
    expect(second.patch).toBeUndefined();
  });

  test("leaves an existing curated yesterday block alone entirely (brief after fallback → one block)", async () => {
    const today = [
      "# 2026-06-05",
      "",
      "## Start Here",
      "",
      "<!-- dome.agent.brief:yesterday:start -->",
      "### Yesterday",
      "- Curated by the brief (from [[wiki/dailies/2026-06-04]])",
      "<!-- dome.agent.brief:yesterday:end -->",
      "",
      "## Open Loops",
      "",
      "## Notes",
      "",
    ].join("\n");

    const { patch } = await runCarryForward({
      [TODAY_PATH]: today,
      [YESTERDAY_PATH]: YESTERDAY_DAILY,
    });
    // Nothing to change: the curated body is preserved verbatim, no
    // mechanical fallback is layered on top, no second block appears.
    expect(patch).toBeUndefined();
  });

  test("no previous daily → the block carries the single no-record line", async () => {
    const today = [
      "# 2026-06-05",
      "",
      "## Start Here",
      "",
      "## Open Loops",
      "",
      "## Notes",
      "",
    ].join("\n");

    const { patch, written } = await runCarryForward({
      [TODAY_PATH]: today,
    });
    expect(patch).toBeDefined();
    expect(written!).toContain(
      "- No record of yesterday — no previous daily note.",
    );
    expect(
      occurrences(written!, "<!-- dome.agent.brief:yesterday:start -->"),
    ).toBe(1);
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
