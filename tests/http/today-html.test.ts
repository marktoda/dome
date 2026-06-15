// The pure today→HTML cockpit renderer: structured dome.daily.today/v1 data
// in, a self-refreshing escaped HTML page out. No vault, no engine — the
// renderer is a pure function, so these tests are plain string assertions.

import { describe, expect, test } from "bun:test";

import { renderTodayHtml } from "../../src/http/today-html";

// A minimal SourceRef for fixtures.
const ref = { path: "wiki/dailies/2026-06-14.md", lines: null, commit: "abc" };

// Question fixture with options for Task 3 interactive tests.
const questionFixture = {
  id: 42,
  question: "Should we proceed with option A?",
  resolveCommand: "dome resolve 42 yes",
  path: "wiki/dailies/2026-06-14.md",
  line: 20,
  source: "daily",
  automationPolicy: "owner-needed",
  options: ["yes", "no"],
  metadata: null,
  lastChangedAt: null,
  evidenceLabel: "wiki/dailies/2026-06-14.md:20",
  sourceRefs: [],
};

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
  test("renders sections and escapes HTML", () => {
    const html = renderTodayHtml(DATA, { refreshSeconds: 15 });
    expect(html).toContain("ship &lt;the&gt; cockpit");      // escaped
    expect(html).toContain("2026-06-11");
    expect(html).toContain("Merge A into B?");
    expect(html).toContain("dome resolve 7 yes");
    expect(html).not.toContain("<the>");                      // no raw injection
  });

  test("floors refreshSeconds at 1 and truncates fractions (poll interval in JS)", () => {
    // refreshSeconds is now wired into the inline JS poll interval, not meta refresh
    expect(renderTodayHtml(DATA, { refreshSeconds: 0 })).toContain("1000");   // 1s * 1000ms
    expect(renderTodayHtml(DATA, { refreshSeconds: 2.9 })).toContain("2000"); // 2s * 1000ms
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
      { ...base, brief: null, calendar: null, hero: null, openTasks: [], followups: [], questions: [],
        counts: { openTasks: 0, followups: 0, questions: 0 } },
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

  // ── Task 3: JS polling + interactivity ─────────────────────────────────

  test("page ships JS that polls /tasks and reads the token from the query", () => {
    const html = renderTodayHtml(base, { refreshSeconds: 15 });
    expect(html).toContain("/tasks");
    expect(html).toMatch(/Authorization[^\n]*Bearer/);
    expect(html).toContain("location.search");
  });

  test("questions wire to /resolve and there is a capture control posting to /capture", () => {
    const html = renderTodayHtml({ ...base, questions: [questionFixture] }, { refreshSeconds: 15 });
    expect(html).toContain("/resolve");
    expect(html).toContain("/capture");
  });

  test("the meta-refresh is removed in favor of JS polling", () => {
    const html = renderTodayHtml(base, { refreshSeconds: 15 });
    expect(html).not.toContain('http-equiv="refresh"');
  });
});

describe("wikilink stripping (web cockpit)", () => {
  test("still-open task text strips [[wikilinks]] (path → last segment, alias kept)", () => {
    const html = renderTodayHtml(
      { ...base, openTasks: [{ ...base.openTasks[0], text: "Talk to Eric [[wiki/entities/eric-sanchirico]] about [[wiki/x|the lane]]" }] },
      { refreshSeconds: 15 },
    );
    expect(html).toContain("Talk to Eric eric-sanchirico about the lane");
    expect(html).not.toContain("[[");
  });
  test("hero task text strips [[wikilinks]]", () => {
    const html = renderTodayHtml(
      { ...base, hero: { kind: "task", item: { ...taskFixture, text: "Decide [[wiki/routing-decision|the routing call]]" } } },
      { refreshSeconds: 15 },
    );
    expect(html).toContain("Decide the routing call");
    expect(html).not.toContain("[[");
  });
  test("question text strips [[wikilinks]]", () => {
    const html = renderTodayHtml(
      { ...base, questions: [{ ...base.questions[0], question: "Block on [[wiki/x|K-budget]]?" }] },
      { refreshSeconds: 15 },
    );
    expect(html).toContain("Block on K-budget?");
    expect(html).not.toContain("[[");
  });
});

