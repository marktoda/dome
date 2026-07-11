// dome.daily.compose-blocks — the deterministic compositor (daily-surface D6).
//
// At 05:25 (schedule) and on `questions.changed` + `proposals.changed` +
// source-file signals, this processor composes the
// deterministic edition blocks into TODAY's daily: the "To decide" questions
// list, the "To review" pending-proposals list, the agenda, the
// honest sources-seen record — each
// rendered from current inputs by the pure renderers in `edition-blocks.ts`.
// It also performs the one-time migration that removes the retired
// `dome.agent.brief:{questions,integrated,sources}` legacy blocks from today's
// daily in the same patch that writes their `dome.daily:*` replacements.
//
// Determinism is the whole contract: byte-identical recomposition emits NO
// patch (the recompose is a no-op when inputs are unchanged), the patch is
// atomic (never a half-written package), and the only path it ever writes is
// TODAY's daily — historical dailies are closed records. When `questions.read`
// (or `proposals.read`) is declared but `ctx.operational.questions` (or
// `.proposals`) is absent, the corresponding block is omitted and a LOUD
// `dome.daily.questions-view-missing` / `dome.daily.proposals-view-missing`
// warning fires — never a silent empty render (the degradation ladder's
// view-missing rungs). Normative: [[wiki/specs/daily-surface]] §"Block
// ownership" + §"The degradation ladder"; choreography row 05:25.

import {
  diagnosticEffect,
  patchEffect,
  type Effect,
  type FileChangeInput,
} from "../../../../src/core/effect";
import {
  attentionProposal,
  compileAttention,
} from "../../../../src/attention/attention";
import { generatedBlockAnomalyDiagnostics } from "../../../../src/core/generated-block-diagnostics";
import {
  defineProcessorImplementation,
  type OperationalProposalRow,
  type ProcessorContext,
} from "../../../../src/core/processor";

import { parseCalendarDay } from "./calendar-day";
import {
  dailyPath,
  dailyPathSettings,
  formatDate,
  localDateParts,
  parseScheduleInput,
  previousLocalDate,
} from "./daily-paths";
import { renderDailySkeleton } from "./daily-scaffold";
import {
  AGENDA_BLOCK,
  DAILY_GENERATED_BLOCKS,
  DAILY_OWNER,
  EDITION_YESTERDAY_BLOCK,
  INTEGRATED_BLOCK,
  LEGACY_BRIEF_INTEGRATED,
  LEGACY_BRIEF_QUESTIONS,
  LEGACY_BRIEF_SOURCES,
  PROPOSALS_BLOCK,
  QUESTIONS_BLOCK,
  SOURCES_BLOCK,
} from "./daily-types";
import {
  agendaSection,
  attentionSection,
  questionAgingDaysFromConfig,
  replaceEditionBlock,
  sourcesSection,
  toEditionQuestion,
  toEditionAttention,
  type EditionProposal,
} from "./edition-blocks";

const START_HERE_HEADING = "## Start Here";
const MEETINGS_HEADING = "## Meetings";

