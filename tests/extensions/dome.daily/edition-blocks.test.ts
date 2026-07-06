// dome.daily edition-blocks — unit tests for the deterministic compiled-daily
// block renderers (questions/agenda/integrated/sources) and the generic
// replace-or-insert splice they all share.
//
// Plain-function tests: every renderer here is pure string/data work, no
// ProcessorContext needed. Mirrors the style of
// tests/extensions/dome.agent/brief.test.ts's `integratedBriefSection (pure
// render helper)` describe block.

import { describe, expect, test } from "bun:test";

import type { CalendarMeeting } from "../../../assets/extensions/dome.daily/processors/calendar-day";
import {
  AGENDA_MARKERS,
  INTEGRATED_MARKERS,
  PROPOSALS_MARKERS,
  QUESTIONS_MARKERS,
  SOURCES_MARKERS,
} from "../../../assets/extensions/dome.daily/processors/daily-types";
import {
  agendaSection,
  DEFAULT_QUESTION_AGING_DAYS,
  type EditionProposal,
  type EditionQuestion,
  integratedSection,
  MAX_EDITION_PROPOSALS,
  MAX_EDITION_QUESTIONS,
  partitionQuestionsByAge,
  proposalsSection,
  questionBullet,
  questionsSection,
  replaceEditionBlock,
  sourcesSection,
} from "../../../assets/extensions/dome.daily/processors/edition-blocks";
import type { SweepSettlement } from "../../../assets/extensions/dome.daily/processors/sweep-ledger";

function question(
  overrides: Partial<EditionQuestion> & { readonly id: number },
): EditionQuestion {
  return Object.freeze({
    question: `Question ${overrides.id}`,
    options: [],
    automationPolicy: "owner-needed",
    recommendedAnswer: null,
    askedAt: "2026-06-09T05:00:00.000Z",
    ...overrides,
  });
}

// The aging-escalation fixture instant (Task 10).
const NOW_ISO = "2026-06-09T05:00:00.000Z";

// ----- questionsSection -------------------------------------------------------

