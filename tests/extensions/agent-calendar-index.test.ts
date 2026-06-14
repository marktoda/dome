// dome.agent.calendar-index — adoption extractor that parses the
// sources/calendar/<date>.md file and emits one dome.agent.calendar.event
// fact per event. CB-T7: calendar-index extractor.

import { describe, expect, test } from "bun:test";

import calendarIndex from "../../assets/extensions/dome.agent/processors/calendar-index";
import type { Effect, FactEffect } from "../../src/core/effect";
import { treeOid, type Snapshot } from "../../src/core/processor";
import { makeManualProposal } from "../../src/core/proposal";
import { commitOid } from "../../src/core/source-ref";
import { makeProcessorContext } from "../../src/processors/context";

const HEAD_COMMIT = commitOid("abcdef1234567890abcdef1234567890abcdef12");

function run(opts: {
  readonly files: Readonly<Record<string, string>>;
  readonly changedPaths?: ReadonlyArray<string>;
}): Promise<ReadonlyArray<Effect>> {
  const files = opts.files;
  const changedPaths = opts.changedPaths ?? Object.keys(files);
  const snapshot: Snapshot = Object.freeze({
    commit: HEAD_COMMIT,
    tree: treeOid("1111111111111111111111111111111111111111"),
    readFile: async (path: string) => files[path] ?? null,
    listMarkdownFiles: async () => Object.freeze(Object.keys(files)),
    getFileInfo: async () => null,
  });
  const ctx = makeProcessorContext({
    snapshot,
    changedPaths: Object.freeze([...changedPaths]),
    proposal: makeManualProposal({
      base: HEAD_COMMIT,
      head: HEAD_COMMIT,
      branch: "main",
    }),
    runId: "run-calendar-index-test",
    signal: new AbortController().signal,
    input: { kind: "adoption", matchedTriggers: [] },
  });
  return calendarIndex.run(ctx as never);
}

const CALENDAR_PATH = "sources/calendar/2026-06-14.md";

/** Two-event calendar file matching the vault-layout shape the parser expects. */
const TWO_EVENT_CONTENT = [
  "# Calendar 2026-06-14",
  "",
  "- 09:00–09:30 - Standup (attendees: Alice, Bob)",
  "- 14:00 - Product review",
].join("\n");

/** Single event, no attendees, no time range. */
const SINGLE_EVENT_NO_ATTENDEES = [
  "# Calendar 2026-06-14",
  "",
  "- 10:00 - Weekly sync",
].join("\n");

/** Partially malformed: first item has an empty title after stripping, second is valid. */
const PARTIALLY_MALFORMED = [
  "# Calendar 2026-06-14",
  "",
  "- (attendees: X)",
  "- 11:00 - Good meeting",
].join("\n");

