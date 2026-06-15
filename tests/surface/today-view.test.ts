import { expect, test } from "bun:test";
import { parseTodayView, addDays } from "../../src/surface/today-view";

test("parses tasks with wikilinks stripped + dueDate", () => {
  const v = parseTodayView({ date: "2026-06-14",
    openTasks: [{ text: "talk to [[wiki/x|Eric]]", path: "p", line: 1, dueDate: "2026-06-10" }],
    followups: [], questions: [], counts: { openTasks: 1, followups: 0, questions: 0 }, brief: null, calendar: null, hero: null });
  expect(v.openTasks[0]!.text).toBe("talk to Eric");
  expect(v.openTasks[0]!.dueDate).toBe("2026-06-10");
});

test("parses question options + resolveCommand", () => {
  const v = parseTodayView({ date: "x", openTasks: [], followups: [],
    questions: [{ id: 7, question: "go?", options: ["yes","no"], resolveCommand: "dome resolve 7" }],
    counts: { openTasks: 0, followups: 0, questions: 1 }, brief: null, calendar: null, hero: null });
  expect(v.questions[0]!.options).toEqual(["yes","no"]);
  expect(v.questions[0]!.id).toBe(7);
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
  expect(v.hero).toEqual({ kind: "task", item: { text: "do the thing", path: "p", line: 1, dueDate: null } });
});
