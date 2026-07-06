// engine/operational/question-expiry: release OPEN questions whose subject
// processor no longer exists.
//
// A QuestionEffect's "subject" is whichever processor the question is
// actually about: the emitting `processor_id` by default, or
// `metadata.subjectProcessorId` when the emitter is asking on behalf of a
// different processor (the health-recovery shape — e.g.
// `dome.health.quarantine-recovery-questions` asking about the quarantined
// processor's id). When a bundle retires, its questions can never be answered
// through the normal flow (no handler will ever run for it again) and would
// otherwise re-render forever. This pump releases them.
//
// `dome.health.orphan-run-recovery-questions` is a deliberate exception: it
// never stamps `subjectProcessorId`, even though its question names a stuck
// run's processor. The run row in runs.db outlives that processor's
// retirement, and the recovery question is the run's ONLY disposition path
// (`fail` is how the row ever leaves `running`) — expiring it on the
// retired-subject rule would durably answer it "expired" and leave the run
// permanently undisposable. Only the emitter itself (always active while
// dome.health is installed) is checked for that question's subject.
//
// Deliberately NOT a mirror of `question-auto-resolution.ts`'s handler
// dispatch: there is no handler to run for a retired subject, so expiry
// writes the durable answer row directly (`answer: "expired"`,
// `answered_by: "expired"`) and marks it `handler_status: "handled"` without
// ever calling `runAnswerHandlers`. It also does not honor a question's
// `options` allow-list — "expired" is an engine-forced terminal state, not a
// value the emitting processor offered.
//
// Cheap and idempotent: only OPEN questions are read each pass, and once a
// row is expired it carries `answered_at`, so it drops out of the open set
// and a subsequent pass is a no-op.
//
// Disabled-bundle exemption (mirrors the quarantine GC's posture pinned by
// `isKnownProcessorFor` in src/engine/host/vault-runtime.ts, main commit
// 28b912d3 "registry is authoritative for enabled bundles"): a
// configured-but-DISABLED bundle's processors are deliberately absent from
// the resolved registry, but the bundle is still installed — re-enabling it
// must find its open questions intact. So a subject is RETIRED only when it
// is absent from the registry AND not covered by a disabled-extension
// prefix. For enabled bundles the registry is authoritative: an unregistered
// processor id under an enabled bundle means the processor was deleted, and
// its questions expire.

import type { AnswersDb } from "../../answers/db";
import {
  markAnswerHandlersHandled,
  recordQuestionAnswer,
} from "../../answers/question-answers";
import { diagnosticEffect, type DiagnosticEffect } from "../../core/effect";
import type { ApplyEffectSinks } from "../core/apply-effect";
import { recordDiagnosticsViaSink } from "../core/diagnostics";
import type { ProjectionDb } from "../../projections/db";
import {
  applyQuestionAnswer,
  queryQuestionRecords,
  type QuestionRecord,
} from "../../projections/questions";
import type { ProcessorRegistry } from "../../processors/registry";

export type QuestionExpiryDeps = {
  /** Active processor ids — a question whose subject is absent expires. */
  readonly registry: ProcessorRegistry;
  /**
   * Extension ids configured but DISABLED (`ExtensionPolicyStatus.enabled ===
   * false`). Their processors are absent from the registry by design and are
   * EXEMPT from expiry — the same conservative prefix escape the quarantine
   * GC's `isKnownProcessorFor` grants them. Empty array → the registry is
   * fully authoritative.
   */
  readonly disabledExtensionIds: ReadonlyArray<string>;
  /** The questions store accessor, same handle `question-auto-resolution.ts` reads. */
  readonly questions: ProjectionDb;
  readonly answers: AnswersDb;
  readonly recordDiagnostic: ApplyEffectSinks["recordDiagnostic"];
  readonly now: () => Date;
};

export type QuestionExpiryResult = {
  readonly expired: number;
  /**
   * The expiry diagnostics, ALSO recorded through `recordDiagnostic` — the
   * scheduler.ts dual pattern, so `runOperationalWork` callers (sync --json
   * counts, serve lines) see them without re-reading the sink.
   */
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
};

const EXPIRY_PROCESSOR_ID = "engine.question-expiry";