describe("questionsSection", () => {
  test("empty input → null", () => {
    expect(questionsSection([])).toBeNull();
  });

  test("happy path: heading, bullet shape, resolve command", () => {
    const section = questionsSection([
      question({
        id: 42,
        question: "Merge `a` <- `b`?",
        recommendedAnswer: "merge",
      }),
    ]);
    expect(section).not.toBeNull();
    expect(section).toContain("### To decide");
    expect(section).toContain(
      "- Q42 (owner-needed): Merge `a` <- `b`? — recommended: merge — resolve: `dome resolve 42 <answer>`",
    );
    expect(section!.trimStart()).toStartWith(QUESTIONS_MARKERS.start);
    expect(section!.trimEnd()).toEndWith(QUESTIONS_MARKERS.end);
  });

  test("omits the recommended clause when recommendedAnswer is null", () => {
    const section = questionsSection([question({ id: 1 })]);
    expect(section).not.toContain("recommended:");
  });

  test("appends options as a bracketed list", () => {
    const section = questionsSection([
      question({ id: 7, options: ["merge", "keep-both"] }),
    ]);
    expect(section).toContain("[merge | keep-both]");
    expect(section).toContain("resolve: `dome resolve 7 <merge|keep-both>`");
  });

  test("plain bullets only — never checkboxes", () => {
    const section = questionsSection([question({ id: 1 })]);
    expect(section).not.toContain("- [ ]");
  });

  test("ordering: owner-needed first, then oldest askedAt within each group", () => {
    const section = questionsSection([
      question({
        id: 1,
        automationPolicy: "agent-safe",
        askedAt: "2026-06-01T00:00:00.000Z",
      }),
      question({
        id: 2,
        automationPolicy: "owner-needed",
        askedAt: "2026-06-05T00:00:00.000Z",
      }),
      question({
        id: 3,
        automationPolicy: "owner-needed",
        askedAt: "2026-06-02T00:00:00.000Z",
      }),
    ]);
    expect(section).not.toBeNull();
    const idOrder = [...section!.matchAll(/Q(\d+)/g)].map((m) => m[1]);
    // Both owner-needed questions (3 then 2, oldest first) precede the
    // agent-safe one (1), even though 1 has the oldest askedAt overall.
    expect(idOrder).toEqual(["3", "2", "1"]);
  });

  test("caps at MAX_EDITION_QUESTIONS with a +N more tail", () => {
    expect(MAX_EDITION_QUESTIONS).toBe(3);
    const questions = [1, 2, 3, 4, 5].map((id) =>
      question({ id, askedAt: `2026-06-0${id}T00:00:00.000Z` }),
    );
    const section = questionsSection(questions);
    expect(section).not.toBeNull();
    const rendered = [...section!.matchAll(/- Q(\d+)/g)];
    expect(rendered).toHaveLength(3);
    expect(section).toContain("+2 more — `dome check`");
  });

  test("no tail line when the count is within the cap", () => {
    const section = questionsSection([question({ id: 1 })]);
    expect(section).not.toContain("more —");
  });

  test("neutralizes wikilink syntax in question text and recommendedAnswer (projection must not re-enter link validation)", () => {
    // The questions block is a projection of durable question rows; quoted
    // vault syntax rendered verbatim would let validate-wikilinks re-flag the
    // quoted link inside the daily and ask a second question about it — the
    // question → render → question feedback loop.
    const section = questionsSection([
      question({
        id: 9,
        question: "Wikilink [[ambiguous]] has multiple targets.",
        options: ["point at [[ProjectA]]", "point at [[ProjectB]]"],
        recommendedAnswer: "keep [[ambiguous]] unresolved",
      }),
    ]);
    expect(section).not.toBeNull();
    expect(section).toContain("Wikilink \\[\\[ambiguous\\]\\] has multiple targets.");
    expect(section).toContain("recommended: keep \\[\\[ambiguous\\]\\] unresolved");
    // Options are projected verbatim too — a future question source with a
    // [[wikilink]] in an option must not re-enter link validation either.
    expect(section).toContain(
      "[point at \\[\\[ProjectA\\]\\] | point at \\[\\[ProjectB\\]\\]]",
    );
    // The re-open vector is the human-readable prefix (question text + options
    // display + recommendation) — rendered as plain markdown the validator
    // scans. It must carry NO raw `[[…]]`. (The trailing `dome resolve` command
    // echoes raw option values, but it sits inside a backtick code span, which
    // findWikilinks ignores via markdownCodeRanges — not a re-open surface.)
    const prefix = section!.split("— resolve:")[0]!;
    expect(prefix).not.toContain("[[ambiguous]]");
    expect(prefix).not.toContain("[[ProjectA]]");
    expect(prefix).not.toContain("[[ProjectB]]");
  });

  // ----- Aging escalation (Task 10) -------------------------------------------

  test("opts absent → behaves exactly as today (all fresh, no aging line)", () => {
    const questions = [1, 2].map((id) =>
      question({ id, askedAt: "2026-05-01T00:00:00.000Z" }), // 39 days old
    );
    const section = questionsSection(questions);
    expect(section).not.toContain("🕰");
    expect(section).not.toContain("aging decision");
  });

  test("an 8-day-old question (default agingDays=7) renders as the aging line, not a bullet", () => {
    const fresh = question({ id: 1, askedAt: "2026-06-08T00:00:00.000Z" }); // 1 day old
    const old = question({ id: 2, askedAt: "2026-06-01T00:00:00.000Z" }); // 8 days old
    const section = questionsSection([fresh, old], { nowIso: NOW_ISO });
    expect(section).not.toBeNull();
    expect(section).toContain("- Q1");
    expect(section).not.toContain("- Q2");
    expect(section).toContain(
      "- 🕰 1 aging decision(s) — weekly review (`dome check --decisions`)",
    );
  });

  test("fresh cap/tail unaffected by aging partition: +N more counts fresh only", () => {
    const fresh = [1, 2, 3, 4].map((id) =>
      question({ id, askedAt: "2026-06-08T00:00:00.000Z" }), // 1 day old, all fresh
    );
    const aging = [5].map((id) =>
      question({ id, askedAt: "2026-06-01T00:00:00.000Z" }), // 8 days old
    );
    const section = questionsSection([...fresh, ...aging], { nowIso: NOW_ISO });
    expect(section).not.toBeNull();
    const rendered = [...section!.matchAll(/- Q(\d+)/g)];
    expect(rendered).toHaveLength(3);
    // +1 more — the 4th fresh question, not the aging one.
    expect(section).toContain("+1 more — `dome check`");
    expect(section).toContain("- 🕰 1 aging decision(s)");
  });

  test("all-aging → block has no question bullets, just the heading and the aging line", () => {
    const questions = [1, 2].map((id) =>
      question({ id, askedAt: "2026-06-01T00:00:00.000Z" }), // 8 days old
    );
    const section = questionsSection(questions, { nowIso: NOW_ISO });
    expect(section).not.toBeNull();
    expect(section).toContain("### To decide");
    expect(section).not.toMatch(/- Q\d+/);
    expect(section).not.toContain("more —");
    expect(section).toContain("- 🕰 2 aging decision(s)");
  });

  test("question_aging_days: 3 respected — a 4-day-old question ages out", () => {
    const question4d = question({ id: 1, askedAt: "2026-06-05T00:00:00.000Z" }); // 4 days old
    const section = questionsSection([question4d], {
      nowIso: NOW_ISO,
      agingDays: 3,
    });
    expect(section).not.toContain("- Q1");
    expect(section).toContain("- 🕰 1 aging decision(s)");
  });

  test("boundary: exactly agingDays old is still fresh (< strict comparison)", () => {
    const exact = question({ id: 1, askedAt: "2026-06-02T05:00:00.000Z" }); // exactly 7 days
    const section = questionsSection([exact], { nowIso: NOW_ISO });
    expect(section).toContain("- Q1");
    expect(section).not.toContain("🕰");
  });

  test("no aging questions → no aging line", () => {
    const section = questionsSection(
      [question({ id: 1, askedAt: "2026-06-08T00:00:00.000Z" })],
      { nowIso: NOW_ISO },
    );
    expect(section).not.toContain("🕰");
  });
});

