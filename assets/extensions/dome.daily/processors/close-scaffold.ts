// dome.daily.close-scaffold — the evening close (daily-surface D4).
//
// At 21:30 (schedule-only by design — the close is a ritual moment, not a
// live surface; a commit-triggered rewrite would fight the human's
// keep/delete edits) the processor drafts the deterministic dome.daily:close
// block under ## Done in TODAY's daily: done candidates derived from today's
// daily alone (settled source-backed open-loop copies + settled checkbox
// lines authored directly in the note, deduped by normalized body — no git
// history walk, no ledger read), the still-open line-up (count + top 3 in
// surface order), and a story pointer. ## Story of the Day stays human-only
// forever ([[daily]] decision ledger 3).
//
// Idempotency is presence-gated: the block is written ONLY when absent, so
// re-runs are byte-identical no-ops and a human-deleted candidate is never
// resurrected. No daily at close time → clean no-op (the close needs a day
// to close; it never creates the skeleton). Normative contract:
// [[wiki/specs/daily-surface]] §"The close block".

import {
  patchEffect,
  type Effect,
  type FileChangeInput,
} from "../../../../src/core/effect";
import { generatedBlockAnomalyDiagnostics } from "../../../../src/core/generated-block-diagnostics";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";

import {
  DAILY_GENERATED_BLOCKS,
  closeScaffoldSection,
  dailyPath,
  dailyPathSettings,
  ensureCloseScaffoldSection,
  localDateParts,
  openLoopSurfaceKey,
  openSourceBackedOpenLoopsFromMarkdown,
  settledActionItemsFromMarkdown,
  settledSourceBackedOpenLoopsFromMarkdown,
  type DailyCloseDoneCandidate,
} from "./daily-shared";

type ScheduleInput = {
  readonly kind: "schedule";
  readonly cron: string;
  readonly firedAt: string;
};

/**
 * The evening gate: the close fires only within its evening window
 * ([21:30, midnight) vault-local; the start matches the manifest cron
 * `30 21 * * *`). The scheduler collapses misfires to one immediate fire
 * (src/engine/operational/scheduler.ts) — without the gate, the first tick after
 * enabling the bundle, or a host that slept through the evening and woke
 * the next morning, would scaffold a premature close at whatever time it
 * happens to be, freezing a wrong snapshot that the presence gate then
 * protects for the rest of the day. A fire after midnight targets the new
 * day's daily anyway, so the window needs no upper bound beyond the date
 * roll. Normative at [[wiki/specs/daily-surface]] §"The close block".
 */
const CLOSE_WINDOW_START_MINUTES = 21 * 60 + 30;

function isWithinCloseWindow(firedAt: string): boolean {
  const at = new Date(firedAt);
  return at.getHours() * 60 + at.getMinutes() >= CLOSE_WINDOW_START_MINUTES;
}

const closeScaffold = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const input = parseScheduleInput(ctx.input);
    if (input === null) return [];
    if (!isWithinCloseWindow(input.firedAt)) return [];

    const settings = dailyPathSettings(ctx.extensionConfig);
    const today = localDateParts(new Date(input.firedAt));
    const todayPath = dailyPath(today, settings);
    const content = await ctx.snapshot.readFile(todayPath);
    // No daily, no close: the close needs a day to close. Never create the
    // skeleton here — that is create-daily/brief's job at the morning end.
    if (content === null) return [];

    // Same splice-site anomaly contract as carry-forward: mangled markers in
    // the (human-editable) daily are ignored by the line-anchored splice but
    // surfaced as info diagnostics (deduped at the sink).
    const anomalyDiagnostics = generatedBlockAnomalyDiagnostics({
      content,
      path: todayPath,
      code: "dome.daily.generated-block-anomaly",
      blocks: DAILY_GENERATED_BLOCKS,
      sourceRef: (path, range) => ctx.sourceRef(path, range),
    });

    const doneCandidates = collectDoneCandidates(todayPath, content);
    const stillOpen = openSourceBackedOpenLoopsFromMarkdown({
      path: todayPath,
      content,
    });
    const nextContent = ensureCloseScaffoldSection({
      content,
      section: closeScaffoldSection({ doneCandidates, stillOpen }),
    });
    if (nextContent === content) return Object.freeze([...anomalyDiagnostics]);

    const change: FileChangeInput = {
      kind: "write",
      path: todayPath,
      content: nextContent,
    };

    return [
      ...anomalyDiagnostics,
      patchEffect({
        mode: "auto",
        changes: [change],
        reason: `dome.daily: scaffold the close in ${todayPath}`,
        sourceRefs: closeSourceRefs(ctx, todayPath, doneCandidates),
      }),
    ];
  },
});

export default closeScaffold;

/**
 * The cheap deterministic done-candidate derivation, recorded in
 * daily-surface §"The close block": today's daily alone is read. Settled
 * source-backed copies (carry-forward renders only today's settles into
 * today's surface, so they are settled-today by construction) plus settled
 * checkbox lines authored directly in the note, deduped by normalized body.
 */
function collectDoneCandidates(
  todayPath: string,
  content: string,
): ReadonlyArray<DailyCloseDoneCandidate> {
  const out: DailyCloseDoneCandidate[] = [];
  const seen = new Set<string>();
  for (const item of settledSourceBackedOpenLoopsFromMarkdown({
    path: todayPath,
    content,
  })) {
    const key = openLoopSurfaceKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      Object.freeze({
        line: item.line,
        body: item.body,
        status: item.status,
        originPath: item.sourcePath,
      }),
    );
  }
  for (const item of settledActionItemsFromMarkdown(content)) {
    const key = openLoopSurfaceKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      Object.freeze({
        line: item.line,
        body: item.body,
        status: item.status,
        originPath: null,
      }),
    );
  }
  return Object.freeze(out);
}

function closeSourceRefs(
  ctx: ProcessorContext,
  todayPath: string,
  doneCandidates: ReadonlyArray<DailyCloseDoneCandidate>,
): ReadonlyArray<SourceRef> {
  return Object.freeze([
    ctx.sourceRef(todayPath),
    ...doneCandidates.map((candidate) =>
      ctx.sourceRef(todayPath, {
        startLine: candidate.line,
        endLine: candidate.line,
      })
    ),
  ]);
}

function parseScheduleInput(input: unknown): ScheduleInput | null {
  if (input === null || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  if (record.kind !== "schedule") return null;
  if (typeof record.cron !== "string") return null;
  if (typeof record.firedAt !== "string") return null;
  if (Number.isNaN(new Date(record.firedAt).getTime())) return null;
  return Object.freeze({
    kind: "schedule",
    cron: record.cron,
    firedAt: new Date(record.firedAt).toISOString(),
  });
}
