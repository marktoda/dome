// dome.agent.patrol — the deterministic staleness patrol (product-review-3
// Task 15). The garden is signal-triggered today: it tends what changes and
// never revisits the frozen tail (a page that emits no signal is structurally
// invisible to every processor). The patrol makes gardening cyclical — a
// deterministic nightly selector queues the stalest entity / concept /
// synthesis pages so the nightly consolidate (Task 16) reviews them on a
// rotation, not just what happened to move.
//
// No model. ONE PatchEffect rewrites BOTH meta files:
//   - meta/patrol-queue.md   — tonight's ≤5 stalest eligible pages (full rewrite)
//   - meta/patrol-ledger.md  — the visit record, pruned to the trailing 60 days
// plus `dome.agent.page.oversized` INFO diagnostics for any scanned page over
// 600 lines — the deterministic propose-split nudge for the owner's "cohesive
// syntheses" preference. The diagnostic anchors to the page path with a STABLE
// SourceRef (no line range), so its subject_hash is invariant under shrinkage:
// once the page drops below the threshold the processor stops re-emitting and
// resolveStaleDiagnostics (inspection: all-readable-markdown) clears it — the
// self-clearing shape shared with the lint diagnostics.
//
// Determinism: the fire date comes from ctx.now() via the same
// localDateParts/formatDate seam every cron processor uses; nothing calls
// Date.now. Diff-before-emit: a byte-identical render of both files emits no
// patch.

import {
  diagnosticEffect,
  patchEffect,
  type DiagnosticEffect,
  type Effect,
  type FileChangeInput,
} from "../../../../src/core/effect";
import { compareStrings } from "../../../../src/core/compare";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";
import { formatDate, localDateParts } from "../../dome.daily/processors/daily-paths";

import {
  countLines,
  extractUpdated,
  lastVisitByPage,
  OVERSIZED_LINES,
  parsePatrolLedger,
  PATROL_LEDGER_PATH,
  PATROL_QUEUE_PATH,
  PATROL_SCAN_PREFIXES,
  QUEUE_LIMIT,
  renderPatrolLedger,
  renderPatrolQueue,
  RETENTION_DAYS,
  REVISIT_DAYS,
  selectStalest,
  withoutMd,
  type PatrolCandidate,
} from "../lib/patrol";

const OVERSIZED_CODE = "dome.agent.page.oversized";

const patrol = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const today = formatDate(localDateParts(ctx.now()));
    const effects: Effect[] = [];

    // Scan the three page families for staleness + oversize.
    const scanned = (await ctx.snapshot.listMarkdownFiles())
      .filter((p) => PATROL_SCAN_PREFIXES.some((prefix) => p.startsWith(prefix)))
      .sort(compareStrings);

    const candidates: PatrolCandidate[] = [];
    for (const path of scanned) {
      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;
      const lineCount = countLines(content);

      // Oversized nudge: independent of staleness (size is size). Stable
      // page-path SourceRef so the diagnostic self-clears when the page shrinks.
      if (lineCount > OVERSIZED_LINES) {
        effects.push(oversizedDiagnostic(ctx, path, lineCount));
      }

      const updated = extractUpdated(content);
      if (updated === null) continue; // no `updated:` → skipped from the queue
      candidates.push(
        Object.freeze({ page: withoutMd(path), updated, lineCount }),
      );
    }

    // Select the stalest eligible pages and record tonight's visit.
    const ledgerContent = (await ctx.snapshot.readFile(PATROL_LEDGER_PATH)) ?? "";
    const existingVisits = parsePatrolLedger(ledgerContent);
    const selected = selectStalest({
      candidates,
      lastVisit: lastVisitByPage(existingVisits),
      today,
      revisitDays: REVISIT_DAYS,
      limit: QUEUE_LIMIT,
    });

    const nextQueue = renderPatrolQueue(selected);
    const nextLedger = renderPatrolLedger({
      existingVisits,
      selectedPages: selected.map((c) => c.page),
      today,
      retentionDays: RETENTION_DAYS,
    });

    // Diff-before-emit: rewrite only the file(s) whose bytes changed; a
    // byte-identical render of both emits no patch at all.
    const curQueue = await ctx.snapshot.readFile(PATROL_QUEUE_PATH);
    const changes: FileChangeInput[] = [];
    if (nextQueue !== curQueue) {
      changes.push({ kind: "write", path: PATROL_QUEUE_PATH, content: nextQueue });
    }
    if (nextLedger !== ledgerContent) {
      changes.push({ kind: "write", path: PATROL_LEDGER_PATH, content: nextLedger });
    }

    if (changes.length > 0) {
      effects.push(
        patchEffect({
          mode: "auto",
          changes,
          reason: `dome.agent.patrol: queue ${selected.length} stalest page(s) for review`,
          sourceRefs: patrolSourceRefs(ctx, selected),
        }),
      );
    }

    return Object.freeze(effects);
  },
});

export default patrol;

function oversizedDiagnostic(
  ctx: ProcessorContext,
  path: string,
  lineCount: number,
): DiagnosticEffect {
  return diagnosticEffect({
    severity: "info",
    code: OVERSIZED_CODE,
    message:
      `\`${path}\` is ${lineCount} lines — well past the ${OVERSIZED_LINES}-line ` +
      "mark. Consider splitting it into focused, cohesive pages; this nudge " +
      "clears itself once the page shrinks.",
    // Stable subject: the page path with NO line range, so the subject_hash is
    // invariant under edits and the diagnostic self-clears on shrink.
    sourceRefs: [ctx.sourceRef(path)],
  });
}

/**
 * Evidence for the queue/ledger patch: the two meta files plus each queued
 * page (the pages the queue points consolidate at).
 */
function patrolSourceRefs(
  ctx: ProcessorContext,
  selected: ReadonlyArray<PatrolCandidate>,
): ReadonlyArray<SourceRef> {
  return [
    ctx.sourceRef(PATROL_QUEUE_PATH),
    ctx.sourceRef(PATROL_LEDGER_PATH),
    ...selected.map((c) => ctx.sourceRef(`${c.page}.md`)),
  ];
}