describe("partitionQuestionsByAge", () => {
  test("splits fresh vs aging using a strict < cutoff comparison", () => {
    const rows = [
      { askedAt: "2026-06-08T00:00:00.000Z" }, // 1 day old — fresh
      { askedAt: "2026-06-01T00:00:00.000Z" }, // 8 days old — aging
      { askedAt: "2026-06-02T05:00:00.000Z" }, // exactly 7 days — fresh (boundary)
    ];
    const { fresh, aging } = partitionQuestionsByAge(rows, {
      agingDays: 7,
      nowIso: NOW_ISO,
    });
    expect(fresh).toHaveLength(2);
    expect(aging).toHaveLength(1);
    expect(aging[0]).toBe(rows[1]);
  });

  test("respects DEFAULT_QUESTION_AGING_DAYS = 7", () => {
    expect(DEFAULT_QUESTION_AGING_DAYS).toBe(7);
  });
});

describe("questionBullet (exported for cross-bundle reuse — dome.health.report-card)", () => {
  test("renders the same bullet shape questionsSection uses", () => {
    const bullet = questionBullet(
      question({ id: 42, question: "Merge?", recommendedAnswer: "yes" }),
    );
    expect(bullet).toBe(
      "- Q42 (owner-needed): Merge? — recommended: yes — resolve: `dome resolve 42 <answer>`",
    );
  });
});

// ----- agendaSection -----------------------------------------------------------

describe("agendaSection", () => {
  test("empty input → null", () => {
    expect(agendaSection([])).toBeNull();
  });

  test("bullet shape: time — title (attendees)", () => {
    const meetings: ReadonlyArray<CalendarMeeting> = [
      Object.freeze({
        time: "09:30",
        title: "Planning sync",
        attendees: Object.freeze(["alice", "bob"]),
      }),
    ];
    const section = agendaSection(meetings);
    expect(section).not.toBeNull();
    expect(section).toContain("- 09:30 — Planning sync (alice, bob)");
    expect(section!.trimStart()).toStartWith(AGENDA_MARKERS.start);
    expect(section!.trimEnd()).toEndWith(AGENDA_MARKERS.end);
  });

  test("omits the time prefix when absent", () => {
    const section = agendaSection([
      Object.freeze({ time: null, title: "Untimed item", attendees: [] }),
    ]);
    expect(section).toContain("- Untimed item");
    expect(section).not.toContain("null");
  });

  test("omits the attendees parens when empty", () => {
    const section = agendaSection([
      Object.freeze({ time: "10:00", title: "Solo block", attendees: [] }),
    ]);
    expect(section).toContain("- 10:00 — Solo block");
    expect(section).not.toContain("(");
  });
});

// ----- integratedSection ---------------------------------------------------

