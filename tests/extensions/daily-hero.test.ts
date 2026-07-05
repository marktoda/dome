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
  test("hero picks the higher-priority overdue task when both are overdue", () => {
    const unprioritized = task({
      text: "old",
      dueDate: "2026-01-01",
    });
    const prioritized = task({
      text: "due-ish",
      dueDate: "2026-06-10",
      priority: "high",
    });
    expect(selectHero({ openTasks: [unprioritized, prioritized], questions: [], today: "2026-06-14" })).toEqual({ kind: "task", item: prioritized });
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
