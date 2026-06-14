// The pure today→HTML cockpit renderer: structured dome.daily.today/v1 data
// in, a self-refreshing escaped HTML page out. No vault, no engine — the
// renderer is a pure function, so these tests are plain string assertions.

import { describe, expect, test } from "bun:test";

import { renderTodayHtml } from "../../src/http/today-html";

// A minimal SourceRef for fixtures.
const ref = { path: "wiki/dailies/2026-06-14.md", lines: null, commit: "abc" };

// A minimal task item that satisfies hero.item shape.
const taskFixture = {
  text: "Make the routing decision",
  path: "wiki/dailies/2026-06-14.md",
  line: 5,
  dueDate: "2026-06-10",
  followup: false,
  source: "daily",
  priority: null,
  lastChangedAt: null,
  attention: null,
  evidenceLabel: "wiki/dailies/2026-06-14.md:5",
  sourceRefs: [],
};

// Base fixture that the new tests spread from.
const base = {
  schema: "dome.daily.today/v1",
  date: "2026-06-14",
  counts: { openTasks: 1, followups: 0, questions: 1 },
  dueCounts: {
    openTasks: { overdue: 0, today: 1, upcoming: 0, undated: 0 },
    followups: { overdue: 0, today: 0, upcoming: 0, undated: 0 },
  },
  openTasks: [
    { text: "ship <the> cockpit", path: "wiki/dailies/2026-06-14.md", line: 5, dueDate: "2026-06-14", followup: false, source: "daily", priority: null, lastChangedAt: null, attention: null, evidenceLabel: "wiki/dailies/2026-06-14.md:5", sourceRefs: [] },
  ],
  followups: [],
  questions: [
    { id: 7, question: "Merge A into B?", resolveCommand: "dome resolve 7 yes", path: "wiki/dailies/2026-06-14.md", line: 12, source: "daily", automationPolicy: "owner-needed", options: ["yes", "no"], metadata: null, lastChangedAt: null, evidenceLabel: "wiki/dailies/2026-06-14.md:12", sourceRefs: [] },
  ],
  brief: null,
  calendar: null,
  hero: null,
};

// Legacy DATA shape (kept for existing tests).
const DATA = {
  schema: "dome.daily.today/v1",
  date: "2026-06-11",
  counts: { openTasks: 1, followups: 0, questions: 1 },
  openTasks: [
    { text: "ship <the> cockpit", path: "wiki/dailies/2026-06-11.md", line: 5, dueDate: null, followup: false },
  ],
  followups: [],
  questions: [
    { id: 7, question: "Merge A into B?", resolveCommand: "dome resolve 7 yes" },
  ],
};

describe("renderTodayHtml", () => {
  test("renders sections, escapes HTML, includes meta refresh", () => {
    const html = renderTodayHtml(DATA, { refreshSeconds: 15 });
    expect(html).toContain('<meta http-equiv="refresh" content="15">');
    expect(html).toContain("ship &lt;the&gt; cockpit");      // escaped
    expect(html).toContain("2026-06-11");
    expect(html).toContain("Merge A into B?");
    expect(html).toContain("dome resolve 7 yes");
    expect(html).not.toContain("<the>");                      // no raw injection
  });

  test("floors refreshSeconds at 1 and truncates fractions", () => {
    expect(renderTodayHtml(DATA, { refreshSeconds: 0 })).toContain('content="1"');
    expect(renderTodayHtml(DATA, { refreshSeconds: 2.9 })).toContain('content="2"');
  });

  test("tolerates malformed data with an empty-state page", () => {
    const html = renderTodayHtml(null, { refreshSeconds: 15 });
    // Briefing visual uses "You're clear." for the all-clear state.
    expect(html).toContain("You&#39;re clear");
  });

  // ── Briefing visual tests (Task 2) ──────────────────────────────────────

  test("renders brief + provenance when present", () => {
    const html = renderTodayHtml(
      { ...base, brief: { text: "Today is about X.", sourceRef: { path: "wiki/dailies/2026-06-14.md", lines: null, commit: "abc" } } },
      { refreshSeconds: 15 },
    );
    expect(html).toContain("Today is about X.");
    expect(html).toContain("· brief");
  });

  test("omits brief/calendar/hero when null and shows all-clear when nothing open", () => {
    const html = renderTodayHtml(
      { ...base, brief: null, calendar: null, hero: null, openTasks: [], followups: [], questions: [] },
      { refreshSeconds: 15 },
    );
    expect(html).toContain("You&#39;re clear");
  });

  test("renders the hero pill for a task hero", () => {
    const html = renderTodayHtml(
      { ...base, hero: { kind: "task", item: taskFixture } },
      { refreshSeconds: 15 },
    );
    expect(html).toContain("Make the routing decision");
  });

  test("escapes HTML in interpolated content", () => {
    const html = renderTodayHtml(
      { ...base, brief: { text: "<script>x</script>", sourceRef: ref } },
      { refreshSeconds: 15 },
    );
    expect(html).not.toContain("<script>x");
  });

  test("renders calendar events when calendar is present", () => {
    const html = renderTodayHtml(
      {
        ...base,
        calendar: {
          events: [{ time: "11:00", title: "Decision pre-read", meta: "focus block · 1h" }],
          sourceRef: ref,
        },
      },
      { refreshSeconds: 15 },
    );
    expect(html).toContain("On your calendar");
    expect(html).toContain("Decision pre-read");
    expect(html).toContain("11:00");
  });

  test("omits calendar section when calendar is null", () => {
    const html = renderTodayHtml({ ...base, calendar: null }, { refreshSeconds: 15 });
    expect(html).not.toContain("On your calendar");
  });

  test("renders questions section with details/summary", () => {
    const html = renderTodayHtml(base, { refreshSeconds: 15 });
    expect(html).toContain("Dome needs you");
    expect(html).toContain("Merge A into B?");
    expect(html).toContain("dome resolve 7 yes");
  });

  test("renders still-open task list", () => {
    const html = renderTodayHtml(base, { refreshSeconds: 15 });
    expect(html).toContain("Still open");
    expect(html).toContain("ship &lt;the&gt; cockpit");
  });

  test("renders Good morning header and date", () => {
    const html = renderTodayHtml(base, { refreshSeconds: 15 });
    expect(html).toContain("Good morning");
    expect(html).toContain("2026-06-14");
  });

  test("renders meta refresh tag with correct seconds", () => {
    const html = renderTodayHtml(base, { refreshSeconds: 30 });
    expect(html).toContain('<meta http-equiv="refresh" content="30">');
  });
});