describe("integratedSection", () => {
  const row = (
    disposition: SweepSettlement["disposition"],
  ): SweepSettlement =>
    Object.freeze({
      material: "wiki/dailies/2026-06-09",
      destination: "wiki/entities/alice",
      disposition,
    });

  test("empty input → null", () => {
    expect(integratedSection([])).toBeNull();
  });

  test("renders integrated + questioned bullets under the heading; omits no-op/failed/escalated", () => {
    const section = integratedSection([
      row("integrated"),
      row("questioned"),
      row("no-op"),
      row("failed"),
      row("escalated"),
    ]);
    expect(section).not.toBeNull();
    expect(section).toContain("### Integrated Overnight");
    expect(section).toContain(
      "[[wiki/entities/alice]] ← [[wiki/dailies/2026-06-09]]",
    );
    expect(section).toContain("⚠ pending your answer");
    // Only two renderable rows (integrated + questioned) should produce bullets.
    expect(section!.match(/^- /gm)).toHaveLength(2);
    expect(section!.trimStart()).toStartWith(INTEGRATED_MARKERS.start);
    expect(section!.trimEnd()).toEndWith(INTEGRATED_MARKERS.end);
  });

  test("returns null when nothing is renderable", () => {
    expect(integratedSection([row("no-op"), row("failed"), row("escalated")])).toBeNull();
  });
});

// ----- sourcesSection --------------------------------------------------------

describe("sourcesSection", () => {
  test("null when no source kind is present", () => {
    expect(sourcesSection({ calendar: false, slack: false })).toBeNull();
  });

  test("renders only present kinds: calendar only", () => {
    const section = sourcesSection({ calendar: true, slack: false });
    expect(section).not.toBeNull();
    expect(section).toContain("calendar ✓");
    expect(section).not.toContain("slack");
    expect(section!.trimStart()).toStartWith(SOURCES_MARKERS.start);
    expect(section!.trimEnd()).toEndWith(SOURCES_MARKERS.end);
  });

  test("renders both kinds when both present", () => {
    const section = sourcesSection({ calendar: true, slack: true });
    expect(section).toContain("calendar ✓");
    expect(section).toContain("slack ✓");
  });

  test("renders only slack when only slack present", () => {
    const section = sourcesSection({ calendar: false, slack: true });
    expect(section).toContain("slack ✓");
    expect(section).not.toContain("calendar");
  });
});

// ----- proposalsSection -------------------------------------------------------

function proposal(
  overrides: Partial<EditionProposal> & { readonly id: number },
): EditionProposal {
  return Object.freeze({
    processorId: "dome.agent.consolidate",
    reason: `split oversized page ${overrides.id}`,
    pathCount: 1,
    ...overrides,
  });
}

describe("proposalsSection", () => {
  test("empty input → null", () => {
    expect(proposalsSection([])).toBeNull();
  });

  test("happy path: heading, bullet shape, apply command", () => {
    const section = proposalsSection([
      proposal({
        id: 12,
        processorId: "dome.agent.consolidate",
        reason: "split oversized entity page into danny + danny-promo-2026",
        pathCount: 1,
      }),
    ]);
    expect(section).not.toBeNull();
    expect(section).toContain("### To review");
    expect(section).toContain(
      "- P12 (dome.agent.consolidate): split oversized entity page into danny + danny-promo-2026 — 1 file — apply: `dome apply 12`",
    );
    expect(section!.trimStart()).toStartWith(PROPOSALS_MARKERS.start);
    expect(section!.trimEnd()).toEndWith(PROPOSALS_MARKERS.end);
  });

  test("pluralizes the file count", () => {
    const section = proposalsSection([proposal({ id: 1, pathCount: 3 })]);
    expect(section).toContain("— 3 files — apply:");
  });

  test("singular file count has no trailing s", () => {
    const section = proposalsSection([proposal({ id: 1, pathCount: 1 })]);
    expect(section).toContain("— 1 file — apply:");
  });

  test("neutralizes wikilink syntax in the reason", () => {
    const section = proposalsSection([
      proposal({ id: 1, reason: "merge [[Danny]] into [[Daniel]]" }),
    ]);
    expect(section).toContain("merge \\[\\[Danny\\]\\] into \\[\\[Daniel\\]\\]");
  });

  test("caps at MAX_EDITION_PROPOSALS with a +N more tail", () => {
    expect(MAX_EDITION_PROPOSALS).toBe(3);
    const proposals = [1, 2, 3, 4, 5].map((id) => proposal({ id }));
    const section = proposalsSection(proposals);
    expect(section).not.toBeNull();
    const rendered = [...section!.matchAll(/- P(\d+)/g)];
    expect(rendered).toHaveLength(3);
    expect(section).toContain("+2 more — `dome proposals`");
  });

  test("no tail line when the count is within the cap", () => {
    const section = proposalsSection([proposal({ id: 1 })]);
    expect(section).not.toContain("more —");
  });
});

