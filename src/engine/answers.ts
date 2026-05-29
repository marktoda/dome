// engine/answers: dispatch garden-phase processors after a user answer.
//
// `dome answer` records the human decision in the questions table; this
// module turns that durable row into normal processor work. Answer handlers
// are garden-phase processors with `{ kind: "answer" }` triggers. They see
// the adopted snapshot and emit ordinary Effects routed through the same
// broker/ledger/sub-Proposal machinery as scheduled jobs and garden work.

import {
  diagnosticEffect,
  type DiagnosticEffect,
} from "../core/effect";
import type {
  AnswerTrigger,
  Capability,
  OperationalQueryView,
  Processor,
  TreeOid,
} from "../core/processor";
import type { AdoptionResult, Proposal } from "../core/proposal";
import type { CommitOid } from "../core/source-ref";
import type { LedgerDb } from "../ledger/db";
import type { QuestionRecord } from "../projections/questions";
import {
  dispatchOneProcessor,
  makeSnapshot,
} from "../processors/runtime";
import type { ProcessorExecutionState } from "../processors/execution-state";
import type { ProcessorRegistry } from "../processors/registry";
import type { TriggerMatch } from "../processors/triggers";
import { recordEffectCapabilityUse } from "./effect-capability-use";
import { applyEffect, type ApplyEffectSinks } from "./apply-effect";
import {
  applyPatchToCandidate,
  type ApplyPatchInput,
} from "./apply-patch";
import { recordDiagnosticsViaSink } from "./diagnostics";
import { dispatchGardenPatchEffect } from "./garden-patch-dispatch";
import type { ModelProvider } from "./model-invoke";
import type {
  RunId,
  RunnerError,
  RunnerExecutionStatus,
} from "./runner-contract";
import type { EngineVault } from "./vault-shape";

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
  readonly modelProvider?: ModelProvider;
  readonly operational?: OperationalQueryView;
  readonly adoptSubProposal?: AdoptAnswerSubProposalFn;
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
    console.warn(`dome: answer-handler dispatch crashed: ${msg}`);
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
      console.warn(
        `dome: answer dispatch diagnostic was not recorded: ${recordMsg}`,
      );
    }
    return frozenResult({
      questionId: opts.question.id,
      runs: [],
      subProposalCount: 0,
      rejectedPatchCount: 0,
      diagnostics: [crashDiag],
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
  readonly modelProvider?: ModelProvider;
  readonly operational?: OperationalQueryView;
  readonly adoptSubProposal?: AdoptAnswerSubProposalFn;
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

  const snapshot = await makeSnapshot(
    opts.vault.path,
    opts.adopted,
    opts.resolveTree,
  );
  const diagnostics: DiagnosticEffect[] = [];
  const runs: AnswerHandlerRunSummary[] = [];
  let subProposalCount = 0;
  let rejectedPatchCount = 0;
  const applyGardenPatch =
    opts.applyGardenPatchToCandidate ?? applyPatchToCandidate;

  for (const candidate of candidates) {
    const result = await dispatchOneProcessor<AnswerRunInput>({
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
      snapshot,
      changedPaths: Object.freeze([]),
      proposal: null,
      inputCommit: opts.adopted,
      matches: candidate.matches,
      resolveGrants: opts.resolveGrants,
      extensionIdFor: opts.extensionIdFor,
      ledger: opts.ledger,
      ...(opts.executionState !== undefined
        ? { executionState: opts.executionState }
        : {}),
      ...(opts.modelProvider !== undefined
        ? { modelProvider: opts.modelProvider }
        : {}),
      ...(opts.operational !== undefined ? { operational: opts.operational } : {}),
    });

    let authorizedPatchCount = 0;
    for (const effect of result.effects) {
      if (effect.kind === "patch") {
        const routed = await dispatchGardenPatchEffect({
          effect,
          vault: opts.vault,
          adopted: opts.adopted,
          processorId: result.processorId,
          runId: result.runId,
          proposalId: null,
          declared: result.declared,
          granted: result.granted,
          sinks: opts.sinks,
          diagnostics,
          applyGardenPatch,
          extensionId: opts.extensionIdFor(result.processorId),
          ...(opts.ledger !== undefined ? { ledger: opts.ledger } : {}),
          ...(opts.adoptSubProposal !== undefined
            ? { adoptSubProposal: opts.adoptSubProposal }
            : {}),
          disabledDiagnostic: {
            code: "answer.garden-sub-proposal-spawn-disabled",
            message:
              `Answer handler ${result.processorId} emitted an authorized ` +
              `PatchEffect, but no adoptSubProposal callback was wired; ` +
              `patch dropped.`,
          },
        });
        if (routed.authorized) authorizedPatchCount += 1;
        if (routed.spawned) subProposalCount += 1;
        if (routed.rejected) rejectedPatchCount += 1;
        continue;
      }

      const applied = await applyEffect({
        effect,
        processorId: result.processorId,
        runId: result.runId,
        proposalId: null,
        phase: "garden",
        declared: result.declared,
        granted: result.granted,
        sinks: opts.sinks,
        candidate: opts.adopted,
      });
      if (applied.diagnostics.length > 0) {
        diagnostics.push(...applied.diagnostics);
      }
      recordEffectCapabilityUse({
        ledger: opts.ledger,
        runId: result.runId,
        ...(applied.capabilityUse !== undefined
          ? { capabilityUse: applied.capabilityUse }
          : {}),
      });
    }

    runs.push(
      Object.freeze({
        runId: result.runId,
        processorId: result.processorId,
        executionStatus: result.executionStatus,
        ...(result.executionError !== undefined
          ? { executionError: result.executionError }
          : {}),
        effectCount: result.effects.length,
        authorizedPatchCount,
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
