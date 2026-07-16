import { describe, expect, test } from "bun:test";

import {
  buildTaskBacklogList,
  MAX_TASK_BACKLOG_PAGE_SIZE,
  taskBacklogListSchema,
  type TaskBacklogTaskInput,
} from "../../src/surface/task-backlog";

function task(
  text: string,
  line: number,
  overrides: Partial<TaskBacklogTaskInput> = {},
): TaskBacklogTaskInput {
  const ref = {
    path: "wiki/projects/alpha.md",
    range: { startLine: line, endLine: line },
    stableId: `dome.daily.open-loop:t${line}`,
  };
  return {
    text,
    path: ref.path,
    line,
    source: "backlog",
    followup: false,
    dueDate: null,
    priority: null,
    lastChangedAt: "2026-07-15T12:00:00.000Z",
    sourceRefs: [ref],
    sourceTitle: "Project Alpha",
    ...overrides,
  };
}

describe("TaskBacklog.list document", () => {
  test("classifies the complete logical selector and preserves undated source context", () => {
    const exactRefs = [
      { path: "wiki/a.md", range: { startLine: 2, endLine: 2 }, stableId: "a" },
      { path: "wiki/a.md", range: { startLine: 9, endLine: 9 }, stableId: "b" },
    ];
    const doc = buildTaskBacklogList({
      date: "2026-07-16",
      revision: "abc123",
      tasks: [
        task("past", 1, { dueDate: "2026-07-15" }),
        task("future", 2, { dueDate: "2026-07-20" }),
        task("Same [[work/commitment|commitment]]", 3, { blockId: "t3", sourceRefs: [exactRefs[0]!] }),
        task("same commitment", 9, { blockId: "t9", sourceRefs: [exactRefs[1]!] }),
        task("no date", 4),
      ],
    });

    expect(doc.status).toBe("ok");
    if (doc.status !== "ok") return;
    expect(doc.groups).toEqual({
      overdue: 1,
      dated: 1,
      exactDuplicateCandidates: 1,
      undated: 2,
    });
    expect(doc.items.map((row) => row.classification.timing)).toEqual([
      "overdue",
      "dated",
      "undated",
      "undated",
    ]);
    expect(doc.items[2]?.members.map((member) => member.sourceRefs[0])).toEqual(exactRefs);
    expect(doc.items[2]).toMatchObject({
      normalizedText: "same commitment",
      classification: { exactDuplicateCandidate: true },
      reviewable: true,
    });
    expect(doc.items[3]?.members[0]?.sourceContext).toEqual({
      path: "wiki/projects/alpha.md",
      title: "Project Alpha",
      line: 4,
      lastChangedAt: "2026-07-15T12:00:00.000Z",
    });
    expect(taskBacklogListSchema.parse(doc)).toEqual(doc);
  });

  test("pages deterministically with a snapshot-bound opaque cursor", () => {
    const tasks = [task("one", 1), task("two", 2), task("three", 3)];
    const first = buildTaskBacklogList({ date: "2026-07-16", revision: "abc123", tasks, limit: 2 });
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;
    expect(first.items.map((row) => row.text)).toEqual(["one", "two"]);
    expect(first.page.hasMore).toBe(true);
    expect(first.page.nextCursor).not.toBeNull();

    const second = buildTaskBacklogList({
      date: "2026-07-16",
      revision: "abc123",
      tasks,
      limit: 2,
      cursor: first.page.nextCursor,
    });
    expect(second.status).toBe("ok");
    if (second.status !== "ok") return;
    expect(second.items.map((row) => row.text)).toEqual(["three"]);
    expect(second.page).toMatchObject({ returned: 1, total: 3, hasMore: false, nextCursor: null });

    expect(buildTaskBacklogList({
      date: "2026-07-16",
      revision: "abc123",
      tasks,
      limit: 2,
      cursor: first.page.nextCursor,
    })).toEqual(second);
  });

  test("groups the full set before paging and never folds merely similar text", () => {
    const doc = buildTaskBacklogList({
      date: "2026-07-16",
      revision: "abc123",
      limit: 1,
      tasks: [
        task("Review launch plan", 1, { blockId: "t1" }),
        task("Review launch plan tomorrow", 2, { blockId: "t2" }),
        task("review  launch plan", 3, { blockId: "t3" }),
      ],
    });
    expect(doc.status).toBe("ok");
    if (doc.status !== "ok") return;
    expect(doc.page).toMatchObject({ total: 2, commitments: 3, returned: 1 });
    expect(doc.items[0]?.members.map((member) => member.blockId)).toEqual(["t1", "t3"]);
    expect(doc.items[0]?.classification.exactDuplicateCandidate).toBe(true);
  });

  test("rejects malformed and stale cursors instead of skipping changed work", () => {
    const tasks = [task("one", 1), task("two", 2)];
    const first = buildTaskBacklogList({ date: "2026-07-16", revision: "abc123", tasks, limit: 1 });
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;

    expect(buildTaskBacklogList({
      date: "2026-07-16",
      revision: "abc123",
      tasks,
      cursor: "not+a+cursor",
    })).toMatchObject({ status: "error", error: "invalid-cursor" });
    expect(buildTaskBacklogList({
      date: "2026-07-16",
      revision: "abc123",
      tasks: [...tasks, task("new", 3)],
      cursor: first.page.nextCursor,
    })).toMatchObject({ status: "error", error: "stale-cursor" });
  });

  test("caps caller page sizes", () => {
    const doc = buildTaskBacklogList({
      date: "2026-07-16",
      revision: "abc123",
      tasks: [task("one", 1)],
      limit: 10_000,
    });
    expect(doc.status).toBe("ok");
    if (doc.status === "ok") expect(doc.page.limit).toBe(MAX_TASK_BACKLOG_PAGE_SIZE);
  });

  test("keeps same-file identical task origins distinct and marks transient rows non-reviewable", () => {
    const identical = [
      task("Call Alex", 5, {
        sourceRefs: [{
          path: "wiki/projects/alpha.md",
          range: { startLine: 5, endLine: 5 },
          stableId: "dome.daily.open-loop:shared-body-hash",
        }],
      }),
      task("Call Alex", 11, {
        sourceRefs: [{
          path: "wiki/projects/alpha.md",
          range: { startLine: 11, endLine: 11 },
          stableId: "dome.daily.open-loop:shared-body-hash",
        }],
      }),
    ];
    const doc = buildTaskBacklogList({
      date: "2026-07-16",
      revision: "abc123",
      tasks: identical,
    });
    expect(doc.status).toBe("ok");
    if (doc.status !== "ok") return;
    expect(doc.items).toHaveLength(1);
    expect(doc.items[0]?.members).toHaveLength(2);
    expect(new Set(doc.items[0]?.members.map((member) => member.id)).size).toBe(2);
    expect(doc.items[0]?.members.every((member) => !member.reviewable)).toBe(true);
    expect(doc.items[0]?.reviewable).toBe(false);
  });
});