// ----- replaceEditionBlock ---------------------------------------------------

describe("replaceEditionBlock", () => {
  const OWNER = "dome.daily";
  const BLOCK = "questions";
  const START = "<!-- dome.daily:questions:start -->";
  const END = "<!-- dome.daily:questions:end -->";
  const SECTION = `${START}\n- new content\n${END}`;

  test("inserts under the heading when the block is absent", () => {
    const content = "# Daily\n\n## Start Here\n\nHand-authored prose.\n";
    const result = replaceEditionBlock({
      content,
      owner: OWNER,
      block: BLOCK,
      section: SECTION,
      heading: "## Start Here",
    });
    expect(result).toContain(SECTION);
    const headingIndex = result.indexOf("## Start Here");
    const sectionIndex = result.indexOf(SECTION);
    const proseIndex = result.indexOf("Hand-authored prose.");
    expect(sectionIndex).toBeGreaterThan(headingIndex);
    expect(proseIndex).toBeGreaterThan(sectionIndex);
  });

  test("inserts after afterBlock when given and present", () => {
    const content = [
      "# Daily",
      "",
      "## Start Here",
      "",
      "<!-- dome.agent.brief:yesterday:start -->",
      "### Yesterday",
      "- did a thing",
      "<!-- dome.agent.brief:yesterday:end -->",
      "",
      "Trailing prose.",
      "",
    ].join("\n");
    const result = replaceEditionBlock({
      content,
      owner: OWNER,
      block: BLOCK,
      section: SECTION,
      heading: "## Start Here",
      afterBlock: { owner: "dome.agent.brief", block: "yesterday" },
    });
    const yesterdayEnd = result.indexOf(
      "<!-- dome.agent.brief:yesterday:end -->",
    );
    const sectionIndex = result.indexOf(SECTION);
    const trailingIndex = result.indexOf("Trailing prose.");
    expect(sectionIndex).toBeGreaterThan(yesterdayEnd);
    expect(trailingIndex).toBeGreaterThan(sectionIndex);
  });

  test("replaces an existing block in place", () => {
    const content = [
      "# Daily",
      "",
      "## Start Here",
      "",
      START,
      "- old content",
      END,
      "",
      "Trailing prose.",
    ].join("\n");
    const result = replaceEditionBlock({
      content,
      owner: OWNER,
      block: BLOCK,
      section: SECTION,
      heading: "## Start Here",
    });
    expect(result).not.toContain("old content");
    expect(result).toContain("new content");
    expect(result).toContain("Trailing prose.");
  });

  test("section: null removes the whole block including markers", () => {
    const content = [
      "# Daily",
      "",
      "## Start Here",
      "",
      START,
      "- old content",
      END,
      "",
      "Trailing prose.",
    ].join("\n");
    const result = replaceEditionBlock({
      content,
      owner: OWNER,
      block: BLOCK,
      section: null,
      heading: "## Start Here",
    });
    expect(result).not.toContain(START);
    expect(result).not.toContain(END);
    expect(result).not.toContain("old content");
    expect(result).toContain("Trailing prose.");
  });

  test("section: null on an absent block is a no-op", () => {
    const content = "# Daily\n\n## Start Here\n\nHand-authored prose.\n";
    const result = replaceEditionBlock({
      content,
      owner: OWNER,
      block: BLOCK,
      section: null,
      heading: "## Start Here",
    });
    expect(result).toBe(content);
  });

  test("creates the heading by appending when absent", () => {
    const content = "# Daily\n\nHand-authored prose.\n";
    const result = replaceEditionBlock({
      content,
      owner: OWNER,
      block: BLOCK,
      section: SECTION,
      heading: "## Start Here",
    });
    expect(result).toContain("## Start Here");
    expect(result).toContain(SECTION);
    const headingIndex = result.indexOf("## Start Here");
    const sectionIndex = result.indexOf(SECTION);
    expect(sectionIndex).toBeGreaterThan(headingIndex);
  });
});
