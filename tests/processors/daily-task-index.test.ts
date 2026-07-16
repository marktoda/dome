import { describe, expect, test } from "bun:test";

import taskIndex from "../../assets/extensions/dome.daily/processors/task-index";
import { openLoopSurfaceSources } from "../../assets/extensions/dome.daily/processors/open-loop-surface";
import type { FactEffect } from "../../src/core/effect";
import { treeOid, type Snapshot } from "../../src/core/processor";
import { commitOid } from "../../src/core/source-ref";
import { makeProcessorContext } from "../../src/processors/context";

const COMMIT = commitOid("6666666666666666666666666666666666666666");
const TREE = treeOid("7777777777777777777777777777777777777777");
const NOW = new Date("2026-07-16T12:00:00.000Z");

function context(path: string, content: string) {
  const snapshot = Object.freeze({
    commit: COMMIT,
    tree: TREE,
    readFile: async (candidate: string) => candidate === path ? content : null,
    listMarkdownFiles: async () => Object.freeze([path]),
    getFileInfo: async (candidate: string) =>
      candidate === path ? { lastChangedAt: NOW.toISOString() } : null,
  }) as unknown as Snapshot;
  return makeProcessorContext({
    snapshot,
    changedPaths: [path],
    proposal: null,
    runId: "task-index-test",
    input: { kind: "signal" },
    now: NOW,
    signal: new AbortController().signal,
  });
}

function openTaskBodies(effects: Awaited<ReturnType<typeof taskIndex.run>>) {
  return effects
    .filter((effect): effect is FactEffect =>
      effect.kind === "fact" && effect.predicate === "dome.daily.open_task"
    )
    .map((effect) =>
      effect.object.kind === "string" ? effect.object.value : ""
    );
}

describe("dome.daily.task-index action semantics", () => {
  test("non-daily plain checkboxes stay local while explicit task signals become global facts", async () => {
    const path = "wiki/projects/launch.md";
    const content = [
      "# Launch",
      "",
      "- [ ] Local document checklist",
      "- [ ] Ship tagged work #task",
      "- [ ] Send dated note 📅 2026-07-18",
      "- [ ] Escalate launch risk 🔺",
      "TODO: Confirm the launch owner",
      "We should follow up with Ada about staffing",
      "",
    ].join("\n");

    const effects = await taskIndex.run(context(path, content));
    const bodies = openTaskBodies(effects);

    expect(bodies).not.toContain("Local document checklist");
    expect(bodies).toEqual([
      "Ship tagged work #task",
      "Send dated note 📅 2026-07-18",
      "Escalate launch risk 🔺",
      "Confirm the launch owner",
    ]);
    expect(effects.filter((effect) => effect.kind === "question")).toHaveLength(1);

    // The task fact producer and carry-forward consume one shared selector.
    expect(bodies).toEqual(
      openLoopSurfaceSources({ path, content }).map((item) => item.body),
    );
  });

  test("a plain checkbox in a daily note is globally eligible", async () => {
    const path = "wiki/dailies/2026-07-16.md";
    const content = "# 2026-07-16\n\n- [ ] Call Ada\n";

    expect(openTaskBodies(await taskIndex.run(context(path, content)))).toEqual([
      "Call Ada",
    ]);
  });

  test("generated blocks and fenced examples remain excluded", async () => {
    const path = "wiki/dailies/2026-07-16.md";
    const content = [
      "# 2026-07-16",
      "",
      "```md",
      "- [ ] Fenced example #task",
      "```",
      "",
      "<!-- dome.daily:open-loops:start -->",
      "- [ ] Generated copy #task (from [[wiki/projects/source]])",
      "<!-- dome.daily:open-loops:end -->",
      "",
      "- [ ] Real daily task",
      "",
    ].join("\n");

    expect(openTaskBodies(await taskIndex.run(context(path, content)))).toEqual([
      "Real daily task",
    ]);
  });
});
