// dome.agent.sweep-answer — deterministic answer handler for the nightly sweep.
//
// Matches questions in TWO key namespaces under the shared `dome.agent.sweep:`
// prefix (the trigger matches both; this handler discriminates by key segment):
//
//   dome.agent.sweep:uncertain:<material>-><dest>
//     Options ["integrate", "skip"]. On "integrate": reads the destination from
//     the snapshot, appends metadata.proposedSection as a dated section (in
//     house style), and runs ensureSourcesLink — emitting one auto PatchEffect.
//     On "skip": no effects (the `questioned` ledger row already prevents
//     re-queueing).
//
//   dome.agent.sweep:escalate:<material>-><dest>
//     Options ["skip"] only; no proposedSection in metadata. The answer itself
//     closes the question — the pair is already settled in the ledger (an
//     `escalated` row for the repeated-failure threshold; a `questioned` row
//     for the oversized-page guards), so this handler records nothing for any
//     answer value and never re-queues the pair. Re-eligibility after an
//     escalation is deliberately manual: the owner hand-deletes the
//     `escalated` row from the ledger (no retry-granted flow).
//
// Settlement note: for uncertain→integrate, no ledger update is emitted here.
// The pair's `:: questioned` row already prevents re-queueing by the sweep
// queue's ledger-settlement logic, and once the destination patch lands,
// settlement-by-sources (the sources: wikilink) is authoritative. The ledger
// row is the advisory gate; the sources: link is the durable record.
//
// Retry-idempotence: the handler is invoked at-least-once (the engine can
// re-dispatch after a post-adoption failure window). Before composing an
// append patch the handler checks whether `proposedSection.trim()` is already
// present in the destination content. If it is, no second append is emitted;
// `ensureSourcesLink` is still called, and a patch is emitted only if the
// sources link was missing — exactly recovering the link-only failure mode.
//
// Deterministic — no model.invoke. The manifest omits `execution: class:
// deterministic` because both answer-triggered garden processors in this bundle
// (this one and preference-promotion-answer) uniformly omit it; the broker
// defaults to the declared class when absent and the schema permits it. Adding
// the field for this processor alone would be asymmetric with the sibling.

import {
  diagnosticEffect,
  patchEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import { parseAnswerInput } from "../lib/answer-input";

import { ensureSourcesLink } from "./sweep";

// ----- Key discrimination ----------------------------------------------------

const UNCERTAIN_PREFIX = "dome.agent.sweep:uncertain:";
const ESCALATE_PREFIX = "dome.agent.sweep:escalate:";

type KeyKind = "uncertain" | "escalate" | "unknown";

function discriminateKey(key: string): KeyKind {
  if (key.startsWith(UNCERTAIN_PREFIX)) return "uncertain";
  if (key.startsWith(ESCALATE_PREFIX)) return "escalate";
  return "unknown";
}

// Input envelope parsing (question + answer + answeredAt) is shared via
// lib/answer-input.ts — see parseAnswerInput.

// ----- Metadata validation for uncertain→integrate ---------------------------

type UncertainMetadata = {
  readonly destination: string;
  readonly material: string;
  readonly proposedSection: string;
};

function parseUncertainMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): UncertainMetadata | null {
  if (metadata === undefined) return null;
  const { destination, material, proposedSection } = metadata;
  if (
    typeof destination !== "string" ||
    destination.length === 0 ||
    typeof material !== "string" ||
    material.length === 0 ||
    typeof proposedSection !== "string" ||
    proposedSection.trim().length === 0
  ) {
    return null;
  }
  return Object.freeze({ destination, material, proposedSection });
}

// ----- Section composition ---------------------------------------------------

/**
 * Derive a YYYY-MM-DD date from the material path (same logic as sweep-queue's
 * `materialDateFromPath`): parse from the filename. Falls back to the answer
 * date's YYYY-MM-DD slice when no date is found in the filename.
 */
function materialDateFromPath(materialPath: string, answeredAt: string): string {
  // wiki/dailies/YYYY-MM-DD.md
  const dailyMatch = /wiki\/dailies\/(\d{4}-\d{2}-\d{2})\.md$/.exec(materialPath);
  if (dailyMatch?.[1] !== undefined) return dailyMatch[1];
  // inbox/processed/YYYY-MM-DD... or any filename starting with a date
  const prefixMatch = /(\d{4}-\d{2}-\d{2})/.exec(materialPath);
  if (prefixMatch?.[1] !== undefined) return prefixMatch[1];
  return answeredAt.slice(0, 10);
}

/**
 * Format the proposedSection for appending: if it already starts with a `## `
 * heading it is used verbatim; otherwise it is wrapped under a generic heading.
 */
function formatSection(
  proposedSection: string,
  materialDate: string,
): string {
  const trimmed = proposedSection.trim();
  if (trimmed.startsWith("## ")) {
    // Verbatim — owner approved this section as-is.
    return `\n\n${trimmed}`;
  }
  // Wrap under a dated heading in house style.
  return `\n\n## ${materialDate} — integrated on owner approval\n\n${trimmed}`;
}

