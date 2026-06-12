// Shared run-state → effects epilogue for dome.agent's agent-loop processors.
//
// Every agent processor ends the same way: map the AgentRunState accumulator
// into one cumulative PatchEffect, surface the agent's questions, and warn
// when the step budget truncated the run. The processors differ only in
// *policy* — ingest applies partial work, consolidate is atomic with a
// per-run changed-file cap, brief composes a custom patch and reuses only
// the question/truncated pieces. `finishAgentRun` encodes the standard tail
// with the cap as an explicit option; the smaller helpers stay exported for
// processors (brief) whose patch construction is bespoke.

import {
  diagnosticEffect,
  patchEffect,
  questionEffect,
  type Effect,
  type FileChangeInput,
} from "../../../../src/core/effect";
import type { SourceRef } from "../../../../src/core/source-ref";
import type { AgentRunResult, AgentRunState } from "./agent-loop";

/** AgentRunState edits → PatchEffect change list (last write per path wins). */
export function agentChanges(
  state: AgentRunState,
): ReadonlyArray<FileChangeInput> {
  return [...state.edits.values()].map((e) =>
    e.kind === "write"
      ? ({ kind: "write", path: e.path, content: e.content } as const)
      : ({ kind: "delete", path: e.path } as const),
  );
}

/** One QuestionEffect per accumulated askOwner question. */
export function agentQuestionEffects(
  state: AgentRunState,
  sourceRefs: ReadonlyArray<SourceRef>,
): ReadonlyArray<Effect> {
  return state.questions.map((q) =>
    questionEffect({
      question: q.question,
      idempotencyKey: q.idempotencyKey,
      sourceRefs,
    }),
  );
}

/** The `dome.agent.truncated` warning, or null when the run finished cleanly. */
export function agentTruncatedEffect(opts: {
  readonly stopReason: AgentRunResult["stopReason"];
  readonly message: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
}): Effect | null {
  if (opts.stopReason !== "budget") return null;
  return diagnosticEffect({
    severity: "warning",
    code: "dome.agent.truncated",
    message: opts.message,
    sourceRefs: opts.sourceRefs,
  });
}

export type AgentRunCap = {
  readonly maxChangedFiles: number;
  /** Diagnostic code for an overreaching run (e.g. `dome.agent.consolidate-overreach`). */
  readonly code: string;
  readonly message: (changedFiles: number) => string;
};

export type AgentRunNoOp = {
  /** Diagnostic code (e.g. `dome.agent.consolidate-no-op`). */
  readonly code: string;
  /** Receives the (truncated) final text excerpt — the only evidence of what the model decided. */
  readonly message: (finalTextExcerpt: string) => string;
  readonly finalText: string | null;
};

const FINAL_TEXT_EXCERPT_CHARS = 300;

/** First ~200 chars of the final text, flattened, appended to the static reason. */
const NARRATIVE_MAX_CHARS = 200;

/**
 * `<static reason>: <flattened final text>` when a final model text exists;
 * the static reason alone otherwise. The narrative ends up in the engine
 * commit body via the PatchEffect's `reason`.
 */
function patchNarrative(
  patchReason: string,
  finalText: string | null | undefined,
): string {
  if (finalText === undefined || finalText === null) return patchReason;
  const flat = finalText.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return patchReason;
  return `${patchReason}: ${flat.slice(0, NARRATIVE_MAX_CHARS)}`;
}

/**
 * The model's final message, bounded for a diagnostic. "(none)" when the
 * model produced no text — still worth surfacing: a no-op with no
 * explanation is the worst case.
 */
export function finalTextExcerpt(finalText: string | null): string {
  if (finalText === null || finalText.trim() === "") return "(none)";
  const text = finalText.trim();
  return text.length <= FINAL_TEXT_EXCERPT_CHARS
    ? text
    : `${text.slice(0, FINAL_TEXT_EXCERPT_CHARS)}…`;
}

/**
 * The standard agent-run epilogue: patch + questions + truncated warning.
 *
 * With `cap`, the run is atomic — exceeding `maxChangedFiles` rolls back ALL
 * edits (partial application would break merge atomicity: a delete could land
 * without its link rewrites) and surfaces the cap diagnostic; the agent's
 * questions still land either way.
 */
export function finishAgentRun(opts: {
  readonly state: AgentRunState;
  readonly stopReason: AgentRunResult["stopReason"];
  readonly sourceRefs: ReadonlyArray<SourceRef>;
  readonly patchReason: string;
  /**
   * The model's final message, when the run produced one. It becomes the
   * patch narrative: the PatchEffect's `reason` rides the engine commit body
   * (NO_ACCRETING_REGISTRIES: git history is the activity log, there is no
   * log.md), so the final text — flattened and bounded — is appended to the
   * static `patchReason`. Absent/blank final text leaves the static reason.
   */
  readonly finalText?: string | null | undefined;
  readonly truncatedMessage: string;
  readonly cap?: AgentRunCap;
  /**
   * Surface a run that ended `final` with zero edits AND zero questions as
   * an info diagnostic carrying the model's final text. Without it such a
   * run records "succeeded" with no trace and the model's reasoning is
   * discarded (the silent-no-op blind spot of 2026-06-10). Info severity:
   * a quiet night is legitimate and must not raise attention.
   */
  readonly noOp?: AgentRunNoOp;
}): ReadonlyArray<Effect> {
  const effects: Effect[] = [];
  const changes = agentChanges(opts.state);

  if (
    opts.noOp !== undefined &&
    opts.stopReason === "final" &&
    changes.length === 0 &&
    opts.state.questions.length === 0
  ) {
    effects.push(
      diagnosticEffect({
        severity: "info",
        code: opts.noOp.code,
        message: opts.noOp.message(finalTextExcerpt(opts.noOp.finalText)),
        sourceRefs: opts.sourceRefs,
      }),
    );
  }

  if (opts.cap !== undefined && changes.length > opts.cap.maxChangedFiles) {
    effects.push(
      diagnosticEffect({
        severity: "warning",
        code: opts.cap.code,
        message: opts.cap.message(changes.length),
        sourceRefs: opts.sourceRefs,
      }),
    );
  } else if (changes.length > 0) {
    effects.push(
      patchEffect({
        mode: "auto",
        changes,
        reason: patchNarrative(opts.patchReason, opts.finalText),
        sourceRefs: opts.sourceRefs,
      }),
    );
  }

  effects.push(...agentQuestionEffects(opts.state, opts.sourceRefs));
  const truncated = agentTruncatedEffect({
    stopReason: opts.stopReason,
    message: opts.truncatedMessage,
    sourceRefs: opts.sourceRefs,
  });
  if (truncated !== null) effects.push(truncated);
  return Object.freeze(effects);
}
