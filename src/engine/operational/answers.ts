// engine/operational/answers: dispatch garden-phase processors after a user answer.
//
// `dome resolve` / `dome answer` records the human decision in the questions
// table; this module turns that durable row into normal processor work. Answer
// handlers are garden-phase processors with `{ kind: "answer" }` triggers. They
// see the adopted snapshot and emit ordinary Effects routed through the same
// broker/ledger/sub-Proposal machinery as scheduled jobs and garden work.

import {
  diagnosticEffect,
  type DiagnosticEffect,
} from "../../core/effect";
import type {
  AnswerTrigger,
  Capability,
  OperationalQueryView,
  Processor,
  TreeOid,
} from "../../core/processor";
import type { AdoptionResult, Proposal } from "../../core/proposal";
import type { CommitOid } from "../../core/source-ref";
import type { LedgerDb } from "../../ledger/db";
import type { QuestionRecord } from "../../projections/questions";
import type { ExecutionPolicyCap } from "../../processors/execution-policy";
import type { ProcessorExecutionState } from "../../processors/execution-state";
import type { ProcessorRegistry } from "../../processors/registry";
import type { TriggerMatch } from "../../processors/triggers";
import type { ApplyEffectSinks } from "../core/apply-effect";
import {
  applyPatchToCandidate,
  type ApplyPatchInput,
} from "../core/apply-patch";
import { recordDiagnosticsViaSink } from "../core/diagnostics";
import {
  dispatchGardenRun,
  type GardenRunDeps,
} from "../garden/garden-run";
import type { ModelProvider, ModelStepProvider } from "../core/model-invoke";
import type {
  RunId,
  RunnerError,
  RunnerExecutionStatus,
} from "../core/runner-contract";
import type { EngineVault } from "../core/vault-shape";

export type AnswerRunInput = {
  readonly kind: "answer";
  readonly questionId: number;
  readonly question: QuestionRecord["effect"];
  readonly answer: string;
  readonly answeredAt: string;
  readonly matchedTriggers: ReadonlyArray<TriggerMatch>;
};

export type AnswerHandlerRunSummary = {
  readonly runId: RunId;
  readonly processorId: string;
  readonly executionStatus: RunnerExecutionStatus;
  readonly executionError?: RunnerError;
  readonly effectCount: number;
  readonly authorizedPatchCount: number;
};

export type AnswerHandlerResult = {
  readonly questionId: number;
  readonly runs: ReadonlyArray<AnswerHandlerRunSummary>;
  readonly subProposalCount: number;
  readonly rejectedPatchCount: number;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
};

type AdoptAnswerSubProposalFn = (
  proposal: Proposal,
  cascadeDepth: number,
) => Promise<AdoptionResult>;

