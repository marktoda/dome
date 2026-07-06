// assets/extensions/dome.daily/processors/edition-blocks.ts
//
// The compiled-daily blocks (D6/compiled-daily): deterministic renderers for
// the "To decide" / agenda / integrated / sources blocks that
// `dome.daily.compose-blocks` writes at 05:25 (and on `questions.changed` +
// source-file + sweep-ledger signals), plus the generic replace-or-insert
// splice they all share. Normative at [[wiki/specs/daily-surface]] §"Block
// ownership" (the `dome.daily:questions` / `:agenda` / `:integrated` /
// `:sources` rows).
//
// Every renderer here is pure string/data work — plain `-` bullets only,
// never `- [ ]` checkboxes (the task extractors would re-ingest them as new
// tasks). Marker construction goes exclusively through
// `src/core/generated-block` — the only sanctioned marker implementation
// (see [[wiki/linters/generated-block-splice-guard]]).

import { compareStrings } from "../../../../src/core/compare";
import {
  findGeneratedBlock,
  replaceGeneratedBlock,
} from "../../../../src/core/generated-block";
import { resolveQuestionCommand } from "../../../../src/question-resolution";
import type { CalendarMeeting } from "./calendar-day";
import { escapeRegExp } from "./daily-paths";
import {
  AGENDA_MARKERS,
  INTEGRATED_MARKERS,
  PROPOSALS_MARKERS,
  QUESTIONS_MARKERS,
  SOURCES_MARKERS,
} from "./daily-types";
import type { SweepSettlement } from "./sweep-ledger";

/**
 * A question ready to render into the "To decide" block. Callers (the
 * compose-blocks processor, Task 7's row mapping) derive `automationPolicy`
 * from a question's metadata via `questionAutomationPolicy` and
 * `recommendedAnswer` from `metadata.recommendedAnswer` — this module takes
 * the plain, already-mapped shape and never touches `QuestionMetadata`
 * itself.
 */
export type EditionQuestion = {
  readonly id: number;
  readonly question: string;
  readonly options: ReadonlyArray<string>;
  readonly automationPolicy: string;
  readonly recommendedAnswer: string | null;
  readonly askedAt: string;
};

/** Top N open questions rendered before the `+N more` tail. */
export const MAX_EDITION_QUESTIONS = 3;

/**
 * Neutralize wikilink syntax in quoted question prose. The questions block is
 * a PROJECTION of durable question rows into the daily — vault syntax quoted
 * inside a question's text must never re-enter link validation. Without this,
 * an ambiguous-wikilink question regenerates itself through the daily:
 * validate-wikilinks asks about `[[ambiguous]]` → compose-blocks renders that
 * text into today's daily → validate-wikilinks re-scans the daily (an
 * ordinary wiki/ markdown file), re-flags the quoted link, and asks a SECOND
 * question about the daily — a question → render → question feedback loop.
 * Escaping `[[` as `\[\[` and `]]` as `\]\]` breaks the loop: Obsidian
 * renders the escaped form as literal brackets, and the wikilink scanner
 * does not match it.
 */
function neutralizeWikilinks(text: string): string {
  return text.replaceAll("[[", "\\[\\[").replaceAll("]]", "\\]\\]");
}

function questionBullet(q: EditionQuestion): string {
  const optionsSuffix =
    q.options.length > 0
      ? ` [${q.options.map(neutralizeWikilinks).join(" | ")}]`
      : "";
  const recommendedSuffix =
    q.recommendedAnswer !== null
      ? ` — recommended: ${neutralizeWikilinks(q.recommendedAnswer)}`
      : "";
  const command = resolveQuestionCommand({ id: q.id, options: q.options });
  return `- Q${q.id} (${q.automationPolicy}): ${neutralizeWikilinks(q.question)}${optionsSuffix}${recommendedSuffix} — resolve: \`${command}\``;
}

/**
 * Render the "To decide" generated block: owner-needed questions first, then
 * oldest `askedAt` (within and across the two groups), capped at
 * `MAX_EDITION_QUESTIONS` with a `+N more — \`dome check\`` tail. Plain `-`
 * bullets — never `- [ ]` checkboxes. `null` when there are no open
 * questions (resolving the last question cleans the page — the block is
 * removed entirely, not rendered empty).
 */
