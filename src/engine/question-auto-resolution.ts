// engine/question-auto-resolution: opt-in background resolution for low-risk
// QuestionEffect rows.
//
// This is intentionally not a new CLI or a processor primitive. It is an
// operational pump over existing QuestionEffect metadata: select a conservative
// recommended answer, record it through the durable answer path, then dispatch
// normal garden answer handlers so any markdown changes still go through
// adoption.

import type { AnswersDb } from "../answers/db";
import {
  markAnswerHandlerAttempt,
  markAnswerHandlersFailed,
  markAnswerHandlersHandled,
} from "../answers/question-answers";
import type { DiagnosticEffect } from "../core/effect";
import type {
  Capability,
  OperationalQueryView,
  TreeOid,
} from "../core/processor";
import type { AdoptionResult, Proposal } from "../core/proposal";
import type { CommitOid } from "../core/source-ref";
import type { RuntimeQuestionAutoResolveConfig } from "./capability-policy";
import type { LedgerDb } from "../ledger/db";
import type { ProjectionDb } from "../projections/db";
import {
  queryQuestionRecords,
  type QuestionRecord,
} from "../projections/questions";
import type { ExecutionPolicyCap } from "../processors/execution-policy";
import type { ProcessorExecutionState } from "../processors/execution-state";
import type { ProcessorRegistry } from "../processors/registry";
import { makeSnapshot } from "../processors/runtime";
import type { ApplyEffectSinks } from "./apply-effect";
import type { ApplyPatchInput } from "./apply-patch";
import { runAnswerHandlers, type AnswerHandlerResult } from "./answers";
import type { ModelProvider, ModelStepProvider } from "./model-invoke";
import { answerQuestionDurably } from "./question-answer-recording";
import type { EngineVault } from "./vault-shape";

export type QuestionAutoResolutionResult = {
  readonly enabled: boolean;
  readonly considered: number;
  readonly answered: number;
  readonly skipped: number;
  readonly handlerFailed: number;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
};

type AdoptAutoAnswerSubProposalFn = (
  proposal: Proposal,
  cascadeDepth: number,
) => Promise<AdoptionResult>;

export async function runQuestionAutoResolution(opts: {
  readonly config: RuntimeQuestionAutoResolveConfig;
  readonly vault: EngineVault;
  readonly adopted: CommitOid;
  readonly registry: ProcessorRegistry;
  readonly projection: ProjectionDb;
  readonly answers: AnswersDb;
  readonly sinks: ApplyEffectSinks;
  readonly resolveTree: (commit: CommitOid) => Promise<TreeOid>;
  readonly now: () => Date;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly extensionIdFor: (processorId: string) => string;
  readonly operational?: OperationalQueryView;
  readonly ledger?: LedgerDb;
  readonly executionState?: ProcessorExecutionState;
  readonly executionCap?: ExecutionPolicyCap;
  readonly modelProvider?: ModelProvider;
  readonly modelStepProvider?: ModelStepProvider;
  readonly adoptSubProposal?: AdoptAutoAnswerSubProposalFn;
  readonly currentAdopted?: () => CommitOid;
  readonly signal?: AbortSignal;
  readonly applyGardenPatchToCandidate?: (
    opts: ApplyPatchInput,
  ) => Promise<CommitOid | null>;
}): Promise<QuestionAutoResolutionResult> {
  if (!opts.config.enabled) return emptyResult(false);

  const openQuestions = queryQuestionRecords(opts.projection, {
    resolved: false,
  });
  if (openQuestions.length === 0) return emptyResult(true);

  let considered = 0;
  let answered = 0;
  let skipped = 0;
  let handlerFailed = 0;
  const diagnostics: DiagnosticEffect[] = [];

  for (const question of openQuestions) {
    if (opts.signal?.aborted === true) break;
    if (answered >= opts.config.maxPerTick) break;
    considered += 1;

    const plan = await autoResolutionPlan({
      question,
      config: opts.config,
      vaultPath: opts.vault.path,
      adopted: opts.currentAdopted?.() ?? opts.adopted,
      resolveTree: opts.resolveTree,
    });
    if (plan === null) {
      skipped += 1;
      continue;
    }

    const result = answerQuestionDurably({
      projection: opts.projection,
      answers: opts.answers,
      id: question.id,
      answer: plan.answer,
      now: opts.now,
    });
    if (result.kind !== "answered") {
      skipped += 1;
      continue;
    }

    answered += 1;
    const handler = await dispatchAutoAnswerHandlers({
      ...opts,
      question: result.record,
    });
    diagnostics.push(...handler.diagnostics);
    if (handler.failed) handlerFailed += 1;
  }

  return freezeResult({
    enabled: true,
    considered,
    answered,
    skipped,
    handlerFailed,
    diagnostics,
  });
}