const composeBlocks = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const settings = dailyPathSettings(ctx.extensionConfig);
    // Target date: the scheduled fire when triggered by cron, else the current
    // vault-local date (signal fires carry no firedAt). Clock only via
    // ctx.now() (the processor-clock fence).
    const firedAt = parseScheduleInput(ctx.input)?.firedAt ?? null;
    const now = firedAt === null ? ctx.now() : new Date(firedAt);
    const date = localDateParts(now);
    const todayPath = dailyPath(date, settings);
    const todayStr = formatDate(date);
    const agingDays = questionAgingDaysFromConfig(ctx.extensionConfig);

    const existing = await ctx.snapshot.readFile(todayPath);
    const yesterday = previousLocalDate(date);
    const base =
      existing ??
      renderDailySkeleton({
        today: date,
        // Skeleton parity with create-daily: link yesterday only when that
        // daily exists — an unconditional link renders as a broken wikilink
        // on any vault whose previous day has no note (fresh installs, gap
        // days). The read only happens on the skeleton branch (?? short-
        // circuits when today's note exists).
        yesterday:
          (await ctx.snapshot.readFile(dailyPath(yesterday, settings))) !==
              null
            ? yesterday
            : null,
        settings,
      });

    // Same splice-site anomaly contract as carry-forward/close: mangled
    // markers in the (human-editable) daily are ignored by the line-anchored
    // splice but surfaced as info diagnostics (deduped at the sink).
    const diagnostics: Effect[] = [
      ...generatedBlockAnomalyDiagnostics({
        content: existing ?? "",
        path: todayPath,
        code: "dome.daily.generated-block-anomaly",
        blocks: DAILY_GENERATED_BLOCKS,
        sourceRef: (path, range) => ctx.sourceRef(path, range),
      }),
    ];

    let content = base;

    // Owner attention — one canonical budget across decisions and proposal
    // reviews. The raw views remain distinct durable lifecycles; the attention
    // compiler owns eligibility, ordering, aging, and the shared cap.
    // A missing operational view is LOUD (the block is omitted, never a silent
    // empty render). NEEDS_ARE_LOUD applied locally.
    const questionsView = ctx.operational?.questions;
    const proposalsView = ctx.operational?.proposals;
    if (questionsView === undefined) {
      diagnostics.push(
        diagnosticEffect({
          severity: "warning",
          code: "dome.daily.questions-view-missing",
          message:
            "dome.daily.compose-blocks declares questions.read but received no questions view; decisions are omitted from owner attention",
          sourceRefs: [ctx.sourceRef(todayPath)],
        }),
      );
    }
    if (proposalsView === undefined) {
      diagnostics.push(
        diagnosticEffect({
          severity: "warning",
          code: "dome.daily.proposals-view-missing",
          message:
            "dome.daily.compose-blocks declares proposals.read but received no proposals view; reviews are omitted from owner attention",
          sourceRefs: [ctx.sourceRef(todayPath)],
        }),
      );
    }
    {
      const questionRows = questionsView?.({ resolved: false }) ?? [];
      const proposalRows = proposalsView?.({ status: "pending" }) ?? [];
      const questionsById = new Map(
        questionRows.map((row) => [row.id, toEditionQuestion(row)]),
      );
      const proposalsById = new Map(
        proposalRows.map((row) => [row.id, toEditionProposal(row)]),
      );
      const attention = compileAttention({
        questions: questionRows.map((row) => ({
          id: row.id,
          question: row.question,
          ...(row.options !== undefined ? { options: row.options } : {}),
          sourceRefs: row.sourceRefs,
          ...(row.metadata !== undefined ? { metadata: row.metadata } : {}),
          processorId: row.processorId,
          askedAt: row.askedAt,
        })),
        proposals: proposalRows.map((row) => attentionProposal(row)),
        now,
        agingDays,
      });
      const items = attention.primary.flatMap((item) => {
        const edition = toEditionAttention(item, questionsById, proposalsById);
        return edition === null ? [] : [edition];
      });
      content = replaceEditionBlock({
        content,
        owner: DAILY_OWNER,
        block: QUESTIONS_BLOCK,
        section: attentionSection(items, attention.backlog.length),
        heading: START_HERE_HEADING,
        afterBlock: EDITION_YESTERDAY_BLOCK,
      });
    }

    // Hard-cut migration: remove any previously generated sweep digest.
    content = replaceEditionBlock({
      content,
      owner: DAILY_OWNER,
      block: INTEGRATED_BLOCK,
      section: null,
      heading: START_HERE_HEADING,
    });

    // Hard-cut migration: proposal reviews now live inside the canonical
    // owner-attention block. Remove the retired independent-budget block.
    content = replaceEditionBlock({
      content,
      owner: DAILY_OWNER,
      block: PROPOSALS_BLOCK,
      section: null,
      heading: START_HERE_HEADING,
    });

    // Sources-seen — one line per source kind whose day-file exists today.
    const calendar = await ctx.snapshot.readFile(
      `sources/calendar/${todayStr}.md`,
    );
    const slack = await ctx.snapshot.readFile(`sources/slack/${todayStr}.md`);
    content = replaceEditionBlock({
      content,
      owner: DAILY_OWNER,
      block: SOURCES_BLOCK,
      section: sourcesSection({
        calendar: calendar !== null,
        slack: slack !== null,
      }),
      heading: START_HERE_HEADING,
      afterBlock: { owner: DAILY_OWNER, block: QUESTIONS_BLOCK },
    });

    // Agenda — time · title · attendees from today's calendar, at the top of
    // ## Meetings (the defensive parser degrades unparsable lines).
    content = replaceEditionBlock({
      content,
      owner: DAILY_OWNER,
      block: AGENDA_BLOCK,
      section: calendar === null ? null : agendaSection(parseCalendarDay(calendar)),
      heading: MEETINGS_HEADING,
    });

    // One-time migration: remove the retired brief-namespace blocks (markers
    // included). `section: null` removes an existing block and no-ops when
    // absent; removal ignores the heading. Idempotent — the legacy markers are
    // never re-written, so they never reappear. Today-only by construction.
    for (const legacy of [
      LEGACY_BRIEF_QUESTIONS,
      LEGACY_BRIEF_INTEGRATED,
      LEGACY_BRIEF_SOURCES,
    ]) {
      content = replaceEditionBlock({
        content,
        owner: legacy.owner,
        block: legacy.block,
        section: null,
        heading: START_HERE_HEADING,
      });
    }

    // Byte-identical recomposition is a no-op — the deterministic gate.
    if (content === existing) return Object.freeze([...diagnostics]);

    const change: FileChangeInput = {
      kind: "write",
      path: todayPath,
      content,
    };
    return Object.freeze([
      ...diagnostics,
      patchEffect({
        mode: "auto",
        changes: [change],
        reason: `dome.daily: compose deterministic edition blocks in ${todayPath}`,
        sourceRefs: [ctx.sourceRef(todayPath)],
      }),
    ]);
  },
});

export default composeBlocks;

/**
 * Map a durable operational proposal row to the plain `EditionProposal`
 * shape the "To review" renderer consumes — `pathCount` is derived from the
 * row's `paths` (its raw `FileChange` payload stays internal to
 * `proposals.db`, per `OperationalProposalRow`'s narrower view contract).
 */
function toEditionProposal(row: OperationalProposalRow): EditionProposal {
  return Object.freeze({
    id: row.id,
    processorId: row.processorId,
    reason: row.reason,
    pathCount: row.paths.length,
  });
}
