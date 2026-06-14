// dome.agent.preference-promotion-answer — the gated core.md writer that
// owns the promoted-preferences block (memory-quality M5,
// docs/wiki/specs/preferences.md §"Two gated writers, block-scoped";
// memory decision 4: the question WAS the review).
//
// On `promote`: re-derives the topic's candidate state from the CURRENT
// snapshot, verifies the rule hash in the question's idempotency key still
// matches (a stale question — signals moved on — yields an info diagnostic
// and no write), and emits one PatchEffect (mode auto) splicing the rule
// into core.md's marker-delimited promoted-preferences block (sorted, one
// line per topic, confidence recomputed at answer time).
//
// On `reject`: appends the rejection tombstone
// (`- YYYY-MM-DD - <topic>:: rejected by owner`) to preferences/signals.md;
// the counter parses it as a permanent owner rejection, so the topic is
// never re-proposed.
//
// Grant shape: this processor's manifest declares read + patch.auto over
// exactly core.md + preferences/signals.md, and the vault config gives it a
// matching narrow per-processor replacement grant — the broker resolves
// grants per processor, so no other processor can auto-write core.md.
// Idempotent under answer-handler retries: a splice/tombstone that is
// already present emits no effect.

import {
  diagnosticEffect,
  patchEffect,
  type Effect,
} from "../../../../src/core/effect";
import { generatedBlockAnomalyDiagnostics } from "../../../../src/core/generated-block-diagnostics";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

import { parseAnswerInput, type AnswerInput } from "../lib/answer-input";
import { coreMemoryPath } from "../lib/core-memory";
import {
  appendSignalLine,
  collectPreferenceTopics,
  demotionSignalLine,
  demotionTargetFromKey,
  fnv1aHex,
  PREFERENCE_SIGNALS_PATH,
  PROMOTED_PREFERENCES_BLOCK,
  promotedPreferenceEntries,
  promotionTargetFromKey,
  reaffirmationSignalLine,
  rejectionTombstoneLine,
  removePromotedPreference,
  splicePromotedPreference,
} from "../lib/preferences-shared";

