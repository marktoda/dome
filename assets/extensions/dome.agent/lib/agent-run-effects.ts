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
  readonly truncatedMessage: string;
  readonly cap?: AgentRunCap;
}): ReadonlyArray<Effect> {
  const effects: Effect[] = [];
  const changes = agentChanges(opts.state);

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
        reason: opts.patchReason,
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