// ----- The processor ---------------------------------------------------------

const sweepAnswer = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const input = parseAnswerInput(ctx.input);
    if (input === null) {
      return [
        diagnosticEffect({
          severity: "warning",
          code: "dome.agent.sweep-answer-invalid",
          message:
            "dome.agent.sweep-answer received a malformed answer envelope " +
            "(missing or wrong-typed question / answer / answeredAt fields).",
          sourceRefs: [],
        }),
      ];
    }

    const key = input.question.idempotencyKey;
    const keyKind = discriminateKey(key);

    if (keyKind === "unknown") {
      return [
        diagnosticEffect({
          severity: "warning",
          code: "dome.agent.sweep-answer-invalid",
          message:
            `dome.agent.sweep-answer received an answer with an unrecognized key shape: "${key}". ` +
            "Expected a key starting with dome.agent.sweep:uncertain: or dome.agent.sweep:escalate:",
          sourceRefs: input.question.sourceRefs,
        }),
      ];
    }

    // Escalation questions carry only "skip"; the answer itself closes the
    // question and the ledger row (escalated for the failure threshold,
    // questioned for the size guards) already settles the pair — nothing to
    // emit, nothing re-queues. The owner re-arms an escalated pair only by
    // hand-deleting its row from the ledger.
    if (keyKind === "escalate") {
      return Object.freeze([]);
    }

    // --- uncertain namespace ---

    const answer = input.answer.trim().toLowerCase();

    if (answer === "skip") {
      // The `questioned` ledger row already prevents re-queueing; nothing more
      // to do.
      return Object.freeze([]);
    }

    if (answer !== "integrate") {
      // Unknown answer value — no effects.
      return Object.freeze([]);
    }

    // answer === "integrate": validate metadata and land the patch.
    const meta = parseUncertainMetadata(input.question.metadata);
    if (meta === null) {
      return [
        diagnosticEffect({
          severity: "warning",
          code: "dome.agent.sweep-answer-invalid",
          message:
            `dome.agent.sweep-answer: integrate answer for key "${key}" is missing valid metadata ` +
            "(required: destination (string), material (string), proposedSection (non-empty string)).",
          sourceRefs: input.question.sourceRefs,
        }),
      ];
    }

    // Defensive: destination must be under wiki/ (sweep only asks about granted
    // destinations, so this is a belt-and-suspenders check — outside → warn, no patch).
    if (!meta.destination.startsWith("wiki/")) {
      return [
        diagnosticEffect({
          severity: "warning",
          code: "dome.agent.sweep-answer-invalid",
          message:
            `dome.agent.sweep-answer: destination "${meta.destination}" is outside the wiki/ tree; ` +
            "refusing to patch (sweep write grant only covers wiki/entities/** and wiki/concepts/**).",
          sourceRefs: input.question.sourceRefs,
        }),
      ];
    }

    const existingContent = await ctx.snapshot.readFile(meta.destination);
    if (existingContent === null) {
      return [
        diagnosticEffect({
          severity: "warning",
          code: "dome.agent.sweep-answer-missing-destination",
          message:
            `dome.agent.sweep-answer: destination "${meta.destination}" was not found in the snapshot; ` +
            "the integration patch was not emitted.",
          sourceRefs: input.question.sourceRefs,
        }),
      ];
    }

    const materialDate = materialDateFromPath(meta.material, input.answeredAt);
    const section = formatSection(meta.proposedSection, materialDate);

    // Retry-idempotent presence guard: if the proposed section (trimmed) is
    // already present in the destination, skip the append and only guarantee
    // the sources link. This handles the at-least-once retry window
    // (src/engine/host/question-answering.ts:34-37, 67-70) without double-appending.
    const trimmedProposed = meta.proposedSection.trim();
    if (existingContent.includes(trimmedProposed)) {
      const relinked = ensureSourcesLink(existingContent, meta.material);
      if (relinked === existingContent) return Object.freeze([]);
      return [
        patchEffect({
          mode: "auto",
          changes: [
            {
              kind: "write",
              path: meta.destination,
              content: relinked,
            },
          ],
          reason:
            `dome.agent.sweep-answer: retry — section already present, ensuring sources link for ${meta.material} in ${meta.destination}`,
          sourceRefs: [
            ctx.sourceRef(meta.material),
            ctx.sourceRef(meta.destination),
          ],
        }),
      ];
    }

    // First-time append: compose the section, then guarantee the sources: link.
    // Preserve the file's trailing newline: end the output with exactly "\n".
    const base = existingContent.trimEnd();
    const withSection = base + section + "\n";
    const nextContent = ensureSourcesLink(withSection, meta.material);

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
          `dome.agent.sweep-answer: owner-approved integration of ${meta.material} into ${meta.destination}`,
        sourceRefs: [
          ctx.sourceRef(meta.material),
          ctx.sourceRef(meta.destination),
        ],
      }),
    ];
  },
});

export default sweepAnswer;