const preferencePromotionAnswer = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const input = parseAnswerInput(ctx.input);
    if (input === null) {
      return [
        diagnosticEffect({
          severity: "error",
          code: "dome.agent.preference-promotion-answer.invalid-answer-input",
          message:
            "Preference promotion answer handler received an invalid answer envelope.",
          sourceRefs: [],
        }),
      ];
    }

    const answer = input.answer.trim().toLowerCase();

    // Demotion keys (WS1 pruning) route to the second answer path — same
    // gated writer, same narrow grant, different key family. Both parsers
    // ignore the trailing signal-epoch segment (and tolerate legacy
    // un-salted keys): the handler re-derives all state from the current
    // snapshot, so the epoch matters only for question identity.
    const demotionTarget = demotionTargetFromKey(input.question.idempotencyKey);
    if (demotionTarget !== null) {
      if (answer !== "demote" && answer !== "keep") return Object.freeze([]);
      return handleDemotionAnswer({ ctx, input, target: demotionTarget, answer });
    }

    const target = promotionTargetFromKey(input.question.idempotencyKey);
    if (target === null || (answer !== "promote" && answer !== "reject")) {
      return Object.freeze([]);
    }

    const corePath = coreMemoryPath(ctx.extensionConfig).path;
    const signalsContent = await ctx.snapshot.readFile(
      PREFERENCE_SIGNALS_PATH,
    );
    const coreContent = await ctx.snapshot.readFile(corePath);

    if (answer === "reject") {
      const tombstone = rejectionTombstoneLine({
        date: input.answeredAt.slice(0, 10),
        topic: target.topic,
      });
      // Retry-idempotent: an already-recorded rejection is a no-op.
      if (
        signalsContent !== null &&
        signalsContent
          .split("\n")
          .some((line) => line.trim() === tombstone)
      ) {
        return Object.freeze([]);
      }
      return [
        patchEffect({
          mode: "auto",
          changes: [
            {
              kind: "write",
              path: PREFERENCE_SIGNALS_PATH,
              content: appendSignalLine(signalsContent, tombstone),
            },
          ],
          reason: `dome.agent: owner rejected preference promotion for topic "${target.topic}"`,
          sourceRefs: input.question.sourceRefs,
        }),
      ];
    }

    // promote — re-derive the candidate from the current snapshot and verify
    // the question still describes it.
    //
    // Marker anomalies in core.md (a hand-duplicated promoted-preferences
    // pair, a half-open marker) are ignored by the line-anchored splice but
    // surfaced as info diagnostics so the damage is visible (dedup at the
    // diagnostics sink keeps retries quiet).
    const anomalyDiagnostics = coreAnomalyDiagnostics(
      ctx,
      corePath,
      coreContent,
    );
    const collection = collectPreferenceTopics({ signalsContent, coreContent });
    const topic = collection.topics.find((t) => t.topic === target.topic);
    if (
      topic === undefined ||
      topic.rule === null ||
      topic.ruleHash !== target.ruleHash
    ) {
      return [
        ...anomalyDiagnostics,
        diagnosticEffect({
          severity: "info",
          code: "dome.agent.preference-promotion-answer.stale-question",
          message:
            `Promotion answer for topic "${target.topic}" no longer matches the signals page ` +
            "(the candidate rule changed or its signals are gone); nothing was promoted. " +
            "A current candidate will raise a fresh question.",
          sourceRefs: input.question.sourceRefs,
        }),
      ];
    }
    if (topic.state === "rejected") {
      // An owner rejection recorded after the question was asked wins.
      return Object.freeze([...anomalyDiagnostics]);
    }

    const next = splicePromotedPreference({
      coreContent,
      topic: topic.topic,
      rule: topic.rule,
      confidence: topic.confidence,
    });
    // Retry-idempotent: re-promoting an identical entry is a no-op.
    if (coreContent !== null && next === coreContent) {
      return Object.freeze([...anomalyDiagnostics]);
    }
    return [
      ...anomalyDiagnostics,
      patchEffect({
        mode: "auto",
        changes: [{ kind: "write", path: corePath, content: next }],
        reason: `dome.agent: promote owner preference "${topic.topic}" into ${corePath}`,
        sourceRefs: input.question.sourceRefs,
      }),
    ];
  },
});

export default preferencePromotionAnswer;

/**
 * The demotion answer path (WS1 pruning, preferences.md §"Demotion").
 *
 * Stale-question guard: the promoted block is re-read from the CURRENT
 * snapshot — the topic must still carry an entry whose rule text hashes to
 * the question key's hash. A vanished or re-promoted (drifted) entry yields
 * the same info diagnostic as a stale promotion, and no write.
 *
 * `demote` splices the entry out of the block AND appends the demotion minus
 * signal — deliberately NOT the rejection tombstone, so the topic re-earns
 * candidacy if supporting corrections re-accrue. `keep` appends a fresh plus
 * signal reaffirming the block's rule verbatim (freshness resets, confidence
 * climbs back over the floor, the open question family is satisfied).
 *
 * Both paths are retry-idempotent: an already-applied change set degrades
 * change-by-change to nothing (entry already gone + signal already present →
 * zero effects).
 */
