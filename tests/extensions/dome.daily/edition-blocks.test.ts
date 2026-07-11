import { describe, expect, test } from "bun:test";

import {
  agendaSection,
  attentionSection,
  partitionQuestionsByAge,
  questionBullet,
  replaceEditionBlock,
  sourcesSection,
  type EditionAttentionItem,
  type EditionQuestion,
} from "../../../assets/extensions/dome.daily/processors/edition-blocks";
import { QUESTIONS_MARKERS } from "../../../assets/extensions/dome.daily/processors/daily-types";

const QUESTION: EditionQuestion = Object.freeze({
  id: 7,
  question: "Ship [[wiki/project]]?",
  options: Object.freeze(["yes", "no"]),
  automationPolicy: "owner-needed",
  recommendedAnswer: "yes",
  askedAt: "2026-07-09T09:00:00.000Z",
});

describe("attentionSection", () => {
  test("renders decisions and reviews in the supplied canonical order", () => {
    const items: ReadonlyArray<EditionAttentionItem> = [
      {
        kind: "review",
        item: {
          id: 3,
          processorId: "dome.agent.garden",
          reason: "split [[wiki/big]]",
          pathCount: 2,
        },
      },
      { kind: "decision", item: QUESTION },
    ];
    const rendered = attentionSection(items, 4)!;
    expect(rendered).toContain("### Dome needs you");
    expect(rendered.indexOf("P3")).toBeLessThan(rendered.indexOf("Q7"));
    expect(rendered).toContain("dome apply 3");
    expect(rendered).toContain("dome resolve 7 <yes|no>");
    expect(rendered).toContain("+4 in owner backlog");
    expect(rendered).not.toContain("[[");
    expect(rendered).not.toContain("- [ ]");
  });

  test("returns null only when both immediate and backlog are empty", () => {
    expect(attentionSection([], 0)).toBeNull();
    expect(attentionSection([], 2)).toContain("+2 in owner backlog");
  });
});

describe("decision helpers retained by the weekly report", () => {
  test("questionBullet carries options, recommendation, and command", () => {
    const bullet = questionBullet(QUESTION);
    expect(bullet).toContain("[yes | no]");
    expect(bullet).toContain("recommended: yes");
    expect(bullet).toContain("dome resolve 7 <yes|no>");
  });

  test("partitionQuestionsByAge uses the shared strict cutoff", () => {
    const split = partitionQuestionsByAge(
      [QUESTION, { ...QUESTION, id: 8, askedAt: "2026-06-01T00:00:00.000Z" }],
      { agingDays: 7, nowIso: "2026-07-09T00:00:00.000Z" },
    );
    expect(split.fresh.map((q) => q.id)).toEqual([7]);
    expect(split.aging.map((q) => q.id)).toEqual([8]);
  });
});

describe("other edition renderers", () => {
  test("agenda and sources stay null on empty inputs", () => {
    expect(agendaSection([])).toBeNull();
    expect(sourcesSection({ calendar: false, slack: false })).toBeNull();
  });

  test("agenda and sources render current inputs", () => {
    expect(agendaSection([{
      time: "09:30",
      title: "Design review",
      attendees: ["Ada", "Bo"],
    }])).toContain("09:30 — Design review (Ada, Bo)");
    expect(sourcesSection({ calendar: true, slack: false })).toContain("calendar ✓");
  });

  test("replaceEditionBlock inserts, replaces, and removes through one seam", () => {
    const base = "# Day\n\n## Start Here\n";
    const first = attentionSection([{ kind: "decision", item: QUESTION }], 0)!;
    const inserted = replaceEditionBlock({
      content: base,
      owner: "dome.daily",
      block: "questions",
      section: first,
      heading: "## Start Here",
    });
    expect(inserted).toContain(QUESTIONS_MARKERS.start);
    const removed = replaceEditionBlock({
      content: inserted,
      owner: "dome.daily",
      block: "questions",
      section: null,
      heading: "## Start Here",
    });
    expect(removed).not.toContain(QUESTIONS_MARKERS.start);
  });
});