export function questionsSection(
  questions: ReadonlyArray<EditionQuestion>,
): string | null {
  if (questions.length === 0) return null;
  const sorted = [...questions].sort((a, b) => {
    const aOwnerNeeded = a.automationPolicy === "owner-needed" ? 0 : 1;
    const bOwnerNeeded = b.automationPolicy === "owner-needed" ? 0 : 1;
    if (aOwnerNeeded !== bOwnerNeeded) return aOwnerNeeded - bOwnerNeeded;
    return compareStrings(a.askedAt, b.askedAt);
  });
  const shown = sorted.slice(0, MAX_EDITION_QUESTIONS);
  const lines = [
    QUESTIONS_MARKERS.start,
    "### To decide",
    ...shown.map(questionBullet),
  ];
  if (sorted.length > shown.length) {
    lines.push(`- +${sorted.length - shown.length} more — \`dome check\``);
  }
  lines.push(QUESTIONS_MARKERS.end);
  return lines.join("\n");
}

/**
 * A pending garden proposal ready to render into the "To review" block.
 * Callers (the compose-blocks processor) derive `pathCount` from the durable
 * `OperationalProposalRow.paths` (`paths.length`) — this module takes the
 * plain, already-mapped shape and never touches `OperationalProposalRow`
 * itself (processors stay pure; `src/proposals` is off-limits here).
 */
export type EditionProposal = {
  readonly id: number;
  readonly processorId: string;
  readonly reason: string;
  readonly pathCount: number;
};

/** Top N pending proposals rendered before the `+N more` tail. */
export const MAX_EDITION_PROPOSALS = 3;

function proposalBullet(p: EditionProposal): string {
  const fileWord = p.pathCount === 1 ? "file" : "files";
  return `- P${p.id} (${p.processorId}): ${neutralizeWikilinks(p.reason)} — ${p.pathCount} ${fileWord} — apply: \`dome apply ${p.id}\``;
}

/**
 * Render the "To review" generated block: pending garden proposals, oldest
 * first (callers pre-sort by `createdAt` ascending — this renderer trusts
 * the given order), capped at `MAX_EDITION_PROPOSALS` with a
 * `+N more — \`dome proposals\`` tail. Plain `-` bullets — never `- [ ]`
 * checkboxes. `null` when there are no pending proposals (the block is
 * removed entirely, not rendered empty).
 */
export function proposalsSection(
  proposals: ReadonlyArray<EditionProposal>,
): string | null {
  if (proposals.length === 0) return null;
  const shown = proposals.slice(0, MAX_EDITION_PROPOSALS);
  const lines = [
    PROPOSALS_MARKERS.start,
    "### To review",
    ...shown.map(proposalBullet),
  ];
  if (proposals.length > shown.length) {
    lines.push(`- +${proposals.length - shown.length} more — \`dome proposals\``);
  }
  lines.push(PROPOSALS_MARKERS.end);
  return lines.join("\n");
}

function agendaBullet(meeting: CalendarMeeting): string {
  const timePrefix = meeting.time !== null ? `${meeting.time} — ` : "";
  const attendeesSuffix =
    meeting.attendees.length > 0 ? ` (${meeting.attendees.join(", ")})` : "";
  return `- ${timePrefix}${meeting.title}${attendeesSuffix}`;
}

/**
 * Render the agenda generated block from today's calendar meetings — time ·
 * title · attendees, in the calendar file's own order (the same defensive
 * `parseCalendarDay` grammar the cockpit path uses). `null` when no meetings
 * parse (no calendar file, or an empty one) — omission, not an empty
 * section.
 */
export function agendaSection(
  meetings: ReadonlyArray<CalendarMeeting>,
): string | null {
  if (meetings.length === 0) return null;
  const lines = [
    AGENDA_MARKERS.start,
    ...meetings.map(agendaBullet),
    AGENDA_MARKERS.end,
  ];
  return lines.join("\n");
}