describe("dome.agent.calendar-index", () => {
  test("emits two dome.agent.calendar.event facts for a two-event file", async () => {
    const effects = await run({
      files: { [CALENDAR_PATH]: TWO_EVENT_CONTENT },
    });
    const facts = effects.filter((e): e is FactEffect => e.kind === "fact");
    expect(facts).toHaveLength(2);

    for (const fact of facts) {
      expect(fact.predicate).toBe("dome.agent.calendar.event");
      expect(fact.assertion).toBe("extracted");
      expect(fact.subject.kind).toBe("page");
      expect(
        fact.subject.kind === "page" && String(fact.subject.path),
      ).toBe(CALENDAR_PATH);
      expect(fact.sourceRefs).toHaveLength(1);
      expect(String(fact.sourceRefs[0]?.path)).toBe(CALENDAR_PATH);
    }

    // Check tab-delimited encoding: time \t title \t meta
    const values = facts.map((f) => {
      expect(f.object.kind).toBe("string");
      return f.object.kind === "string" ? f.object.value : "";
    });

    // First event: 09:00–09:30, title "Standup", attendees "Alice, Bob"
    const first = values.find((v) => v.startsWith("09:00"));
    expect(first).toBeDefined();
    const [time1, title1, meta1] = (first ?? "").split("\t");
    expect(time1).toBe("09:00–09:30");
    expect(title1).toBe("Standup");
    expect(meta1).toBe("Alice, Bob");

    // Second event: 14:00, title "Product review", no attendees
    const second = values.find((v) => v.startsWith("14:00"));
    expect(second).toBeDefined();
    const [time2, title2, meta2] = (second ?? "").split("\t");
    expect(time2).toBe("14:00");
    expect(title2).toBe("Product review");
    expect(meta2).toBe("");
  });

  test("emits nothing when no calendar path is in changedPaths", async () => {
    const effects = await run({
      files: { [CALENDAR_PATH]: TWO_EVENT_CONTENT },
      changedPaths: ["wiki/dailies/2026-06-14.md"],
    });
    const facts = effects.filter((e): e is FactEffect => e.kind === "fact");
    expect(facts).toHaveLength(0);
  });

  test("emits nothing when the calendar file is absent (readFile returns null)", async () => {
    const effects = await run({
      files: {},
      changedPaths: [CALENDAR_PATH],
    });
    const facts = effects.filter((e): e is FactEffect => e.kind === "fact");
    expect(facts).toHaveLength(0);
  });

  test("emits one fact for a single-event file with no attendees, meta is empty string", async () => {
    const effects = await run({
      files: { [CALENDAR_PATH]: SINGLE_EVENT_NO_ATTENDEES },
    });
    const facts = effects.filter((e): e is FactEffect => e.kind === "fact");
    expect(facts).toHaveLength(1);
    const [time, title, meta] = (
      facts[0]?.object.kind === "string" ? facts[0].object.value : ""
    ).split("\t");
    expect(time).toBe("10:00");
    expect(title).toBe("Weekly sync");
    expect(meta).toBe("");
  });

  test("is defensive: emits only parseable events from a partially malformed file", async () => {
    const effects = await run({
      files: { [CALENDAR_PATH]: PARTIALLY_MALFORMED },
    });
    const facts = effects.filter((e): e is FactEffect => e.kind === "fact");
    // The first item has no title after stripping attendees — parser returns null for it.
    // The second item is valid.
    expect(facts).toHaveLength(1);
    const [time, title] = (
      facts[0]?.object.kind === "string" ? facts[0].object.value : ""
    ).split("\t");
    expect(time).toBe("11:00");
    expect(title).toBe("Good meeting");
  });

  test("null time encodes as empty string in the first tab field", async () => {
    const noTimeContent = [
      "# Calendar 2026-06-14",
      "",
      "- All-hands kickoff",
    ].join("\n");
    const effects = await run({
      files: { [CALENDAR_PATH]: noTimeContent },
    });
    const facts = effects.filter((e): e is FactEffect => e.kind === "fact");
    expect(facts).toHaveLength(1);
    const [time, title, meta] = (
      facts[0]?.object.kind === "string" ? facts[0].object.value : ""
    ).split("\t");
    expect(time).toBe("");
    expect(title).toBe("All-hands kickoff");
    expect(meta).toBe("");
  });

  test("tab in title or attendee name is collapsed to a single space", async () => {
    // A title with an embedded tab and an attendee name with an embedded tab
    // must not break the 3-field tab-split the today view (CB-T8) relies on.
    // The content is constructed so the tab survives the line-split parse.
    const titleWithTab = "Budget\treview";
    const attendeeWithTab = "Alice\tBob";
    const dirtyLine = `- 13:00 - ${titleWithTab} (attendees: ${attendeeWithTab}, Carol)`;
    const dirtyContent = ["# Calendar 2026-06-14", "", dirtyLine].join("\n");
    const effects = await run({
      files: { [CALENDAR_PATH]: dirtyContent },
    });
    const facts = effects.filter((e): e is FactEffect => e.kind === "fact");
    expect(facts).toHaveLength(1);
    const value =
      facts[0]?.object.kind === "string" ? facts[0].object.value : "";

    // Exactly two tab delimiters — never more.
    const tabCount = (value.match(/\t/g) ?? []).length;
    expect(tabCount).toBe(2);

    const [time, title, meta] = value.split("\t");
    expect(time).toBe("13:00");
    // Tab in title collapsed to single space
    expect(title).toBe("Budget review");
    // Tab in attendee name collapsed to single space
    expect(meta).toBe("Alice Bob, Carol");
  });

  test("ignores non-calendar paths even when present in changedPaths", async () => {
    const effects = await run({
      files: {
        [CALENDAR_PATH]: TWO_EVENT_CONTENT,
        "wiki/dailies/2026-06-14.md": "# Daily\n",
        "sources/slack/2026-06-14.md": "# Slack\n",
      },
      changedPaths: [
        CALENDAR_PATH,
        "wiki/dailies/2026-06-14.md",
        "sources/slack/2026-06-14.md",
      ],
    });
    const facts = effects.filter((e): e is FactEffect => e.kind === "fact");
    // Only the calendar path produces facts
    expect(facts).toHaveLength(2);
    for (const fact of facts) {
      expect(
        fact.subject.kind === "page" && String(fact.subject.path),
      ).toBe(CALENDAR_PATH);
    }
  });
});
