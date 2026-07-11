// agent-work/agent-work: the protocol-neutral agent-work compiler.
//
// Agent work is derived from open QuestionEffect rows. The question and its
// durable answer keep their existing lifecycles; this module only compiles a
// bounded, revisioned packet that a foreground, hosted, or background agent
// can investigate. It deliberately owns no queue, claim, retry, or job state.

import { compareStrings } from "../core/compare";
import type {
  QuestionAutomationPolicy,
  QuestionMetadata,
  QuestionRisk,
} from "../core/effect";
import type { SourceRef } from "../core/source-ref";
import { isQuestionAgentResolvable } from "../question-resolution";

export const AGENT_WORK_SCHEMA = "dome.agent-work/v1" as const;
export const DEFAULT_AGENT_WORK_LIMIT = 20;
export const MAX_AGENT_WORK_LIMIT = 100;

export type AgentWorkReadiness =
  | "ready"
  | "needs-action"
  | "needs-evidence"
  | "needs-contract";

export type AgentWorkItem = {
  readonly id: `question:${number}`;
  readonly questionId: number;
  /** Changes whenever the projected question is refreshed by a new run. */
  readonly revision: string;
  readonly question: string;
  readonly options: ReadonlyArray<string>;
  readonly recommendation: string | null;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
  readonly processorId: string;
  readonly openedAt: string;
  readonly adoptedCommit: string;
  /** Canonical policy. Legacy model-safe rows compile to agent-safe. */
  readonly policy: "agent-safe";
  readonly sourcePolicy: Extract<
    QuestionAutomationPolicy,
    "agent-safe" | "model-safe"
  >;
  readonly risk: QuestionRisk | "unknown";
  readonly confidence: number | null;
  readonly resolutionMode: "dispatch" | "acknowledge" | "unspecified";
  readonly readiness: AgentWorkReadiness;
  readonly readinessReason: string;
  readonly requiredEvidencePaths: ReadonlyArray<string>;
  readonly action: {
    readonly kind: "complete-agent-work";
    readonly questionId: number;
    readonly expectedRevision: string;
  };
};

export type AgentWorkSnapshot = {
  readonly schema: typeof AGENT_WORK_SCHEMA;
  readonly generatedAt: string;
  readonly items: ReadonlyArray<AgentWorkItem>;
  readonly counts: {
    readonly total: number;
    readonly ready: number;
    readonly needsAction: number;
    readonly needsEvidence: number;
    readonly needsContract: number;
  };
  /** Number of matching rows omitted only by the requested limit. */
  readonly remaining: number;
};

export type AgentWorkQuestionInput = {
  readonly id: number;
  readonly question: string;
  readonly options?: ReadonlyArray<string>;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
  readonly metadata?: QuestionMetadata;
  readonly processorId: string;
  readonly runId: string;
  readonly adoptedCommit: string;
  readonly askedAt: string;
};

export type AgentWorkQuestionRecord = {
  readonly id: number;
  readonly effect: {
    readonly question: string;
    readonly options?: ReadonlyArray<string>;
    readonly sourceRefs: ReadonlyArray<SourceRef>;
    readonly metadata?: QuestionMetadata;
  };
  readonly processorId: string;
  readonly runId: string;
  readonly adoptedCommit: string;
  readonly askedAt: string;
};

export type CompileAgentWorkInput = {
  readonly questions: ReadonlyArray<AgentWorkQuestionInput>;
  readonly now: Date;
  readonly limit?: number;
  readonly questionId?: number;
};

/** Keeps projection-record flattening out of Vault and protocol adapters. */
export function agentWorkQuestion(
  record: AgentWorkQuestionRecord,
): AgentWorkQuestionInput {
  return Object.freeze({
    id: record.id,
    question: record.effect.question,
    ...(record.effect.options !== undefined
      ? { options: record.effect.options }
      : {}),
    sourceRefs: record.effect.sourceRefs,
    ...(record.effect.metadata !== undefined
      ? { metadata: record.effect.metadata }
      : {}),
    processorId: record.processorId,
    runId: record.runId,
    adoptedCommit: record.adoptedCommit,
    askedAt: record.askedAt,
  });
}

/**
 * Compile the current agent queue. Pure and deterministic for its inputs;
 * storage, model execution, and durable resolution stay outside this module.
 */
export function compileAgentWork(
  input: CompileAgentWorkInput,
): AgentWorkSnapshot {
  const limit = boundedLimit(input.limit);
  const all = input.questions
    .filter((question) =>
      (input.questionId === undefined || question.id === input.questionId) &&
      isQuestionAgentResolvable(question.metadata)
    )
    .map(workItem)
    .sort(compareAgentWork);
  const items = Object.freeze(all.slice(0, limit));

  return Object.freeze({
    schema: AGENT_WORK_SCHEMA,
    generatedAt: input.now.toISOString(),
    items,
    counts: Object.freeze({
      total: all.length,
      ready: all.filter((item) => item.readiness === "ready").length,
      needsAction: all.filter((item) => item.readiness === "needs-action").length,
      needsEvidence: all.filter((item) => item.readiness === "needs-evidence").length,
      needsContract: all.filter((item) => item.readiness === "needs-contract").length,
    }),
    remaining: Math.max(0, all.length - items.length),
  });
}

