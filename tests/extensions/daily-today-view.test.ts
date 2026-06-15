// dome.daily.today — unit tests for brief + calendar assembly from projection facts.
// CB-T8: verifies that the today view wires dome.agent.brief and
// dome.agent.calendar.event facts into the doc's brief/calendar fields instead
// of hardcoding null.
//
// Pattern: fake ProjectionQueryView with seeded FactEffects, run the today
// processor, inspect the structured ViewEffect's data. Mirrors the approach in
// tests/extensions/dome.agent/brief.test.ts (staleProjection helper).

import { describe, expect, test } from "bun:test";

import today from "../../assets/extensions/dome.daily/processors/today";
import { OPEN_TASK_PREDICATE } from "../../assets/extensions/dome.daily/processors/action-state";
import type { FactEffect, ViewEffect } from "../../src/core/effect";
import { treeOid, type ProjectionQueryView, type Snapshot } from "../../src/core/processor";
import { makeManualProposal } from "../../src/core/proposal";
import { commitOid } from "../../src/core/source-ref";
import { makeProcessorContext } from "../../src/processors/context";
import { parseTodayView } from "../../src/surface/today-view";

// ---------------------------------------------------------------------------
// Fixed date anchor — 2026-06-14, which is also the date used across the
// other cockpit-briefing tests. The daily note path is derived from this.
// ---------------------------------------------------------------------------

const HEAD_COMMIT = commitOid("abcdef1234567890abcdef1234567890abcdef12");
const NOW = new Date(2026, 5, 14, 9, 0, 0); // 2026-06-14 local time
const DAILY_PATH = "wiki/dailies/2026-06-14.md";
const CALENDAR_PATH = "sources/calendar/2026-06-14.md";

// Minimal daily note so collectDailyActionState does not bail early.
const MINIMAL_DAILY = "---\ntype: daily\n---\n\n# 2026-06-14\n";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFact(opts: {
  predicate: string;
  subjectPath: string;
  value: string;
}): FactEffect {
  return {
    kind: "fact",
    subject: { kind: "page", path: opts.subjectPath as never },
    predicate: opts.predicate,
    object: { kind: "string", value: opts.value },
    assertion: "extracted",
    sourceRefs: [{ commit: HEAD_COMMIT, path: opts.subjectPath as never }],
  };
}

function makeProjection(facts: ReadonlyArray<FactEffect>): ProjectionQueryView {
  return {
    facts: (filter?: { readonly predicate?: string }) =>
      facts.filter(
        (f) =>
          filter?.predicate === undefined || f.predicate === filter.predicate,
      ),
    diagnostics: () => [],
    questions: () => [],
    searchDocuments: () => [],
    documentsByPath: () => [],
  } as unknown as ProjectionQueryView;
}

function makeSnapshot(
  files: Readonly<Record<string, string>>,
): Snapshot {
  return Object.freeze({
    commit: HEAD_COMMIT,
    tree: treeOid("1111111111111111111111111111111111111111"),
    readFile: async (path: string) => files[path] ?? null,
    listMarkdownFiles: async () => Object.freeze(Object.keys(files)),
    getFileInfo: async () => null,
  });
}

async function runTodayRaw(opts: {
  files: Readonly<Record<string, string>>;
  facts: ReadonlyArray<FactEffect>;
}): Promise<Record<string, unknown>> {
  const ctx = makeProcessorContext({
    snapshot: makeSnapshot(opts.files),
    changedPaths: Object.freeze([]),
    proposal: makeManualProposal({
      base: HEAD_COMMIT,
      head: HEAD_COMMIT,
      branch: "main",
    }),
    runId: "run-today-view-test",
    now: NOW,
    signal: new AbortController().signal,
    input: { kind: "command", commandArgs: { date: "2026-06-14" } },
    projection: makeProjection(opts.facts),
  });
  const effects = await today.run(ctx as never);
  const view = effects.find((e): e is ViewEffect => e.kind === "view");
  if (view === undefined) throw new Error("no view effect emitted");
  if (view.content.kind !== "structured") throw new Error("not a structured view");
  return view.content.data as Record<string, unknown>;
}

