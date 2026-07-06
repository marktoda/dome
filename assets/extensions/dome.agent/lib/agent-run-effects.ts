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
import { shortHash } from "../../../../src/core/short-hash";
import type {
  AgentIntegrityFlag,
  AgentRunResult,
  AgentRunState,
  IntegrityFindingKind,
} from "./agent-loop";
import type { SplitProposalInput } from "./split-proposal";

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

const INTEGRITY_LABEL: Record<IntegrityFindingKind, string> = {
  "historical-as-ongoing": "a completed/historical event framed as ongoing",
  contradiction: "an internal or cross-page contradiction",
  "self-corroborating":
    "a claim whose only support cites this vault (self-corroboration)",
  "inference-as-fact": "agent inference dressed as a sourced fact",
};

function integrityDiagnosticMessage(flag: AgentIntegrityFlag): string {
  return (
    `Integrity flag in ${flag.path}: ${INTEGRITY_LABEL[flag.kind]}. ` +
    `Claim: "${flag.claim}". Suggested fix: ${flag.fix}`
  );
}

/**
 * One DiagnosticEffect per accumulated `flagIntegrity` finding (the tool-loop
 * successor to the retired `dome.warden.integrity` warden). Model judgment is
 * transient: each finding is an `info`/`warning` DiagnosticEffect — never a
 * fact, never a patch — that self-clears via `resolveStaleDiagnostics` when the
 * page is reconciled. `sourceRef(path, stableId)` binds the diagnostic to the
 * flagged page with a per-finding stableId (`<kind>:<hash(claim)>`), so two
 * findings on one page get distinct subject hashes and both survive the
 * projection's INSERT OR IGNORE dedup (code alone is per-kind, not per-finding).
 */
export function agentIntegrityEffects(
  state: AgentRunState,
  sourceRef: (path: string, stableId: string) => SourceRef,
): ReadonlyArray<Effect> {
  return state.integrityFlags.map((flag) =>
    diagnosticEffect({
      severity: flag.severity,
      code: `dome.agent.integrity.${flag.kind}`,
      message: integrityDiagnosticMessage(flag),
      sourceRefs: [
        sourceRef(flag.path, `${flag.kind}:${shortHash(flag.claim, 12)}`),
      ],
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

/** The accumulated `proposeSplit` call, if any, as a propose-mode PatchEffect
 * change list: the hub rewrite, then each new sub-page. */
function splitProposalChanges(
  split: SplitProposalInput,
): ReadonlyArray<FileChangeInput> {
  return [
    { kind: "write", path: split.hubPath, content: split.hubContent },
    ...split.subPages.map(
      (sub) => ({ kind: "write", path: sub.path, content: sub.content }) as const,
    ),
  ];
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
   * a quiet night is legitimate and must not raise attention. A run whose
   * ONLY output is `state.splitProposal` is real output, not a no-op — the
   * check below excludes it.
   */
  readonly noOp?: AgentRunNoOp;
  /**
   * Resolver for the split-proposal patch's sourceRefs: one ref to the hub
   * path (the page being split), not the run's general `sourceRefs` (which
   * usually point at a ledger/config page unrelated to the split). Mirrors
   * the `agentIntegrityEffects(state, (path, stableId) => ...)` callback
   * convention. Falls back to `sourceRefs` when omitted, so callers that
   * never produce split proposals are unaffected.
   */
  readonly sourceRef?: (path: string) => SourceRef;
}): ReadonlyArray<Effect> {
  const effects: Effect[] = [];
  const changes = agentChanges(opts.state);
  const split = opts.state.splitProposal;
  const hasSplit = split !== undefined && split !== null;

  if (
    opts.noOp !== undefined &&
    opts.stopReason === "final" &&
    changes.length === 0 &&
    opts.state.questions.length === 0 &&
    opts.state.integrityFlags.length === 0 &&
    !hasSplit
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

  // The split-proposal patch is independent of the auto patch's cap/no-op
  // branches above: it was never applied (mode: "propose"), so it neither
  // counts against `maxChangedFiles` nor gets rolled back on cap overreach.
  if (hasSplit) {
    effects.push(
      patchEffect({
        mode: "propose",
        changes: splitProposalChanges(split),
        reason: split.reason,
        sourceRefs:
          opts.sourceRef !== undefined
            ? [opts.sourceRef(split.hubPath)]
            : opts.sourceRefs,
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
