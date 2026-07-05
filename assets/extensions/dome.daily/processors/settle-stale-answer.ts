// dome.daily.settle-stale-answer — deterministic answer handler for the
// stale-task warden's settle-stale questions.
//
// Matches questions with idempotencyKey prefix "dome.daily.settle-stale:".
// Reads metadata.destination (vault path of the source file) and
// metadata.material (the ^anchor id of the task line) from the question
// metadata, then locates the task line by scanning for a trailing ` ^<anchor>`
// and applies the owner's disposition:
//
//   close  — changes the leading `- [ ]` checkbox to `- [-]` (cancelled).
//            Retry-idempotent: if the line is already non-open (not `- [ ]`),
//            no patch is emitted.
//
//   defer  — moves the `📅 YYYY-MM-DD` due date forward by DEFER_DAYS (= 7)
//            days from ctx.now(). If no date is present, appends one. The
//            origin marker ([↗](...)) and ^anchor are preserved; the anchor
//            stays the trailing token (split via parseBlockAnchor, edit body,
//            re-append anchor).
//
//   keep   — no effects. The owner has acknowledged the task is intentionally
//            open; the idempotencyKey settles the question without any rewrite.
//
// Deterministic — no model.invoke. Grant: patch.auto only (no graph.write).
// Mirror: assets/extensions/dome.agent/processors/sweep-answer.ts

import {
  diagnosticEffect,
  patchEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

import { parseAnswerInput } from "../../dome.agent/lib/answer-input";
import { formatDate, localDateParts } from "./daily-paths";
import { findAnchorLine, setCheckboxMark, setDueDate } from "./task-disposition";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Days to push the due date forward on a "defer" answer. */
export const DEFER_DAYS = 7;

// ---------------------------------------------------------------------------
// Metadata parsing
// ---------------------------------------------------------------------------

type StaleAnswerMetadata = {
  readonly destination: string;
  readonly material: string; // the ^anchor id
};

function parseStaleMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): StaleAnswerMetadata | null {
  if (metadata === undefined) return null;
  const { destination, material } = metadata;
  if (
    typeof destination !== "string" ||
    destination.length === 0 ||
    typeof material !== "string" ||
    material.length === 0
  ) {
    return null;
  }
  return Object.freeze({ destination, material });
}

// ---------------------------------------------------------------------------
// Line-level helpers
// ---------------------------------------------------------------------------

/**
 * Advance a `Date` by `days` days (UTC-safe: operates on epoch ms).
 * Returns the result as a YYYY-MM-DD string in LOCAL time (consistent with
 * dome's vault-date policy — see daily-paths.ts `localDateParts`).
 */
function addDays(base: Date, days: number): string {
  const next = new Date(base.getTime() + days * 86_400_000);
  return formatDate(localDateParts(next));
}

// The mechanical line transforms (find-by-anchor, flip-if-open, rewrite-📅)
// live in the shared pure `task-disposition` module so `performSettle` shares
// them. This processor owns only the disposition SEMANTICS: "close" cancels
// (`[-]`), and "defer" pushes the date forward by DEFER_DAYS from ctx.now().

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

const settleStaleAnswer = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const input = parseAnswerInput(ctx.input);
    if (input === null) {
      return [
        diagnosticEffect({
          severity: "warning",
          code: "dome.daily.settle-stale-answer-invalid",
          message:
            "dome.daily.settle-stale-answer received a malformed answer envelope " +
            "(missing or wrong-typed question / answer / answeredAt fields).",
          sourceRefs: [],
        }),
      ];
    }

    // Validate metadata
    const meta = parseStaleMetadata(input.question.metadata);
    if (meta === null) {
      return [
        diagnosticEffect({
          severity: "warning",
          code: "dome.daily.settle-stale-answer-invalid",
          message:
            `dome.daily.settle-stale-answer: question "${input.question.idempotencyKey}" ` +
            "is missing valid metadata (required: destination (string), material (string)).",
          sourceRefs: input.question.sourceRefs,
        }),
      ];
    }

    const answer = input.answer.trim().toLowerCase();

    // "keep" — owner acknowledged, nothing to write.
    if (answer === "keep") {
      return Object.freeze([]);
    }

    // Unknown answer value — no effects (guard against unexpected values).
    if (answer !== "close" && answer !== "defer") {
      return Object.freeze([]);
    }

    // Read the destination file from the snapshot.
    const existingContent = await ctx.snapshot.readFile(meta.destination);
    if (existingContent === null) {
      return [
        diagnosticEffect({
          severity: "warning",
          code: "dome.daily.settle-stale-answer-missing-destination",
          message:
            `dome.daily.settle-stale-answer: destination "${meta.destination}" was not found in the snapshot; ` +
            "the disposition patch was not emitted.",
          sourceRefs: input.question.sourceRefs,
        }),
      ];
    }

    // Locate the task line by anchor (metadata.material = anchor id).
    const lines = existingContent.split("\n");
    const lineIdx = findAnchorLine(lines, meta.material);

    if (lineIdx === -1) {
      return [
        diagnosticEffect({
          severity: "warning",
          code: "dome.daily.settle-stale-answer-anchor-not-found",
          message:
            `dome.daily.settle-stale-answer: anchor "^${meta.material}" was not found in "${meta.destination}"; ` +
            "the task may have been moved or deleted. No patch emitted.",
          sourceRefs: input.question.sourceRefs,
        }),
      ];
    }

    const originalLine = lines[lineIdx]!;
    let rewrittenLine: string | null = null;

    if (answer === "close") {
      // Retry-idempotent: only patch if the line is still open. Close here
      // CANCELS the task (`[-]`); reconcile propagates the cancelled state.
      rewrittenLine = setCheckboxMark(originalLine, "-");
      if (rewrittenLine === null) {
        // Already non-open ([-] or [x]) — nothing to do.
        return Object.freeze([]);
      }
    } else {
      // answer === "defer"
      const newDate = addDays(ctx.now(), DEFER_DAYS);
      rewrittenLine = setDueDate(originalLine, newDate);
      // If the rewrite is identical (somehow), no patch needed.
      if (rewrittenLine === originalLine) return Object.freeze([]);
    }

    const nextLines = [...lines];
    nextLines[lineIdx] = rewrittenLine;
    const nextContent = nextLines.join("\n");

    return [
      patchEffect({
        mode: "auto",
        changes: [
          {
            kind: "write",
            path: meta.destination,
            content: nextContent,
          },
        ],
        reason:
          `dome.daily.settle-stale-answer: "${answer}" applied to task ^${meta.material} in ${meta.destination}`,
        sourceRefs: [
          ctx.sourceRef(meta.destination),
          ...input.question.sourceRefs,
        ],
      }),
    ];
  },
});

export default settleStaleAnswer;
