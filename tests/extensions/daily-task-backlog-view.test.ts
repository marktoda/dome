import { describe, expect, test } from "bun:test";

import taskBacklog from "../../assets/extensions/dome.daily/processors/task-backlog";
import today from "../../assets/extensions/dome.daily/processors/today";
import { OPEN_TASK_PREDICATE } from "../../assets/extensions/dome.daily/processors/action-state";
import type { FactEffect, ViewEffect } from "../../src/core/effect";
import { treeOid, type ProjectionQueryView, type Snapshot } from "../../src/core/processor";
import { makeManualProposal } from "../../src/core/proposal";
import { commitOid } from "../../src/core/source-ref";
import { makeProcessorContext } from "../../src/processors/context";
import { taskBacklogListSchema } from "../../src/surface/task-backlog";

const HEAD = commitOid("abcdef1234567890abcdef1234567890abcdef12");
const NOW = new Date(2026, 6, 16, 9, 0, 0);
const DAILY = "wiki/dailies/2026-07-16.md";

function fact(path: string, line: number, stableId: string, value: string): FactEffect {
  return {
    kind: "fact",
    subject: { kind: "page", path: path as never },
    predicate: OPEN_TASK_PREDICATE,
    object: { kind: "string", value },
    assertion: "extracted",
    sourceRefs: [{
      commit: HEAD,
      path: path as never,
      range: { startLine: line, endLine: line },
      stableId,
    }],
  };
}

function context(facts: ReadonlyArray<FactEffect>) {
  const files = {
    [DAILY]: "---\ntype: daily\n---\n\n# 2026-07-16\n",
    "wiki/a.md": "# A\n",
    "wiki/b.md": "# B\n",
  };
  const snapshot: Snapshot = Object.freeze({
    commit: HEAD,
    tree: treeOid("1111111111111111111111111111111111111111"),
    readFile: async (path: string) => files[path as keyof typeof files] ?? null,
    listMarkdownFiles: async () => Object.freeze(Object.keys(files)),
    getFileInfo: async () => null,
  });
  const projection = {
    facts: (filter?: { readonly predicate?: string }) => facts.filter(
      (item) => filter?.predicate === undefined || item.predicate === filter.predicate,
    ),
    diagnostics: () => [],
    questions: () => [],
    searchDocuments: () => [],
    documentsByPath: (paths: ReadonlyArray<string>) => paths.map((path) => ({
      path,
      sectionId: "intro",
      breadcrumb: null,
      category: "wiki",
      type: "project",
      title: path === "wiki/a.md" ? "Project A" : "Project B",
      snippet: "",
      rank: 1,
      sourceRefs: [],
    })),
  } as unknown as ProjectionQueryView;
  return makeProcessorContext({
    snapshot,
    changedPaths: Object.freeze([]),
    proposal: makeManualProposal({ base: HEAD, head: HEAD, branch: "main" }),
    runId: "run-task-backlog-test",
    now: NOW,
    signal: new AbortController().signal,
    input: { kind: "command", commandArgs: { date: "2026-07-16", limit: 10 } },
    projection,
  });
}

async function structured(
  processor: typeof today,
  facts: ReadonlyArray<FactEffect>,
): Promise<Record<string, unknown>> {
  const effects = await processor.run(context(facts) as never);
  const view = effects.find((effect): effect is ViewEffect => effect.kind === "view");
  if (view?.content.kind !== "structured") throw new Error("no structured view");
  return view.content.data as Record<string, unknown>;
}

describe("dome.daily.task-backlog", () => {
  test("uses Today's exact logical selector and retains exact-duplicate evidence", async () => {
    const facts = [
      fact("wiki/a.md", 2, "dome.daily.open-loop:ta", "Review launch plan"),
      fact("wiki/a.md", 4, "dome.daily.open-loop:tb", "Review launch plan"),
      fact("wiki/b.md", 8, "dome.daily.open-loop:tc", "Write launch note 📅 2026-07-15"),
      fact("wiki/b.md", 10, "dome.daily.open-loop:0123456789abcdef01234567", "Call Alex"),
      fact("wiki/b.md", 11, "dome.daily.open-loop:0123456789abcdef01234567", "Call Alex"),
    ];
    const backlogRaw = await structured(taskBacklog as typeof today, facts);
    const parsed = taskBacklogListSchema.parse(backlogRaw);
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;

    const duplicate = parsed.items.find(
      (item) => item.normalizedText === "review launch plan",
    );
    expect(duplicate?.members.map((member) => [member.path, member.line]))
      .toEqual([["wiki/a.md", 2], ["wiki/a.md", 4]]);
    expect(duplicate?.members.map((member) => member.blockId)).toEqual(["ta", "tb"]);
    expect(duplicate?.members[0]?.sourceContext.title).toBe("Project A");
    const transient = parsed.items.find((item) => item.normalizedText === "call alex");
    expect(transient?.members).toHaveLength(2);
    expect(new Set(transient?.members.map((member) => member.id)).size).toBe(2);
    expect(transient?.members.every((member) => !member.reviewable)).toBe(true);
    expect(parsed.groups).toMatchObject({
      overdue: 1,
      exactDuplicateCandidates: 2,
    });
  });

  test("shares Today's projected origin selector but does not apply its near-duplicate paint fold", async () => {
    const first = "Review detailed launch plan with Alex and product team tomorrow";
    const second = "Review detailed launch plan with Alex product team tomorrow";
    const facts = [
      fact("wiki/a.md", 2, "dome.daily.open-loop:tnear1", first),
      fact("wiki/b.md", 4, "dome.daily.open-loop:tnear2", second),
    ];
    const [todayRaw, backlogRaw] = await Promise.all([
      structured(today, facts),
      structured(taskBacklog as typeof today, facts),
    ]);
    const parsed = taskBacklogListSchema.parse(backlogRaw);
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;

    const todayLaunchRows = (todayRaw["openTasks"] as Array<{ text: string }>)
      .filter((item) => item.text.startsWith("Review detailed launch plan"));
    expect(todayLaunchRows).toHaveLength(1);
    const backlogLaunchUnits = parsed.items.filter((item) =>
      item.normalizedText.startsWith("review detailed launch plan")
    );
    expect(backlogLaunchUnits.map((unit) => unit.normalizedText)).toEqual([
      first.toLowerCase(),
      second.toLowerCase(),
    ]);
    expect(backlogLaunchUnits.flatMap((unit) =>
      unit.members.map((member) => member.sourceRefs[0]?.stableId)
    )).toEqual([
      "dome.daily.open-loop:tnear1",
      "dome.daily.open-loop:tnear2",
    ]);
  });
});