async function runToday(opts: {
  files: Readonly<Record<string, string>>;
  facts: ReadonlyArray<FactEffect>;
}): Promise<{ readonly brief: unknown; readonly calendar: unknown }> {
  const data = await runTodayRaw(opts);
  return { brief: data["brief"] ?? null, calendar: data["calendar"] ?? null };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dome.daily.today — brief assembly from dome.agent.brief fact", () => {
  test("today doc assembles brief from the dome.agent.brief fact for today's daily path", async () => {
    const { brief } = await runToday({
      files: { [DAILY_PATH]: MINIMAL_DAILY },
      facts: [
        makeFact({
          predicate: "dome.agent.brief",
          subjectPath: DAILY_PATH,
          value: "Today is about X.",
        }),
      ],
    });
    expect(brief).not.toBeNull();
    const b = brief as { text: string; sourceRef: { path: string } };
    expect(b.text).toBe("Today is about X.");
    expect(b.sourceRef.path).toBe(DAILY_PATH);
  });

  test("brief is null when no dome.agent.brief fact is present", async () => {
    const { brief } = await runToday({
      files: { [DAILY_PATH]: MINIMAL_DAILY },
      facts: [],
    });
    expect(brief).toBeNull();
  });

  test("brief is null when the dome.agent.brief fact is for a different daily path", async () => {
    const { brief } = await runToday({
      files: { [DAILY_PATH]: MINIMAL_DAILY },
      facts: [
        makeFact({
          predicate: "dome.agent.brief",
          subjectPath: "wiki/dailies/2026-06-13.md",
          value: "Yesterday's brief.",
        }),
      ],
    });
    expect(brief).toBeNull();
  });
});

describe("dome.daily.today — calendar assembly from dome.agent.calendar.event facts", () => {
  test("today doc assembles calendar events from dome.agent.calendar.event facts", async () => {
    const { calendar } = await runToday({
      files: { [DAILY_PATH]: MINIMAL_DAILY },
      facts: [
        makeFact({
          predicate: "dome.agent.calendar.event",
          subjectPath: CALENDAR_PATH,
          value: "11:00\tPre-read\tfocus",
        }),
        makeFact({
          predicate: "dome.agent.calendar.event",
          subjectPath: CALENDAR_PATH,
          value: "14:30\tSync\tEric, Siyu",
        }),
      ],
    });
    expect(calendar).not.toBeNull();
    const c = calendar as {
      events: ReadonlyArray<{ time: string; title: string; meta: string | null }>;
      sourceRef: { path: string };
    };
    expect(c.events).toEqual([
      { time: "11:00", title: "Pre-read", meta: "focus" },
      { time: "14:30", title: "Sync", meta: "Eric, Siyu" },
    ]);
    // sourceRef cites the calendar file
    expect(c.sourceRef.path).toBe(CALENDAR_PATH);
  });

  test("calendar events are sorted by time field", async () => {
    const { calendar } = await runToday({
      files: { [DAILY_PATH]: MINIMAL_DAILY },
      facts: [
        makeFact({
          predicate: "dome.agent.calendar.event",
          subjectPath: CALENDAR_PATH,
          value: "15:00\tLate meeting\t",
        }),
        makeFact({
          predicate: "dome.agent.calendar.event",
          subjectPath: CALENDAR_PATH,
          value: "09:00\tStandup\t",
        }),
      ],
    });
    const c = calendar as {
      events: ReadonlyArray<{ time: string; title: string }>;
    };
    expect(c.events[0]?.time).toBe("09:00");
    expect(c.events[1]?.time).toBe("15:00");
  });

  test("calendar event with empty meta field decodes to empty string (not null)", async () => {
    const { calendar } = await runToday({
      files: { [DAILY_PATH]: MINIMAL_DAILY },
      facts: [
        makeFact({
          predicate: "dome.agent.calendar.event",
          subjectPath: CALENDAR_PATH,
          value: "10:00\tWeekly sync\t",
        }),
      ],
    });
    const c = calendar as {
      events: ReadonlyArray<{ meta: string | null }>;
    };
    // Empty meta: the extractor encodes it as empty string; the view preserves it
    expect(c.events[0]?.meta).toBe("");
  });

  test("calendar event with malformed value (not exactly 2 tabs) is skipped", async () => {
    const { calendar } = await runToday({
      files: { [DAILY_PATH]: MINIMAL_DAILY },
      facts: [
        makeFact({
          predicate: "dome.agent.calendar.event",
          subjectPath: CALENDAR_PATH,
          value: "malformed-no-tabs",
        }),
        makeFact({
          predicate: "dome.agent.calendar.event",
          subjectPath: CALENDAR_PATH,
          value: "09:00\tGood meeting\tattendees",
        }),
      ],
    });
    const c = calendar as {
      events: ReadonlyArray<{ title: string }>;
    };
    // The malformed one is skipped; only the well-formed event survives
    expect(c.events).toHaveLength(1);
    expect(c.events[0]?.title).toBe("Good meeting");
  });

  test("calendar is null when no dome.agent.calendar.event facts are present", async () => {
    const { calendar } = await runToday({
      files: { [DAILY_PATH]: MINIMAL_DAILY },
      facts: [],
    });
    expect(calendar).toBeNull();
  });

  test("calendar is null when facts are for a different date's calendar path", async () => {
    const { calendar } = await runToday({
      files: { [DAILY_PATH]: MINIMAL_DAILY },
      facts: [
        makeFact({
          predicate: "dome.agent.calendar.event",
          subjectPath: "sources/calendar/2026-06-13.md",
          value: "09:00\tYesterday meeting\tattendees",
        }),
      ],
    });
    expect(calendar).toBeNull();
  });
});