/**
 * Render the "Integrated Overnight" generated block from the sweep ledger
 * rows for today's run. Moved+adapted verbatim from the brief's
 * `integratedBriefSection` ([[wiki/specs/sweep]] §"Brief digest block") —
 * same bullet shapes, wrapped in the `dome.daily` markers instead of
 * `dome.agent.brief`'s. Rows rendered:
 *   - `integrated` → `- [[<destination>]] ← [[<material>]]`
 *   - `questioned` → `- ⚠ pending your answer: [[<destination>]] ← [[<material>]]`
 *   - `no-op` / `failed` → omitted (signal, not log)
 *   - `escalated` → omitted (its finding already renders as a diagnostic;
 *     a second bullet would double-surface)
 *
 * `null` when rows is empty or nothing is renderable.
 */
export function integratedSection(
  rows: ReadonlyArray<SweepSettlement>,
): string | null {
  const bullets: string[] = [];
  for (const row of rows) {
    if (row.disposition === "integrated") {
      bullets.push(`- [[${row.destination}]] ← [[${row.material}]]`);
    } else if (row.disposition === "questioned") {
      bullets.push(
        `- ⚠ pending your answer: [[${row.destination}]] ← [[${row.material}]]`,
      );
    }
    // no-op, failed, escalated: omitted (see docstring above).
  }
  if (bullets.length === 0) return null;
  const lines = [
    INTEGRATED_MARKERS.start,
    "### Integrated Overnight",
    ...bullets,
    INTEGRATED_MARKERS.end,
  ];
  return lines.join("\n");
}

const SOURCES_SEEN = "✓";

/**
 * Render the sources-seen record block — one italic line listing ONLY the
 * source kinds whose day-file exists today (a `dome.daily` processor cannot
 * read `dome.sources` config, so file presence is the whole test). `null`
 * when no source day-file exists at all — a vault with none landed gets no
 * line, never a perpetual all-absent record.
 */
export function sourcesSection(present: {
  readonly calendar: boolean;
  readonly slack: boolean;
}): string | null {
  const parts: string[] = [];
  if (present.calendar) parts.push(`calendar ${SOURCES_SEEN}`);
  if (present.slack) parts.push(`slack ${SOURCES_SEEN}`);
  if (parts.length === 0) return null;
  return [
    SOURCES_MARKERS.start,
    `_Sources: ${parts.join(" · ")}_`,
    SOURCES_MARKERS.end,
  ].join("\n");
}

/**
 * Replace an existing `(owner, block)` marker block with `section` (a full
 * block including markers), or insert it. Mirrors `replaceBriefBlock`
 * (`dome.agent/lib/brief-shared.ts`), parameterized by owner/block so every
 * edition block shares one splice: insertion goes directly under `heading`
 * (the full `## <Heading>` line) when it exists, or right after `afterBlock`
 * when given and present; otherwise the heading + section are appended at
 * the end (creating the heading). `section: null` removes an existing block
 * entirely, markers included (used to drop a stale block once its content
 * source empties out — e.g. all questions resolved).
 */
export function replaceEditionBlock(input: {
  readonly content: string;
  readonly owner: string;
  readonly block: string;
  readonly section: string | null;
  readonly heading: string;
  readonly afterBlock?: { readonly owner: string; readonly block: string };
}): string {
  const replaced = replaceGeneratedBlock(
    input.content,
    input.owner,
    input.block,
    input.section === null ? "" : input.section,
  );
  if (replaced !== null) return replaced;
  if (input.section === null) return input.content;

  if (input.afterBlock !== undefined) {
    const anchor = findGeneratedBlock(
      input.content,
      input.afterBlock.owner,
      input.afterBlock.block,
    ).range;
    if (anchor !== null) {
      return `${input.content.slice(0, anchor.end)}\n\n${input.section}${input.content.slice(anchor.end)}`;
    }
  }

  const headingMatch = new RegExp(
    `^${escapeRegExp(input.heading)}[ \\t]*$`,
    "m",
  ).exec(input.content);
  if (headingMatch !== null && headingMatch.index !== undefined) {
    const insertAt = headingMatch.index + headingMatch[0].length;
    const rest = input.content.slice(insertAt).replace(/^(?:\r?\n)*/, "\n\n");
    return `${input.content.slice(0, insertAt)}\n\n${input.section}${rest}`;
  }

  const suffix = input.content.endsWith("\n") ? "" : "\n";
  return `${input.content}${suffix}\n${input.heading}\n\n${input.section}\n`;
}
