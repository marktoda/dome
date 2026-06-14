import { describe, expect, test } from "bun:test";

import {
  selectHero,
  type DailyQuestionItem,
  type DailyTaskItem,
} from "../../assets/extensions/dome.daily/processors/action-state";

// ---------------------------------------------------------------------------
// Minimal fixture builders — only the fields that affect selectHero logic.
// ---------------------------------------------------------------------------

function task(overrides: Partial<DailyTaskItem> & { text: string }): DailyTaskItem {
  const defaults: DailyTaskItem = Object.freeze({
    text: overrides.text,
    path: "wiki/dailies/2026-06-14.md",
    line: null,
    source: "daily" as const,
    followup: false,
    dueDate: null,
    priority: null,
    lastChangedAt: null,
    attention: null,
    evidenceLabel: overrides.text,
    sourceRefs: Object.freeze([]),
  });
  return Object.freeze({ ...defaults, ...overrides });
}

function question(overrides: Partial<DailyQuestionItem> & { automationPolicy: string }): DailyQuestionItem {
  const defaults: DailyQuestionItem = Object.freeze({
    id: 1,
    question: "Is this real?",
    options: Object.freeze(["yes", "no"]),
    resolveCommand: "dome resolve 1 <yes|no>",
    metadata: null,
    automationPolicy: overrides.automationPolicy,
    path: "wiki/dailies/2026-06-14.md",
    line: null,
    source: "daily" as const,
    lastChangedAt: null,
    evidenceLabel: "wiki/dailies/2026-06-14.md",
    sourceRefs: Object.freeze([]),
  });
  return Object.freeze({ ...defaults, ...overrides });
}

describe("selectHero", () => {
  test("hero picks the most-urgent non-discounted overdue task (zombie discounted out)", () => {
    const zombie = task({
      text: "old",
      dueDate: "2026-01-01",
      attention: { discount: 0.95, impressions: 40, lastShown: "2026-06-01" },
    });
    const real = task({
      text: "due-ish",
      dueDate: "2026-06-10",
      priority: "high",
    });
    expect(selectHero({ openTasks: [zombie, real], questions: [], today: "2026-06-14" })).toEqual({ kind: "task", item: real });
  });

  test("hero falls back to an owner-needed question when no overdue task", () => {
    const q = question({ automationPolicy: "owner-needed" });
    expect(selectHero({ openTasks: [], questions: [q], today: "2026-06-14" })).toEqual({ kind: "question", item: q });
  });

  test("hero is null when nothing qualifies", () => {
    expect(selectHero({ openTasks: [], questions: [], today: "2026-06-14" })).toBeNull();
  });

  test("among overdue tasks the higher-priority one wins", () => {
    const lowPriority = task({ text: "low", dueDate: "2026-06-10", priority: "low" });
    const highPriority = task({ text: "high", dueDate: "2026-06-10", priority: "high" });
    const result = selectHero({ openTasks: [lowPriority, highPriority], questions: [], today: "2026-06-14" });
    expect(result).toEqual({ kind: "task", item: highPriority });
  });

  test("discount exactly at floor is excluded (discount >= HERO_DISCOUNT_FLOOR)", () => {
    const borderline = task({ text: "borderline", dueDate: "2026-06-10", attention: { discount: 0.5, impressions: 10, lastShown: "2026-06-01" } });
    expect(selectHero({ openTasks: [borderline], questions: [], today: "2026-06-14" })).toBeNull();
  });

  test("discount just below floor is hero-eligible", () => {
    const nearBorder = task({ text: "near", dueDate: "2026-06-10", attention: { discount: 0.49, impressions: 10, lastShown: "2026-06-01" } });
    expect(selectHero({ openTasks: [nearBorder], questions: [], today: "2026-06-14" })).toEqual({ kind: "task", item: nearBorder });
  });

  test("non-overdue task is hero when no overdue/question candidates", () => {
    const upcoming = task({ text: "soon", dueDate: "2026-06-20" });
    expect(selectHero({ openTasks: [upcoming], questions: [], today: "2026-06-14" })).toEqual({ kind: "task", item: upcoming });
  });

  test("owner-needed question beats agent-safe question", () => {
    const agentSafe = question({ automationPolicy: "agent-safe", id: 1, question: "agent-safe q" });
    const ownerNeeded = question({ automationPolicy: "owner-needed", id: 2, question: "owner-needed q" });
    expect(selectHero({ openTasks: [], questions: [agentSafe, ownerNeeded], today: "2026-06-14" })).toEqual({ kind: "question", item: ownerNeeded });
  });
});
