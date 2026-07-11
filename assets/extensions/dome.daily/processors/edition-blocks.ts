// assets/extensions/dome.daily/processors/edition-blocks.ts
//
// The compiled-daily blocks (D6/compiled-daily): deterministic renderers for
// the "To decide" / agenda / sources blocks that
// `dome.daily.compose-blocks` writes at 05:25 (and on `questions.changed` +
// source-file signals), plus the generic replace-or-insert
// splice they all share. Normative at [[wiki/specs/daily-surface]] §"Block
// ownership" (the `dome.daily:questions` / `:agenda` / `:sources` rows).
//
// Every renderer here is pure string/data work — plain `-` bullets only,
// never `- [ ]` checkboxes (the task extractors would re-ingest them as new
// tasks). Marker construction goes exclusively through
// `src/core/generated-block` — the only sanctioned marker implementation
// (see [[wiki/linters/generated-block-splice-guard]]).

import {
  findGeneratedBlock,
  replaceGeneratedBlock,
} from "../../../../src/core/generated-block";
import type {
  ExtensionConfig,
  OperationalQuestionRow,
} from "../../../../src/core/processor";
import {
  questionAutomationPolicy,
  resolveQuestionCommand,
} from "../../../../src/question-resolution";
import type { CalendarMeeting } from "./calendar-day";
import { escapeRegExp } from "./daily-paths";
import {
  AGENDA_MARKERS,
  QUESTIONS_MARKERS,
  SOURCES_MARKERS,
} from "./daily-types";
import type { OwnerAttentionItem } from "../../../../src/attention/attention";

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

/**
 * Map a durable operational question row to the plain `EditionQuestion` shape
 * this module's renderers consume — shared by `dome.daily.compose-blocks`
 * (the "To decide" block) and `dome.health.report-card` (the "Aging
 * decisions" section), so both surfaces derive automation policy and
 * recommended-answer the same way without re-deriving the mapping.
 */
export function toEditionQuestion(row: OperationalQuestionRow): EditionQuestion {
  return Object.freeze({
    id: row.id,
    question: row.question,
    options: row.options ?? [],
    automationPolicy: questionAutomationPolicy(row.metadata),
    recommendedAnswer: row.metadata?.recommendedAnswer ?? null,
    askedAt: row.askedAt,
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Default `question_aging_days` — the age (in days) past which an open
 * question stops repeating in the daily "To decide" block and escalates to
 * the weekly review instead. Single source for both `dome.daily.compose-
 * blocks` and `dome.health.report-card`'s config resolution, so the two
 * surfaces can never drift on the threshold or its default.
 */
export const DEFAULT_QUESTION_AGING_DAYS = 7;

/**
 * Resolve `question_aging_days` from an extension's config, degrade-not-crash
 * (mirrors `minClaimsFromConfig` in `dome.claims/processors/render-facts.ts`):
 * a missing, non-numeric, non-integer, or non-positive value falls back to
 * `DEFAULT_QUESTION_AGING_DAYS` rather than throwing.
 */
export function questionAgingDaysFromConfig(config?: ExtensionConfig): number {
  const raw = config?.["question_aging_days"];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return DEFAULT_QUESTION_AGING_DAYS;
  }
  return raw;
}

/**
 * Partition rows by askedAt age against `nowIso`: a row is "aging" when its
 * `askedAt` is strictly before `nowIso - agingDays` (an exactly-`agingDays`-
 * old row is still fresh — a boundary-inclusive comparison would flip a row's
 * bucket on the day it turns exactly N days old and back the next tick).
 * Generic over any row shape carrying `askedAt` so both the plain
 * `EditionQuestion` (compose-blocks) and the raw `OperationalQuestionRow`
 * (report-card, which only needs the aging subset) share one aging rule.
 */
export function partitionQuestionsByAge<T extends { readonly askedAt: string }>(
  rows: ReadonlyArray<T>,
  opts: { readonly agingDays: number; readonly nowIso: string },
): { readonly fresh: ReadonlyArray<T>; readonly aging: ReadonlyArray<T> } {
  const cutoffMs = Date.parse(opts.nowIso) - opts.agingDays * DAY_MS;
  const fresh: T[] = [];
  const aging: T[] = [];
  for (const row of rows) {
    if (Date.parse(row.askedAt) < cutoffMs) {
      aging.push(row);
    } else {
      fresh.push(row);
    }
  }
  return Object.freeze({ fresh: Object.freeze(fresh), aging: Object.freeze(aging) });
}

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

/**
 * Render one question as a "To decide" bullet: policy, text, options,
 * recommendation, and the literal resolve command. Exported for cross-bundle
 * reuse by `dome.health.report-card`'s "Aging decisions" section (both the
 * full card and the daily weekly-review block render aging questions in this
 * same bullet shape) — the `dome.health/processors/report-card.ts` import of
 * `replaceEditionBlock` from this module is the existing cross-bundle
 * precedent.
 */
export function questionBullet(q: EditionQuestion): string {
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

export function proposalBullet(p: EditionProposal): string {
  const fileWord = p.pathCount === 1 ? "file" : "files";
  return `- P${p.id} (${p.processorId}): ${neutralizeWikilinks(p.reason)} — ${p.pathCount} ${fileWord} — apply: \`dome apply ${p.id}\``;
}

export type EditionAttentionItem =
  | { readonly kind: "decision"; readonly item: EditionQuestion }
  | { readonly kind: "review"; readonly item: EditionProposal };

/**
 * The single compiled owner budget. Questions and proposal reviews compete in
 * the canonical attention order before rendering; plugin/domain categories do
 * not receive independent caps. `backlogCount` is the quiet tail outside the
 * immediate budget, including aging requests.
 */
export function attentionSection(
  items: ReadonlyArray<EditionAttentionItem>,
  backlogCount: number,
): string | null {
  if (items.length === 0 && backlogCount === 0) return null;
  const lines = [QUESTIONS_MARKERS.start, "### Dome needs you"];
  for (const item of items) {
    lines.push(
      item.kind === "decision"
        ? questionBullet(item.item)
        : proposalBullet(item.item),
    );
  }
  if (backlogCount > 0) {
    lines.push(
      `- +${backlogCount} in owner backlog — \`dome check --decisions\``,
    );
  }
  lines.push(QUESTIONS_MARKERS.end);
  return lines.join("\n");
}

/** Map a canonical attention item to the daily renderer's plain wire shape. */
export function toEditionAttention(
  item: OwnerAttentionItem,
  questionsById: ReadonlyMap<number, EditionQuestion>,
  proposalsById: ReadonlyMap<number, EditionProposal>,
): EditionAttentionItem | null {
  if (item.kind === "decision") {
    const question = questionsById.get(item.action.questionId);
    return question === undefined ? null : Object.freeze({ kind: "decision", item: question });
  }
  const proposal = proposalsById.get(item.action.proposalId);
  return proposal === undefined ? null : Object.freeze({ kind: "review", item: proposal });
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
