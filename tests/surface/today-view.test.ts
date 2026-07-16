import { describe, expect, test } from "bun:test";
import {
  parseTodayView,
  addDays,
  buildTodayViewModel,
  classifyUrgency,
  priorityMarkerChars,
} from "../../src/surface/today-view";

test("priorityMarkerChars maps all five levels + null", () => {
  expect(priorityMarkerChars("highest", true)).toBe("▲▲");
  expect(priorityMarkerChars("high", true)).toBe("▲");
  expect(priorityMarkerChars("medium", true)).toBe("");
  expect(priorityMarkerChars("low", true)).toBe("▽");
  expect(priorityMarkerChars("lowest", true)).toBe("▽▽");
  expect(priorityMarkerChars(null, true)).toBe("");
  expect(priorityMarkerChars("highest", false)).toBe("^^");
  expect(priorityMarkerChars("lowest", false)).toBe("vv");
});

test("parses tasks with wikilinks stripped + dueDate", () => {
  const v = parseTodayView({ date: "2026-06-14",
    openTasks: [{ text: "talk to [[wiki/x|Eric]]", path: "p", line: 1, dueDate: "2026-06-10" }],
    followups: [], questions: [], counts: { openTasks: 1, followups: 0, questions: 0 }, brief: null, calendar: null, hero: null });
  expect(v.openTasks[0]!.text).toBe("talk to Eric");
  expect(v.openTasks[0]!.dueDate).toBe("2026-06-10");
});

test("parseTaskRows carries priority for all five literals + null/unknown", () => {
  const v = parseTodayView({
    date: "2026-06-23",
    openTasks: [
      { text: "a", path: "p", line: 1, dueDate: null, priority: "highest" },
      { text: "b", path: "p", line: 2, dueDate: null, priority: "low" },
      { text: "c", path: "p", line: 3, dueDate: null },
      { text: "d", path: "p", line: 4, dueDate: null, priority: "bogus" },
    ],
    followups: [], questions: [],
    counts: { openTasks: 4, followups: 0, questions: 0 },
    brief: null, calendar: null, hero: null,
  });
  expect(v.openTasks.map((t) => t.priority ?? null)).toEqual(["highest", "low", null, null]);
});

test("parseTaskRows carries blockId when present, omits it when absent (settle identity)", () => {
  const v = parseTodayView({
    date: "2026-06-23",
    openTasks: [
      { text: "anchored", path: "p", line: 1, dueDate: null, blockId: "t1a2b3c4" },
      { text: "unanchored", path: "p", line: 2, dueDate: null },
    ],
    followups: [], questions: [],
    counts: { openTasks: 2, followups: 0, questions: 0 },
    brief: null, calendar: null, hero: null,
  });
  expect(v.openTasks[0]!.blockId).toBe("t1a2b3c4");
  expect(v.openTasks[1]!.blockId).toBeUndefined();
});

test("parseTaskRows preserves task provenance metadata for why-lines", () => {
  const v = parseTodayView({
    date: "2026-06-14",
    openTasks: [
      {
        text: "reply to [[people/jane|Jane]]",
        path: "wiki/dailies/2026-06-14.md",
        line: 20,
        source: "daily",
        dueDate: "2026-06-10",
        evidenceLabel: "wiki/dailies/2026-06-14.md:20; source wiki/projects/client.md:7",
        lastChangedAt: "2026-06-13T10:00:00.000Z",
        sourceRefs: [
          {
            path: "wiki/dailies/2026-06-14.md",
            range: { startLine: 20, endLine: 20 },
            stableId: "t1",
          },
          {
            path: "wiki/projects/client.md",
            range: { startLine: 7, endLine: 7 },
            stableId: "t1",
          },
        ],
      },
    ],
    followups: [],
    questions: [],
    counts: { openTasks: 1, followups: 0, questions: 0 },
    brief: null,
    calendar: null,
    hero: null,
  });
  const row = v.openTasks[0]!;
  expect(row.text).toBe("reply to Jane");
  expect(row.source).toBe("daily");
  expect(row.evidenceLabel).toBe("wiki/dailies/2026-06-14.md:20; source wiki/projects/client.md:7");
  expect(row.lastChangedAt).toBe("2026-06-13T10:00:00.000Z");
  expect(row.sourceRefs?.map((ref) => `${ref.path}:${ref.range?.startLine}:${ref.stableId}`)).toEqual([
    "wiki/dailies/2026-06-14.md:20:t1",
    "wiki/projects/client.md:7:t1",
  ]);
});

test("parses question options + resolveCommand", () => {
  const v = parseTodayView({ date: "x", openTasks: [], followups: [],
    questions: [{ id: 7, question: "go?", options: ["yes","no"], resolveCommand: "dome resolve 7" }],
    counts: { openTasks: 0, followups: 0, questions: 1 }, brief: null, calendar: null, hero: null });
  expect(v.questions[0]!.options).toEqual(["yes","no"]);
  expect(v.questions[0]!.id).toBe(7);
});