async function autoResolutionPlan(opts: {
  readonly question: QuestionRecord;
  readonly config: RuntimeQuestionAutoResolveConfig;
  readonly vaultPath: string;
  readonly adopted: CommitOid;
  readonly resolveTree: (commit: CommitOid) => Promise<TreeOid>;
}): Promise<{ readonly answer: string } | null> {
  const metadata = opts.question.effect.metadata;
  const policy = metadata?.automationPolicy;
  if (policy !== "agent-safe" && policy !== "model-safe") return null;
  if (!opts.config.policies.includes(policy)) return null;
  if (metadata?.risk !== "low") return null;
  if (
    metadata.confidence === undefined ||
    metadata.confidence < opts.config.minConfidence
  ) {
    return null;
  }
  const answer = metadata.recommendedAnswer?.trim();
  if (answer === undefined || answer.length === 0) return null;
  const options = opts.question.effect.options;
  if (options !== undefined && !options.includes(answer)) return null;
  if (opts.question.effect.sourceRefs.length === 0) return null;

  const snapshot = await makeSnapshot(
    opts.vaultPath,
    opts.adopted,
    opts.resolveTree,
  );
  for (const ref of opts.question.effect.sourceRefs) {
    if ((await snapshot.readFile(ref.path as string)) === null) return null;
  }
  return Object.freeze({ answer });
}

async function dispatchAutoAnswerHandlers(opts: {
  readonly vault: EngineVault;
  readonly adopted: CommitOid;
  readonly registry: ProcessorRegistry;
  readonly answers: AnswersDb;
  readonly sinks: ApplyEffectSinks;
  readonly resolveTree: (commit: CommitOid) => Promise<TreeOid>;
  readonly now: () => Date;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly extensionIdFor: (processorId: string) => string;
  readonly question: QuestionRecord;
  readonly operational?: OperationalQueryView;
  readonly ledger?: LedgerDb;
  readonly executionState?: ProcessorExecutionState;
  readonly executionCap?: ExecutionPolicyCap;
  readonly modelProvider?: ModelProvider;
  readonly modelStepProvider?: ModelStepProvider;
  readonly adoptSubProposal?: AdoptAutoAnswerSubProposalFn;
  readonly currentAdopted?: () => CommitOid;
  readonly applyGardenPatchToCandidate?: (
    opts: ApplyPatchInput,
  ) => Promise<CommitOid | null>;
}): Promise<{
  readonly failed: boolean;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
}> {
  const idempotencyKey = opts.question.effect.idempotencyKey;
  markAnswerHandlerAttempt(
    opts.answers,
    idempotencyKey,
    opts.now().toISOString(),
  );
  const result = await runAnswerHandlers({
    vault: opts.vault,
    adopted: opts.currentAdopted?.() ?? opts.adopted,
    registry: opts.registry,
    question: opts.question,
    sinks: opts.sinks,
    resolveTree: opts.resolveTree,
    resolveGrants: opts.resolveGrants,
    extensionIdFor: opts.extensionIdFor,
    ...(opts.ledger !== undefined ? { ledger: opts.ledger } : {}),
    ...(opts.executionState !== undefined
      ? { executionState: opts.executionState }
      : {}),
    ...(opts.executionCap !== undefined
      ? { executionCap: opts.executionCap }
      : {}),
    ...(opts.operational !== undefined ? { operational: opts.operational } : {}),
    ...(opts.modelProvider !== undefined
      ? { modelProvider: opts.modelProvider }
      : {}),
    ...(opts.modelStepProvider !== undefined
      ? { modelStepProvider: opts.modelStepProvider }
      : {}),
    ...(opts.adoptSubProposal !== undefined
      ? { adoptSubProposal: opts.adoptSubProposal }
      : {}),
    ...(opts.currentAdopted !== undefined
      ? { currentAdopted: opts.currentAdopted }
      : {}),
    ...(opts.applyGardenPatchToCandidate !== undefined
      ? { applyGardenPatchToCandidate: opts.applyGardenPatchToCandidate }
      : {}),
  });

  const failure = answerHandlerFailure(result);
  if (failure !== null) {
    markAnswerHandlersFailed(opts.answers, {
      idempotencyKey,
      status: "failed",
      error: failure,
    });
    return Object.freeze({
      failed: true,
      diagnostics: result.diagnostics,
    });
  }

  markAnswerHandlersHandled(opts.answers, {
    idempotencyKey,
    handledAt: opts.now().toISOString(),
  });
  return Object.freeze({
    failed: false,
    diagnostics: result.diagnostics,
  });
}

function answerHandlerFailure(result: AnswerHandlerResult): string | null {
  const crash = result.diagnostics.find(
    (diagnostic) => diagnostic.code === "answer.dispatch-crashed",
  );
  if (crash !== undefined) return crash.message;

  const failedRun = result.runs.find(
    (run) => run.executionStatus !== "succeeded",
  );
  if (failedRun !== undefined) {
    return (
      failedRun.executionError?.message ??
      `answer handler ${failedRun.processorId} finished with ${failedRun.executionStatus}`
    );
  }

  const routingDiagnostic = result.diagnostics.find(
    (diagnostic) =>
      diagnostic.severity === "error" || diagnostic.severity === "block",
  );
  return routingDiagnostic?.message ?? null;
}

function emptyResult(enabled: boolean): QuestionAutoResolutionResult {
  return freezeResult({
    enabled,
    considered: 0,
    answered: 0,
    skipped: 0,
    handlerFailed: 0,
    diagnostics: [],
  });
}

function freezeResult(result: QuestionAutoResolutionResult): QuestionAutoResolutionResult {
  return Object.freeze({
    enabled: result.enabled,
    considered: result.considered,
    answered: result.answered,
    skipped: result.skipped,
    handlerFailed: result.handlerFailed,
    diagnostics: Object.freeze([...result.diagnostics]),
  });
}
