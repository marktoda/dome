// Tests for the dome.daily.today/v1 wire contract (tier 1).
// Plan: docs/superpowers/plans/2026-06-22-today-view-model.md (Task 1).

import { expect, test } from "bun:test";
import { todayPayloadSchema, type TodayPayload } from "../../src/surface/today-view";

const valid: unknown = {
  date: "2026-06-22",
  counts: { openTasks: 2, followups: 1, questions: 0 },
  openTasks: [
    {
      text: "ship [[thing]]",
      path: "daily/2026-06-22.md",
      line: 4,
      dueDate: "2026-06-20",
      sourceRefs: [{ path: "daily/2026-06-22.md", commit: "abc123" }],
    },
  ],
  followups: [],
  questions: [],
  brief: null,
  calendar: null,
  hero: { kind: "task", item: { text: "ship [[thing]]", path: "daily/2026-06-22.md", line: 4, dueDate: "2026-06-20" } },
};

test("validates a well-formed payload and preserves sourceRefs (the plural-array contract)", () => {
  const r = todayPayloadSchema.safeParse(valid);
  expect(r.success).toBe(true);
  if (!r.success) return;
  const payload: TodayPayload = r.data;
  expect(payload.openTasks[0]!.sourceRefs).toEqual([{ path: "daily/2026-06-22.md", commit: "abc123" }]);
  expect(payload.hero?.kind).toBe("task");
});

test("passes through the producer's extra envelope fields (consumed-subset contract)", () => {
  const withExtras = {
    ...(valid as Record<string, unknown>),
    limit: 7,
    daily: { path: "daily/2026-06-22.md", sourceRefs: [] },
    sourceCounts: {},
    dueCounts: {},
    shown: { openTasks: 1, followups: 0, questions: 0 },
    omitted: { openTasks: 1, followups: 1, questions: 0 },
  };
  const r = todayPayloadSchema.safeParse(withExtras);
  expect(r.success).toBe(true);
});

test("validates priority and still strips extras", () => {
  const parsed = todayPayloadSchema.parse({
    date: "2026-06-23",
    counts: { openTasks: 1, followups: 0, questions: 0 },
    openTasks: [{ text: "a", path: "p", line: 1, dueDate: null, priority: "high", attention: { discount: 0.1 } }],
    followups: [], questions: [], brief: null, calendar: null, hero: null,
  });
  expect(parsed.openTasks[0]!.priority).toBe("high");
  expect((parsed.openTasks[0] as Record<string, unknown>).attention).toBeUndefined(); // extra stripped
});

test("rejects a payload missing a required consumed field", () => {
  const missingCounts = { ...(valid as Record<string, unknown>) };
  delete (missingCounts as { counts?: unknown }).counts;
  expect(todayPayloadSchema.safeParse(missingCounts).success).toBe(false);
});

test("tolerates optional/nullable task fields (line/dueDate absent)", () => {
  const r = todayPayloadSchema.safeParse({
    ...(valid as Record<string, unknown>),
    openTasks: [{ text: "no due date", path: "p" }],
  });
  expect(r.success).toBe(true);
});