/**
 * Expire every OPEN question whose subject processor (the emitting
 * `processor_id`, or `metadata.subjectProcessorId` when set) is retired —
 * absent from the active registry and not exempted by a disabled-extension
 * prefix. Writes a durable answer row (`answer: "expired"`,
 * `answered_by: "expired"`, `handler_status: "handled"`), mirrors it onto the
 * rebuildable projection row, and raises one info diagnostic per expiry.
 */
export async function expireOrphanSubjectQuestions(
  deps: QuestionExpiryDeps,
): Promise<QuestionExpiryResult> {
  const openQuestions = queryQuestionRecords(deps.questions, {
    resolved: false,
  });

  let expired = 0;
  const diagnostics: DiagnosticEffect[] = [];
  for (const question of openQuestions) {
    const retiredSubject = retiredSubjectOf(question, deps);
    if (retiredSubject === null) continue;

    expireQuestion(question, deps);
    const diagnostic = diagnosticEffect({
      severity: "info",
      code: "question.expired-subject-retired",
      message:
        `Question ${question.id} expired: subject processor ` +
        `${retiredSubject} is retired.`,
      sourceRefs: question.effect.sourceRefs,
    });
    diagnostics.push(diagnostic);
    await recordDiagnosticsViaSink({
      sinks: { recordDiagnostic: deps.recordDiagnostic },
      diagnostics: [diagnostic],
      processorId: EXPIRY_PROCESSOR_ID,
      proposalId: null,
    });
    expired += 1;
  }

  return Object.freeze({
    expired,
    diagnostics: Object.freeze([...diagnostics]),
  });
}

/**
 * The retired processor id a question's subject resolves to, or `null` when
 * every subject is still live (registered, or exempt under a
 * disabled-extension prefix). The emitting processor is checked first: a
 * retired emitter always expires its own questions regardless of
 * `subjectProcessorId`.
 */
function retiredSubjectOf(
  question: QuestionRecord,
  deps: Pick<QuestionExpiryDeps, "registry" | "disabledExtensionIds">,
): string | null {
  if (isRetired(question.processorId, deps)) return question.processorId;
  const subjectProcessorId = question.effect.metadata?.subjectProcessorId;
  if (subjectProcessorId !== undefined && isRetired(subjectProcessorId, deps)) {
    return subjectProcessorId;
  }
  return null;
}

/**
 * Mirror of the quarantine GC's known-processor predicate
 * (`isKnownProcessorFor`, src/engine/host/vault-runtime.ts): registered →
 * live; unregistered but under a configured-but-disabled bundle's prefix →
 * live (exempt); otherwise retired. Processor ids are bundle-namespaced
 * (`<extensionId>.<name>`), matching that predicate's prefix convention.
 */
function isRetired(
  processorId: string,
  deps: Pick<QuestionExpiryDeps, "registry" | "disabledExtensionIds">,
): boolean {
  if (deps.registry.get(processorId) !== undefined) return false;
  return !deps.disabledExtensionIds.some(
    (extensionId) =>
      processorId === extensionId ||
      processorId.startsWith(`${extensionId}.`),
  );
}

/**
 * Write the durable + projection answer rows directly (not through
 * `answerQuestionDurably`): that helper rejects answers outside the
 * question's `options` allow-list, which is exactly right for real answers
 * but wrong here — "expired" is an engine-forced terminal state a question's
 * own options never offer.
 */
function expireQuestion(question: QuestionRecord, deps: QuestionExpiryDeps): void {
  const answeredAt = deps.now().toISOString();
  recordQuestionAnswer(deps.answers, {
    idempotencyKey: question.effect.idempotencyKey,
    answer: "expired",
    answeredAt,
    questionId: question.id,
    question: question.effect.question,
    processorId: question.processorId,
    adoptedCommit: question.adoptedCommit,
    answeredBy: "expired",
  });
  applyQuestionAnswer(deps.questions, {
    idempotencyKey: question.effect.idempotencyKey,
    answer: "expired",
    answeredAt,
    answeredBy: "expired",
  });
  markAnswerHandlersHandled(deps.answers, {
    idempotencyKey: question.effect.idempotencyKey,
    handledAt: answeredAt,
  });
}