export async function runAnswerHandlers(opts: {
  readonly vault: EngineVault;
  readonly adopted: CommitOid;
  readonly registry: ProcessorRegistry;
  readonly question: QuestionRecord;
  readonly sinks: ApplyEffectSinks;
  readonly resolveTree: (commit: CommitOid) => Promise<TreeOid>;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly extensionIdFor: (processorId: string) => string;
  readonly ledger?: LedgerDb;
  readonly executionState?: ProcessorExecutionState;
  readonly executionCap?: ExecutionPolicyCap;
  readonly modelProvider?: ModelProvider;
  readonly modelStepProvider?: ModelStepProvider;
  readonly operational?: OperationalQueryView;
  readonly adoptSubProposal?: AdoptAnswerSubProposalFn;
  readonly currentAdopted?: () => CommitOid;
  readonly applyGardenPatchToCandidate?: (
    opts: ApplyPatchInput,
  ) => Promise<CommitOid | null>;
}): Promise<AnswerHandlerResult> {
  try {
    return await runAnswerHandlersInner(opts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const crashDiag = diagnosticEffect({
      severity: "error",
      code: "answer.dispatch-crashed",
      message:
        `Answer-handler dispatch crashed for question ${opts.question.id}: ${msg}`,
      sourceRefs: opts.question.effect.sourceRefs,
    });
    const diagnostics: DiagnosticEffect[] = [crashDiag];
    try {
      await recordDiagnosticsViaSink({
        sinks: opts.sinks,
        diagnostics: [crashDiag],
        processorId: "engine.answers",
        proposalId: null,
      });
    } catch (recordError) {
      const recordMsg =
        recordError instanceof Error ? recordError.message : String(recordError);
      diagnostics.push(
        diagnosticEffect({
          severity: "error",
          code: "answer.dispatch-diagnostic-record-failed",
          message: `Answer dispatch diagnostic was not recorded: ${recordMsg}`,
          sourceRefs: opts.question.effect.sourceRefs,
        }),
      );
    }
    return frozenResult({
      questionId: opts.question.id,
      runs: [],
      subProposalCount: 0,
      rejectedPatchCount: 0,
      diagnostics,
    });
  }
}

async function runAnswerHandlersInner(opts: {
  readonly vault: EngineVault;
  readonly adopted: CommitOid;
  readonly registry: ProcessorRegistry;
  readonly question: QuestionRecord;
  readonly sinks: ApplyEffectSinks;
  readonly resolveTree: (commit: CommitOid) => Promise<TreeOid>;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly extensionIdFor: (processorId: string) => string;
  readonly ledger?: LedgerDb;
  readonly executionState?: ProcessorExecutionState;
  readonly executionCap?: ExecutionPolicyCap;
  readonly modelProvider?: ModelProvider;
  readonly modelStepProvider?: ModelStepProvider;
  readonly operational?: OperationalQueryView;
  readonly adoptSubProposal?: AdoptAnswerSubProposalFn;
  readonly currentAdopted?: () => CommitOid;
  readonly applyGardenPatchToCandidate?: (
    opts: ApplyPatchInput,
  ) => Promise<CommitOid | null>;
}): Promise<AnswerHandlerResult> {
  if (opts.question.answer === null || opts.question.answeredAt === null) {
    return frozenResult({
      questionId: opts.question.id,
      runs: [],
      subProposalCount: 0,
      rejectedPatchCount: 0,
      diagnostics: [],
    });
  }

  const candidates = answerHandlerCandidates(opts.registry, opts.question);
  if (candidates.length === 0) {
    return frozenResult({
      questionId: opts.question.id,
      runs: [],
      subProposalCount: 0,
      rejectedPatchCount: 0,
      diagnostics: [],
    });
  }

  const diagnostics: DiagnosticEffect[] = [];
  const runs: AnswerHandlerRunSummary[] = [];
  let subProposalCount = 0;
  let rejectedPatchCount = 0;
  const applyGardenPatch =
    opts.applyGardenPatchToCandidate ?? applyPatchToCandidate;

  // The shared dispatch+route plumbing every answer handler forwards verbatim;
  // dispatchGardenRun owns the snapshot + dispatch + route envelope. Answer
  // handlers are not tied to a user-drift Proposal (proposal_id = NULL).
  const gardenRunDeps: GardenRunDeps = {
    vault: opts.vault,
    adopted: opts.adopted,
    ...(opts.currentAdopted !== undefined
      ? { currentAdopted: opts.currentAdopted }
      : {}),
    resolveTree: opts.resolveTree,
    sinks: opts.sinks,
    resolveGrants: opts.resolveGrants,
    extensionIdFor: opts.extensionIdFor,
    ...(opts.ledger !== undefined ? { ledger: opts.ledger } : {}),
    ...(opts.executionState !== undefined
      ? { executionState: opts.executionState }
      : {}),
    ...(opts.executionCap !== undefined
      ? { executionCap: opts.executionCap }
      : {}),
    ...(opts.modelProvider !== undefined
      ? { modelProvider: opts.modelProvider }
      : {}),
    ...(opts.modelStepProvider !== undefined
      ? { modelStepProvider: opts.modelStepProvider }
      : {}),
    ...(opts.operational !== undefined ? { operational: opts.operational } : {}),
    applyGardenPatch,
    ...(opts.adoptSubProposal !== undefined
      ? { adoptSubProposal: opts.adoptSubProposal }
      : {}),
  };

  for (const candidate of candidates) {
    const { result, routing: routed } = await dispatchGardenRun(
      gardenRunDeps,
      {
        processor: candidate.processor,
        phase: "garden",
        envelope: Object.freeze({
          kind: "answer" as const,
          questionId: opts.question.id,
          question: opts.question.effect,
          answer: opts.question.answer,
          answeredAt: opts.question.answeredAt,
          matchedTriggers: candidate.matches,
        }),
        matches: candidate.matches,
        disabledDiagnostic: {
          code: "answer.garden-sub-proposal-spawn-disabled",
          message:
            `Answer handler ${candidate.processor.id} emitted an authorized ` +
            `PatchEffect, but no adoptSubProposal callback was wired; ` +
            `patch dropped.`,
        },
      },
      diagnostics,
    );
    subProposalCount += routed.spawnedPatchCount;
    rejectedPatchCount += routed.rejectedPatchCount;

    runs.push(
      Object.freeze({
        runId: result.runId,
        processorId: result.processorId,
        executionStatus: result.executionStatus,
        ...(result.executionError !== undefined
          ? { executionError: result.executionError }
          : {}),
        effectCount: result.effects.length,
        authorizedPatchCount: routed.authorizedPatchCount,
      }),
    );
  }

  return frozenResult({
    questionId: opts.question.id,
    runs,
    subProposalCount,
    rejectedPatchCount,
    diagnostics,
  });
}

function answerHandlerCandidates(
  registry: ProcessorRegistry,
  question: QuestionRecord,
): ReadonlyArray<{
  readonly processor: Processor<unknown>;
  readonly matches: ReadonlyArray<TriggerMatch>;
}> {
  const out: {
    readonly processor: Processor<unknown>;
    readonly matches: ReadonlyArray<TriggerMatch>;
  }[] = [];
  for (const processor of registry.byPhase("garden")) {
    const triggers = processor.triggers.filter(
      (trigger): trigger is AnswerTrigger =>
        trigger.kind === "answer" && answerTriggerMatches(trigger, question),
    );
    if (triggers.length === 0) continue;
    out.push(
      Object.freeze({
        processor,
        matches: Object.freeze(
          triggers.map((trigger) =>
            Object.freeze({
              trigger,
              matchedSignals: Object.freeze([]),
            }),
          ),
        ),
      }),
    );
  }
  return Object.freeze(out);
}

function answerTriggerMatches(
  trigger: AnswerTrigger,
  question: QuestionRecord,
): boolean {
  if (
    trigger.questionProcessorId !== undefined &&
    question.processorId !== trigger.questionProcessorId
  ) {
    return false;
  }
  return trigger.idempotencyKeyPrefix === undefined
    || question.effect.idempotencyKey.startsWith(trigger.idempotencyKeyPrefix);
}

function frozenResult(result: {
  readonly questionId: number;
  readonly runs: ReadonlyArray<AnswerHandlerRunSummary>;
  readonly subProposalCount: number;
  readonly rejectedPatchCount: number;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
}): AnswerHandlerResult {
  return Object.freeze({
    questionId: result.questionId,
    runs: Object.freeze([...result.runs]),
    subProposalCount: result.subProposalCount,
    rejectedPatchCount: result.rejectedPatchCount,
    diagnostics: Object.freeze([...result.diagnostics]),
  });
}