describe("dome.daily.today — brief and calendar are null when no facts present", () => {
  test("brief and calendar are null when no facts present", async () => {
    const { brief, calendar } = await runToday({
      files: { [DAILY_PATH]: MINIMAL_DAILY },
      facts: [],
    });
    expect(brief).toBeNull();
    expect(calendar).toBeNull();
  });

  test("both brief and calendar assemble simultaneously from different fact sources", async () => {
    const { brief, calendar } = await runToday({
      files: { [DAILY_PATH]: MINIMAL_DAILY },
      facts: [
        makeFact({
          predicate: "dome.agent.brief",
          subjectPath: DAILY_PATH,
          value: "A good day ahead.",
        }),
        makeFact({
          predicate: "dome.agent.calendar.event",
          subjectPath: CALENDAR_PATH,
          value: "10:00\tTeam sync\t",
        }),
      ],
    });
    expect(brief).not.toBeNull();
    expect(calendar).not.toBeNull();
    const b = brief as { text: string };
    const c = calendar as { events: ReadonlyArray<unknown> };
    expect(b.text).toBe("A good day ahead.");
    expect(c.events).toHaveLength(1);
  });
});

describe("dome.daily.today — task origin propagation", () => {
  test("today view exposes a task's origin target", async () => {
    // Seed a dome.daily.open_task fact whose value carries the origin marker,
    // as task-index.ts will emit after Step 3.  The fact value is:
    //   "reply to Jane ([↗](https://slk/p1))"
    // which is what appendOriginMarker("reply to Jane", "https://slk/p1") produces.
    const data = await runTodayRaw({
      files: { [DAILY_PATH]: MINIMAL_DAILY },
      facts: [
        makeFact({
          predicate: OPEN_TASK_PREDICATE,
          subjectPath: DAILY_PATH,
          value: "reply to Jane ([↗](https://slk/p1))",
        }),
      ],
    });
    const view = parseTodayView(data);
    const row = view.openTasks.find((t) => t.text.includes("reply to Jane"))!;
    expect(row).toBeDefined();
    expect(row.origin).toBe("https://slk/p1");
  });

  test("dedup rescues origin: carried-forward open-loop + backlog fact keep origin after merge", async () => {
    // This test targets the mergeDailyTaskItems dedup path.
    //
    // Scenario:
    //   - The daily note's open-loops block carries a source-backed copy of a
    //     task that originally lived in sources/projects/work.md:
    //       "- [ ] review PR ([↗](https://slk/pr42)) (from [[sources/projects/work]])"
    //     sourceBackedCheckboxFromLine strips the origin marker from the body,
    //     so the parsed daily-surface item has text "review PR" and NO origin.
    //
    //   - A dome.daily.open_task fact for sources/projects/work.md carries the
    //     raw value "review PR ([↗](https://slk/pr42))", so taskItemFromFact
    //     sets origin = "https://slk/pr42".
    //
    //   - Both items have the same taskSurfaceKey ("review PR"), so
    //     dedupeDailyTaskItems calls mergeDailyTaskItems.  Without the fix the
    //     daily-surface item wins as primary and origin is silently dropped.
    //     With the fix, origin is rescued from the duplicate (the fact item).
    const SOURCE_PATH = "sources/projects/work.md";
    const OPEN_LOOP_BODY = "review PR ([↗](https://slk/pr42))";
    const ORIGIN_URL = "https://slk/pr42";

    // Daily note with an open-loops generated block containing the source-backed
    // carried-forward copy. The origin marker is kept in the raw line so the
    // regex in sourceBackedCheckboxFromLine parses rawBody including it (then
    // strips it), reproducing what carry-forward actually writes.
    const dailyWithOpenLoop = [
      "---",
      "type: daily",
      "---",
      "",
      "# 2026-06-14",
      "",
      "<!-- dome.daily:open-loops:start -->",
      `- [ ] ${OPEN_LOOP_BODY} (from [[sources/projects/work]])`,
      "<!-- dome.daily:open-loops:end -->",
    ].join("\n");

    const data = await runTodayRaw({
      files: {
        [DAILY_PATH]: dailyWithOpenLoop,
        [SOURCE_PATH]: `- [ ] ${OPEN_LOOP_BODY}\n`,
      },
      facts: [
        makeFact({
          predicate: OPEN_TASK_PREDICATE,
          subjectPath: SOURCE_PATH,
          value: OPEN_LOOP_BODY,
        }),
      ],
    });

    const view = parseTodayView(data);
    // After dedup, exactly one row for "review PR" should survive.
    const rows = view.openTasks.filter((t) => t.text.includes("review PR"));
    expect(rows).toHaveLength(1);
    // That row must carry the rescued origin URL.
    expect(rows[0]!.origin).toBe(ORIGIN_URL);
  });
});