test("parses proposal reviews and the owner backlog", () => {
  const v = parseTodayView({
    date: "x",
    openTasks: [],
    followups: [],
    questions: [],
    reviews: [{
      id: 9,
      reason: "Promote the repair processor",
      processorId: "dome.health.trust-review",
      paths: [".dome/config.yaml"],
      reviewCommand: "dome proposals",
    }],
    attentionBacklog: 2,
    counts: { openTasks: 0, followups: 0, questions: 0, reviews: 1 },
    brief: null,
    calendar: null,
    hero: null,
  });
  expect(v.reviews[0]).toEqual(expect.objectContaining({
    id: 9,
    reason: "Promote the repair processor",
  }));
  expect(v.attentionBacklog).toBe(2);
  expect(buildTodayViewModel(v).totalOpen).toBe(1);
});

test("brief/calendar/hero null-safe + counts carried", () => {
  const v = parseTodayView({ date: "x", openTasks: [], followups: [], questions: [], counts: { openTasks: 3, followups: 1, questions: 2 }, brief: null, calendar: null, hero: null });
  expect(v.brief).toBeNull(); expect(v.calendar).toBeNull(); expect(v.hero).toBeNull();
  expect(v.counts).toEqual({ openTasks: 3, followups: 1, questions: 2 });
});

test("addDays: valid input produces correct result", () => {
  expect(addDays("2026-06-28", 7)).toBe("2026-07-05");
  expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
});

test("addDays: malformed input returns the input unchanged (NaN-guard)", () => {
  expect(addDays("not-a-date", 7)).toBe("not-a-date");
  expect(addDays("2026-06", 7)).toBe("2026-06");
});

test("hero task text stripped of wikilinks", () => {
  const v = parseTodayView({ date: "x", openTasks: [], followups: [], questions: [], counts: {}, brief: null, calendar: null,
    hero: { kind: "task", item: { text: "do [[wiki/y|the thing]]", path: "p", line: 1, dueDate: null } } });
  expect(v.hero?.kind).toBe("task");
  const item = (v.hero as { kind: "task"; item: { text: string; entities?: readonly string[] } }).item;
  expect(item.text).toBe("do the thing");
  expect(item.entities).toEqual(["y"]);
});

test("task rows expose [[entity]] slugs as a structured `entities` field", () => {
  const view = parseTodayView({
    date: "2026-06-15",
    openTasks: [{ text: "ping [[people/cody-born]] and [[siyu|Siyu Z]] re: routing", path: "p", line: 1, dueDate: null }],
    counts: { openTasks: 1, followups: 0, questions: 0 },
  });
  expect(view.openTasks[0]!.entities).toEqual(["cody-born", "siyu"]);
  expect(view.openTasks[0]!.text).toBe("ping cody-born and Siyu Z re: routing"); // still stripped
});

test("a row with no wikilinks has empty/absent entities", () => {
  const view = parseTodayView({ date: "x", openTasks: [{ text: "plain task", path: "p", line: 1, dueDate: null }], counts: { openTasks: 1, followups: 0, questions: 0 } });
  expect(view.openTasks[0]!.entities ?? []).toEqual([]);
});

// ── Tier 2: buildTodayViewModel ──────────────────────────────────────────────

describe("classifyUrgency", () => {
  const today = "2026-06-22";
  test("null due date → someday", () => {
    expect(classifyUrgency(null, today)).toEqual({ kind: "someday" });
  });
  test("past → overdue with whole-day count", () => {
    expect(classifyUrgency("2026-06-20", today)).toEqual({ kind: "overdue", days: 2 });
  });
  test("equal → due-today", () => {
    expect(classifyUrgency(today, today)).toEqual({ kind: "due-today" });
  });
  test("within +7 (inclusive) → this-week", () => {
    expect(classifyUrgency("2026-06-29", today)).toEqual({ kind: "this-week", date: "2026-06-29" }); // +7
    expect(classifyUrgency("2026-06-23", today)).toEqual({ kind: "this-week", date: "2026-06-23" }); // +1
  });
  test("beyond +7 → later", () => {
    expect(classifyUrgency("2026-06-30", today)).toEqual({ kind: "later", date: "2026-06-30" }); // +8
  });
});