describe("dome today: web still-open true totals", () => {
  test("web still-open shows the true total + a +N more affordance", () => {
    const html = renderTodayHtml(
      {
        ...base,
        openTasks: Array.from({ length: 6 }, (_, i) => ({ text: `t${i}`, path: "p", line: i, dueDate: null })),
        followups: [],
        questions: [],
        counts: { openTasks: 50, followups: 0, questions: 0 },
        hero: null,
      },
      { refreshSeconds: 15 },
    );
    // The still-open-count span should show the true count (50), not the list length (6)
    expect(html).toMatch(/class="still-open-count"[^>]*>\s*50\s*</);
    // An overflow affordance (+ N more, later) should be present in the still-open section
    // The chip renders as <span>+</span><span>N more, later</span> — no leading + in label text
    expect(html).toMatch(/\d+ more, later/);
  });
});

describe("dome today: still-open urgency grouping", () => {
  test("still-open groups by urgency with a far-future collapse chip", () => {
    const mk = (t: string, due: string | null) => ({ text: t, path: "p", line: 1, dueDate: due });
    const html = renderTodayHtml({ ...base, date: "2026-06-14",
      openTasks: [mk("overdue one","2026-06-01"), mk("due-today one","2026-06-14"), mk("this-week one","2026-06-18"), mk("far one","2026-09-01"), mk("undated one", null)],
      followups: [], questions: [],
      counts: { openTasks: 5, followups: 0, questions: 0 }, hero: null }, { refreshSeconds: 15 });
    expect(html).toMatch(/overdue/i);
    expect(html).toMatch(/today/i);
    expect(html).toMatch(/this week/i);
    expect(html).toContain("overdue one");
    expect(html).toContain("due-today one");
    expect(html).toContain("this-week one");
    // far-future + undated collapse into a "+N more, later" chip rather than listed inline
    expect(html).toMatch(/more, later|later this month/i);
    // chip must not render double-plus (e.g. "+ +2 more, later")
    expect(html).not.toContain("+ +");
    // chip renders as "+ N more, later" (icon span + count, no leading + in label)
    expect(html).toMatch(/<span>\+<\/span><span>\d+ more, later<\/span>/);
  });
  test("all overdue → only the overdue group, no empty today/this-week headers", () => {
    const mk = (t: string, due: string) => ({ text: t, path: "p", line: 1, dueDate: due });
    const html = renderTodayHtml({ ...base, date: "2026-06-14",
      openTasks: [mk("a","2026-06-01"), mk("b","2026-06-02")], followups: [], questions: [],
      counts: { openTasks: 2, followups: 0, questions: 0 }, hero: null }, { refreshSeconds: 15 });
    expect(html).toMatch(/overdue/i);
    expect(html).not.toMatch(/this week/i); // empty buckets omitted
  });
});

describe("Basel Grotesk fonts + hero polish", () => {
  test("page embeds Basel Grotesk @font-face (base64 woff2, both weights)", () => {
    const html = renderTodayHtml(base, { refreshSeconds: 15 });
    expect(html).toContain('@font-face');
    expect(html).toContain('font-family: "Basel Grotesk"');
    expect(html).toContain("data:font/woff2;base64,");
    expect(html).toContain("font-weight: 485");
    expect(html).toContain("font-weight: 535");
    // body uses Basel first
    expect(html).toMatch(/font-family:\s*"Basel Grotesk",\s*-apple-system/);
  });
  test("hero task is not duplicated in the Still open list", () => {
    const t0 = base.openTasks[0]!;
    const heroTask = { ...t0, text: "The hero task", path: "wiki/t.md", line: 9 };
    const html = renderTodayHtml(
      { ...base,
        openTasks: [heroTask, { ...t0, text: "Another open task", path: "wiki/t.md", line: 10 }],
        hero: { kind: "task", item: { text: "The hero task", path: "wiki/t.md", line: 9, dueDate: t0.dueDate } },
      },
      { refreshSeconds: 15 },
    );
    expect((html.match(/The hero task/g) || []).length).toBe(1); // only the pill
    expect(html).toContain("Another open task");
  });
  test("a very long hero text is clamped with an ellipsis", () => {
    const long = "x".repeat(200);
    const html = renderTodayHtml(
      { ...base, hero: { kind: "task", item: { text: long, path: "p", line: 1, dueDate: null } } },
      { refreshSeconds: 15 },
    );
    expect(html).not.toContain(long);
    expect(html).toContain("…");
  });
});