async function handleDemotionAnswer(opts: {
  readonly ctx: ProcessorContext;
  readonly input: AnswerInput;
  readonly target: { readonly topic: string; readonly ruleHash: string };
  readonly answer: "demote" | "keep";
}): Promise<ReadonlyArray<Effect>> {
  const { ctx, input, target, answer } = opts;
  const corePath = coreMemoryPath(ctx.extensionConfig).path;
  const signalsContent = await ctx.snapshot.readFile(PREFERENCE_SIGNALS_PATH);
  const coreContent = await ctx.snapshot.readFile(corePath);
  const anomalyDiagnostics = coreAnomalyDiagnostics(ctx, corePath, coreContent);

  const entry = promotedPreferenceEntries(coreContent).find(
    (candidate) => candidate.topic === target.topic,
  );
  const date = input.answeredAt.slice(0, 10);
  const minusLine = demotionSignalLine({ date, topic: target.topic });
  const minusPresent = hasSignalLine(signalsContent, minusLine);

  if (entry === undefined || fnv1aHex(entry.rule) !== target.ruleHash) {
    // Retry-idempotent demote: the entry is already gone and the minus
    // signal already recorded — the answer fully landed; zero effects.
    if (answer === "demote" && entry === undefined && minusPresent) {
      return Object.freeze([...anomalyDiagnostics]);
    }
    return [
      ...anomalyDiagnostics,
      diagnosticEffect({
        severity: "info",
        code: "dome.agent.preference-promotion-answer.stale-question",
        message:
          `Demotion answer for topic "${target.topic}" no longer matches core.md's promoted block ` +
          "(the entry was removed or its rule changed since the question was asked); nothing was written. " +
          "A still-decayed entry will raise a fresh question.",
        sourceRefs: input.question.sourceRefs,
      }),
    ];
  }

  if (answer === "keep") {
    const plusLine = reaffirmationSignalLine({
      date,
      topic: target.topic,
      rule: entry.rule,
    });
    // Retry-idempotent: the exact same-day reaffirmation is a no-op.
    if (hasSignalLine(signalsContent, plusLine)) {
      return Object.freeze([...anomalyDiagnostics]);
    }
    return [
      ...anomalyDiagnostics,
      patchEffect({
        mode: "auto",
        changes: [
          {
            kind: "write",
            path: PREFERENCE_SIGNALS_PATH,
            content: appendSignalLine(signalsContent, plusLine),
          },
        ],
        reason: `dome.agent: owner kept decayed preference "${target.topic}" — reaffirming signal appended`,
        sourceRefs: input.question.sourceRefs,
      }),
    ];
  }

  // demote — splice the entry out and record the minus signal; each change
  // lands only when still needed (partial-retry safe).
  const changes: Array<{
    readonly kind: "write";
    readonly path: string;
    readonly content: string;
  }> = [];
  if (coreContent !== null) {
    const nextCore = removePromotedPreference({
      coreContent,
      topic: target.topic,
    });
    if (nextCore !== coreContent) {
      changes.push({ kind: "write", path: corePath, content: nextCore });
    }
  }
  if (!minusPresent) {
    changes.push({
      kind: "write",
      path: PREFERENCE_SIGNALS_PATH,
      content: appendSignalLine(signalsContent, minusLine),
    });
  }
  if (changes.length === 0) return Object.freeze([...anomalyDiagnostics]);
  return [
    ...anomalyDiagnostics,
    patchEffect({
      mode: "auto",
      changes,
      reason: `dome.agent: owner demoted decayed preference "${target.topic}" out of ${corePath}`,
      sourceRefs: input.question.sourceRefs,
    }),
  ];
}

function hasSignalLine(content: string | null, line: string): boolean {
  return (
    content !== null &&
    content.split("\n").some((candidate) => candidate.trim() === line)
  );
}

/**
 * Marker anomalies in core.md (a hand-duplicated promoted-preferences pair,
 * a half-open marker) are ignored by the line-anchored splice but surfaced
 * as info diagnostics so the damage is visible (dedup at the diagnostics
 * sink keeps retries quiet).
 */
function coreAnomalyDiagnostics(
  ctx: ProcessorContext,
  corePath: string,
  coreContent: string | null,
): ReadonlyArray<Effect> {
  if (coreContent === null) return Object.freeze([]);
  return generatedBlockAnomalyDiagnostics({
    content: coreContent,
    path: corePath,
    code: "dome.agent.generated-block-anomaly",
    blocks: [PROMOTED_PREFERENCES_BLOCK],
    sourceRef: (path, range) => ctx.sourceRef(path, range),
  });
}

// Input envelope parsing (question + answer + answeredAt) is shared via
// lib/answer-input.ts — see parseAnswerInput / AnswerInput.