function workItem(question: AgentWorkQuestionInput): AgentWorkItem {
  const metadata = question.metadata;
  const sourcePolicy = metadata?.automationPolicy === "model-safe"
    ? "model-safe"
    : "agent-safe";
  const resolutionMode = metadata?.resolutionMode ?? "unspecified";
  const requiredEvidencePaths = Object.freeze(
    [...new Set(question.sourceRefs.map((ref) => ref.path))].sort(compareStrings),
  );
  const readiness = readinessOf(resolutionMode, requiredEvidencePaths);
  const revision = `${question.adoptedCommit}:${question.runId}`;
  return Object.freeze({
    id: `question:${question.id}` as const,
    questionId: question.id,
    revision,
    question: question.question,
    options: Object.freeze([...(question.options ?? [])]),
    recommendation: metadata?.recommendedAnswer ?? null,
    sourceRefs: Object.freeze([...question.sourceRefs]),
    processorId: question.processorId,
    openedAt: question.askedAt,
    adoptedCommit: question.adoptedCommit,
    policy: "agent-safe" as const,
    sourcePolicy,
    risk: metadata?.risk ?? "unknown",
    confidence: metadata?.confidence ?? null,
    resolutionMode,
    readiness: readiness.kind,
    readinessReason: readiness.reason,
    requiredEvidencePaths,
    action: Object.freeze({
      kind: "complete-agent-work" as const,
      questionId: question.id,
      expectedRevision: revision,
    }),
  });
}

function readinessOf(
  resolutionMode: AgentWorkItem["resolutionMode"],
  evidencePaths: ReadonlyArray<string>,
): { readonly kind: AgentWorkReadiness; readonly reason: string } {
  if (resolutionMode === "acknowledge") {
    return Object.freeze({
      kind: "needs-action" as const,
      reason: "the answer acknowledges an external action that a decision-only agent cannot prove it performed",
    });
  }
  if (resolutionMode === "unspecified") {
    return Object.freeze({
      kind: "needs-contract" as const,
      reason: "the producer did not declare whether resolution dispatches work or acknowledges an action",
    });
  }
  if (evidencePaths.length === 0) {
    return Object.freeze({
      kind: "needs-evidence" as const,
      reason: "the question has no source-backed evidence path",
    });
  }
  return Object.freeze({
    kind: "ready" as const,
    reason: "a source-backed dispatch decision can be investigated and completed",
  });
}

function compareAgentWork(a: AgentWorkItem, b: AgentWorkItem): number {
  const readiness = READINESS_RANK[a.readiness] - READINESS_RANK[b.readiness];
  if (readiness !== 0) return readiness;
  const risk = RISK_RANK[a.risk] - RISK_RANK[b.risk];
  if (risk !== 0) return risk;
  const confidence = (b.confidence ?? -1) - (a.confidence ?? -1);
  if (confidence !== 0) return confidence;
  const opened = Date.parse(a.openedAt) - Date.parse(b.openedAt);
  if (opened !== 0 && !Number.isNaN(opened)) return opened;
  return compareStrings(a.id, b.id);
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_AGENT_WORK_LIMIT;
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_AGENT_WORK_LIMIT;
  return Math.min(value, MAX_AGENT_WORK_LIMIT);
}

const READINESS_RANK: Record<AgentWorkReadiness, number> = {
  ready: 0,
  "needs-action": 1,
  "needs-evidence": 2,
  "needs-contract": 3,
};

const RISK_RANK: Record<AgentWorkItem["risk"], number> = {
  low: 0,
  medium: 1,
  high: 2,
  unknown: 3,
};

export type CompleteAgentWorkInput = {
  readonly questionId: number;
  readonly expectedRevision: string;
  readonly answer: string;
  /** Short audit explanation of why the evidence supports this answer. */
  readonly reason: string;
  /** Evidence actually inspected by the agent, not merely copied from the packet. */
  readonly evidence: ReadonlyArray<SourceRef>;
};

export type AgentWorkCompletionProblem =
  | "not-ready"
  | "stale-revision"
  | "invalid-option"
  | "missing-reason"
  | "missing-evidence";

export type ValidateAgentWorkCompletionResult =
  | {
      readonly ok: true;
      readonly answer: string;
      readonly reason: string;
      readonly evidence: ReadonlyArray<SourceRef>;
    }
  | {
      readonly ok: false;
      readonly problem: AgentWorkCompletionProblem;
      readonly message: string;
    };

/** Validate a proposed completion against the current packet revision. */
export function validateAgentWorkCompletion(
  item: AgentWorkItem,
  input: CompleteAgentWorkInput,
): ValidateAgentWorkCompletionResult {
  if (item.readiness !== "ready") {
    return problem("not-ready", item.readinessReason);
  }
  if (input.expectedRevision !== item.revision) {
    return problem(
      "stale-revision",
      "the question changed after this work packet was compiled; investigate the current revision",
    );
  }
  const answer = input.answer.trim();
  if (item.options.length > 0 && !item.options.includes(answer)) {
    return problem(
      "invalid-option",
      `answer must be one of: ${item.options.join(", ")}`,
    );
  }
  const reason = input.reason.trim();
  if (reason.length === 0) {
    return problem("missing-reason", "agent completion requires an audit reason");
  }
  const evidence = Object.freeze([...input.evidence]);
  const inspected = new Set<string>(evidence.map((ref) => ref.path));
  const missing = item.requiredEvidencePaths.filter((path) => !inspected.has(path));
  if (missing.length > 0) {
    return problem(
      "missing-evidence",
      `agent must inspect every required evidence path: ${missing.join(", ")}`,
    );
  }
  return Object.freeze({ ok: true as const, answer, reason, evidence });
}

function problem(
  problem: AgentWorkCompletionProblem,
  message: string,
): ValidateAgentWorkCompletionResult {
  return Object.freeze({ ok: false as const, problem, message });
}