describe("buildTodayViewModel", () => {
  const base = {
    date: "2026-06-22",
    counts: { openTasks: 4, followups: 0, questions: 1 },
    followups: [],
    brief: null,
    calendar: null,
  };

  test("partitions hero-deduped tasks into the five sections", () => {
    const vm = buildTodayViewModel(
      parseTodayView({
        ...base,
        openTasks: [
          { text: "overdue one", path: "p", line: 1, dueDate: "2026-06-20" },
          { text: "due today", path: "p", line: 2, dueDate: "2026-06-22" },
          { text: "this week", path: "p", line: 3, dueDate: "2026-06-25" },
          { text: "far", path: "p", line: 4, dueDate: "2026-08-01" },
          { text: "no date", path: "p", line: 5, dueDate: null },
        ],
        questions: [],
        hero: null,
      }),
    );
    expect(vm.stillOpen.overdue.map((t) => t.text)).toEqual(["overdue one"]);
    expect(vm.stillOpen.dueToday.map((t) => t.text)).toEqual(["due today"]);
    expect(vm.stillOpen.thisWeek.map((t) => t.text)).toEqual(["this week"]);
    expect(vm.stillOpen.later.map((t) => t.text)).toEqual(["far"]);
    expect(vm.stillOpen.someday.map((t) => t.text)).toEqual(["no date"]);
  });

  test("no longer exposes a hero; every open task lands in a section (the would-be hero is NOT deduped out)", () => {
    const vm = buildTodayViewModel(
      parseTodayView({
        ...base,
        openTasks: [
          { text: "the would-be hero", path: "p", line: 1, dueDate: "2026-06-20" },
          { text: "other", path: "p", line: 2, dueDate: "2026-06-22" },
        ],
        questions: [],
        // even when the payload still carries a hero, the view-model ignores it:
        hero: { kind: "task", item: { text: "the would-be hero", path: "p", line: 1, dueDate: "2026-06-20" } },
      }),
    );
    expect("hero" in vm).toBe(false);
    expect("heroUrgency" in vm).toBe(false);
    expect(vm.stillOpen.overdue.map((t) => t.text)).toEqual(["the would-be hero"]);
    expect(vm.stillOpen.dueToday.map((t) => t.text)).toEqual(["other"]);
  });

  test("totalOpen counts tasks + followups + questions", () => {
    const vm = buildTodayViewModel(
      parseTodayView({
        ...base,
        openTasks: [],
        questions: [{ id: 1, question: "go?", options: [], resolveCommand: "dome resolve 1" }],
        hero: null,
      }),
    );
    expect(vm.totalOpen).toBe(5); // counts 4 + 0 + 1
  });

  test("partitions only backlog rows at the 30-day boundary into aged backlog", () => {
    const vm = buildTodayViewModel(parseTodayView({
      date: "2026-07-01",
      openTasks: [
        { text: "backlog 29", path: "p", line: 1, source: "backlog", dueDate: "2026-06-02" },
        { text: "backlog 30", path: "p", line: 2, source: "backlog", dueDate: "2026-06-01" },
        { text: "daily 60", path: "d", line: 3, source: "daily", dueDate: "2026-05-02" },
      ],
      followups: [],
      questions: [],
      counts: { openTasks: 3, followups: 0, questions: 0 },
      brief: null,
      calendar: null,
      hero: null,
    }));

    expect(vm.agedBacklog.map((task) => task.text)).toEqual(["backlog 30"]);
    expect(vm.stillOpen.overdue.map((task) => task.text)).toEqual(["backlog 29", "daily 60"]);
    expect(vm.totalOpen).toBe(3);
  });

  test("partitions every loaded row exactly once and reports count-only omissions separately", () => {
    const daily = Array.from({ length: 12 }, (_, index) => ({
      text: `daily ${index}`,
      path: "wiki/dailies/2026-07-01.md",
      line: index + 1,
      source: "daily",
      dueDate: "2026-05-01",
    }));
    const backlog = Array.from({ length: 12 }, (_, index) => ({
      text: `backlog ${index}`,
      path: "wiki/tasks.md",
      line: index + 1,
      source: "backlog",
      dueDate: "2026-05-01",
    }));
    const vm = buildTodayViewModel(parseTodayView({
      date: "2026-07-01",
      openTasks: [...daily, ...backlog],
      followups: [],
      questions: [],
      counts: { openTasks: 40, followups: 0, questions: 0 },
      brief: null,
      calendar: null,
      hero: null,
    }));

    const ordinaryRows = Object.values(vm.stillOpen).flat();
    expect(ordinaryRows.map((task) => task.text)).toEqual(daily.map((task) => task.text));
    expect(vm.agedBacklog.map((task) => task.text)).toEqual(backlog.map((task) => task.text));
    expect(ordinaryRows.length + vm.agedBacklog.length).toBe(24);
    expect(vm.omittedOpenCount).toBe(16);
    expect(vm.totalOpen).toBe(40);
  });

  test("omitted open count never goes negative when loaded rows exceed stale counts", () => {
    const vm = buildTodayViewModel(parseTodayView({
      date: "2026-07-01",
      openTasks: [
        { text: "one", path: "p", line: 1, source: "daily", dueDate: null },
        { text: "two", path: "p", line: 2, source: "daily", dueDate: null },
      ],
      followups: [],
      questions: [],
      counts: { openTasks: 1, followups: 0, questions: 0 },
    }));
    expect(vm.omittedOpenCount).toBe(0);
  });
});
