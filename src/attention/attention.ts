// attention/attention: the protocol-neutral owner-attention compiler.
//
// Attention is deliberately DERIVED. Questions and proposals retain their
// own durable lifecycles; this module selects the current requests that need
// owner authority, ranks them once, and returns one document shared by every
// surface. Diagnostics, tasks, and engine health do not enter this module:
// they have different settlement semantics and must not compete for the
// owner's decision budget.

import type { QuestionMetadata } from "../core/effect";
import { compareStrings } from "../core/compare";
import type { SourceRef } from "../core/source-ref";
import { questionAutomationPolicy } from "../question-resolution";

export const ATTENTION_SCHEMA = "dome.attention/v1" as const;
export const DEFAULT_PRIMARY_ATTENTION_LIMIT = 3;
export const DEFAULT_ATTENTION_AGING_DAYS = 7;

export type AttentionConsequence = "high" | "medium" | "low";
export type AttentionUrgency = "now" | "soon" | "none";

export type AttentionRank = {
  readonly consequence: AttentionConsequence;
  readonly urgency: AttentionUrgency;
  readonly confidence: number | null;
  readonly reasons: ReadonlyArray<string>;
};

export type DecisionAttentionItem = {
  readonly id: `decision:${number}`;
  readonly kind: "decision";
  readonly summary: string;
  readonly openedAt: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
  readonly processorId: string;
  readonly recommendation: string | null;
  readonly action: {
    readonly kind: "resolve";
    readonly questionId: number;
    readonly options: ReadonlyArray<string>;
  };
  readonly rank: AttentionRank;
};

export type ReviewAttentionItem = {
  readonly id: `proposal:${number}`;
  readonly kind: "review";
  readonly summary: string;
  readonly openedAt: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
  readonly processorId: string;
  readonly stale: boolean;
  readonly paths: ReadonlyArray<string>;
  readonly action: {
    readonly kind: "review-proposal";
    readonly proposalId: number;
  };
  readonly rank: AttentionRank;
};

export type OwnerAttentionItem = DecisionAttentionItem | ReviewAttentionItem;

export type AttentionSnapshot = {
  readonly schema: typeof ATTENTION_SCHEMA;
  readonly generatedAt: string;
  /** The bounded, ranked owner surface. */
  readonly primary: ReadonlyArray<OwnerAttentionItem>;
  /** Valid owner requests outside the immediate budget or aging out of it. */
  readonly backlog: ReadonlyArray<OwnerAttentionItem>;
  /** Open questions assigned to an agent, never charged to owner attention. */
  readonly agentWorkCount: number;
  readonly counts: {
    readonly owner: number;
    readonly decisions: number;
    readonly reviews: number;
    readonly primary: number;
    readonly backlog: number;
  };
};

export type AttentionQuestionInput = {
  readonly id: number;
  readonly question: string;
  readonly options?: ReadonlyArray<string>;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
  readonly metadata?: QuestionMetadata;
  readonly processorId: string;
  readonly askedAt: string;
};

export type AttentionProposalInput = {
  readonly id: number;
  readonly processorId: string;
  readonly reason: string;
  readonly paths: ReadonlyArray<string>;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
  readonly createdAt: string;
  readonly stale?: boolean;
};

export type CompileAttentionInput = {
  readonly questions: ReadonlyArray<AttentionQuestionInput>;
  readonly proposals: ReadonlyArray<AttentionProposalInput>;
  readonly now: Date;
  readonly primaryLimit?: number;
  readonly agingDays?: number;
};

export type AttentionQuestionRecord = {
  readonly id: number;
  readonly effect: {
    readonly question: string;
    readonly options?: ReadonlyArray<string>;
    readonly sourceRefs: ReadonlyArray<SourceRef>;
    readonly metadata?: QuestionMetadata;
  };
  readonly processorId: string;
  readonly askedAt: string;
};

export type AttentionProposalRecord = {
  readonly id: number;
  readonly processorId: string;
  readonly reason: string;
  readonly paths: ReadonlyArray<string>;
  readonly sourceRefs?: ReadonlyArray<SourceRef>;
  readonly createdAt: string;
  readonly stale?: boolean;
};

/** Adapter shared by stores and surfaces; keeps record flattening out of callers. */
export function attentionQuestion(
  record: AttentionQuestionRecord,
): AttentionQuestionInput {
  return Object.freeze({
    id: record.id,
    question: record.effect.question,
    ...(record.effect.options !== undefined ? { options: record.effect.options } : {}),
    sourceRefs: record.effect.sourceRefs,
    ...(record.effect.metadata !== undefined ? { metadata: record.effect.metadata } : {}),
    processorId: record.processorId,
    askedAt: record.askedAt,
  });
}

/** Adapter shared by the proposal store, operator surfaces, and processors. */
export function attentionProposal(
  record: AttentionProposalRecord,
): AttentionProposalInput {
  return Object.freeze({
    id: record.id,
    processorId: record.processorId,
    reason: record.reason,
    paths: record.paths,
    sourceRefs: record.sourceRefs ?? Object.freeze([]),
    createdAt: record.createdAt,
    ...(record.stale !== undefined ? { stale: record.stale } : {}),
  });
}

/**
 * Compile the one canonical owner-attention snapshot. Pure and deterministic
 * for its inputs: storage access, protocol rendering, and mutation stay with
 * adapters outside this module.
 */
export function compileAttention(input: CompileAttentionInput): AttentionSnapshot {
  const primaryLimit = positiveInteger(
    input.primaryLimit,
    DEFAULT_PRIMARY_ATTENTION_LIMIT,
  );
  const agingDays = positiveInteger(
    input.agingDays,
    DEFAULT_ATTENTION_AGING_DAYS,
  );
  const cutoff = input.now.getTime() - agingDays * 86_400_000;
  let agentWorkCount = 0;

  const ownerItems: OwnerAttentionItem[] = [];
  for (const question of input.questions) {
    if (questionAutomationPolicy(question.metadata) !== "owner-needed") {
      agentWorkCount += 1;
      continue;
    }
    ownerItems.push(decisionItem(question));
  }
  ownerItems.push(...input.proposals.map(reviewItem));
  ownerItems.sort(compareAttentionItems);

  const eligible: OwnerAttentionItem[] = [];
  const backlog: OwnerAttentionItem[] = [];
  for (const item of ownerItems) {
    const aging = Date.parse(item.openedAt) < cutoff;
    const consequential = item.rank.consequence === "high";
    const urgent = item.rank.urgency !== "none";
    if (item.kind === "review" && item.stale) {
      backlog.push(item);
    } else if (aging && !consequential && !urgent) {
      backlog.push(withReason(item, `open for at least ${agingDays} days`));
    } else {
      eligible.push(item);
    }
  }

  const primary = eligible.slice(0, primaryLimit);
  backlog.unshift(...eligible.slice(primaryLimit));
  const decisions = ownerItems.filter((item) => item.kind === "decision").length;
  const reviews = ownerItems.length - decisions;

  return Object.freeze({
    schema: ATTENTION_SCHEMA,
    generatedAt: input.now.toISOString(),
    primary: Object.freeze(primary),
    backlog: Object.freeze(backlog),
    agentWorkCount,
    counts: Object.freeze({
      owner: ownerItems.length,
      decisions,
      reviews,
      primary: primary.length,
      backlog: backlog.length,
    }),
  });
}

function decisionItem(question: AttentionQuestionInput): DecisionAttentionItem {
  const hints = question.metadata?.attention;
  const consequence = hints?.consequence ?? "medium";
  const urgency = hints?.urgency ?? "none";
  const confidence = question.metadata?.confidence ?? null;
  const reason = hints?.reason ?? question.metadata?.ownerNeededReason;
  return Object.freeze({
    id: `decision:${question.id}` as const,
    kind: "decision" as const,
    summary: question.question,
    openedAt: question.askedAt,
    sourceRefs: Object.freeze([...question.sourceRefs]),
    processorId: question.processorId,
    recommendation: question.metadata?.recommendedAnswer ?? null,
    action: Object.freeze({
      kind: "resolve" as const,
      questionId: question.id,
      options: Object.freeze([...(question.options ?? [])]),
    }),
    rank: rank({
      consequence,
      urgency,
      confidence,
      ...(reason !== undefined ? { reason } : {}),
      ...(hints?.dueAt !== undefined ? { dueAt: hints.dueAt } : {}),
    }),
  });
}

function reviewItem(proposal: AttentionProposalInput): ReviewAttentionItem {
  return Object.freeze({
    id: `proposal:${proposal.id}` as const,
    kind: "review" as const,
    summary: proposal.reason,
    openedAt: proposal.createdAt,
    sourceRefs: Object.freeze([...proposal.sourceRefs]),
    processorId: proposal.processorId,
    stale: proposal.stale === true,
    paths: Object.freeze([...proposal.paths]),
    action: Object.freeze({
      kind: "review-proposal" as const,
      proposalId: proposal.id,
    }),
    // A concrete, reviewable diff has known framing. Consequence remains
    // medium until PatchEffect grows an explicit review hint.
    rank: rank({
      consequence: "medium",
      urgency: "none",
      confidence: 1,
      reason: proposal.stale
        ? "the proposed diff is stale and must be regenerated before applying"
        : "a concrete vault diff is waiting for owner review",
    }),
  });
}

function rank(input: {
  readonly consequence: AttentionConsequence;
  readonly urgency: AttentionUrgency;
  readonly confidence: number | null;
  readonly reason?: string;
  readonly dueAt?: string;
}): AttentionRank {
  const reasons = [
    `${input.consequence} consequence`,
    `${input.urgency} urgency`,
    ...(input.dueAt === undefined ? [] : [`due ${input.dueAt}`]),
    ...(input.reason === undefined ? [] : [input.reason]),
  ];
  return Object.freeze({
    consequence: input.consequence,
    urgency: input.urgency,
    confidence: input.confidence,
    reasons: Object.freeze(reasons),
  });
}

function compareAttentionItems(a: OwnerAttentionItem, b: OwnerAttentionItem): number {
  const urgency = URGENCY_RANK[a.rank.urgency] - URGENCY_RANK[b.rank.urgency];
  if (urgency !== 0) return urgency;
  const consequence =
    CONSEQUENCE_RANK[a.rank.consequence] - CONSEQUENCE_RANK[b.rank.consequence];
  if (consequence !== 0) return consequence;
  const confidence = (b.rank.confidence ?? -1) - (a.rank.confidence ?? -1);
  if (confidence !== 0) return confidence;
  const opened = Date.parse(b.openedAt) - Date.parse(a.openedAt);
  if (opened !== 0 && !Number.isNaN(opened)) return opened;
  return compareStrings(a.id, b.id);
}

function withReason<T extends OwnerAttentionItem>(item: T, reason: string): T {
  return Object.freeze({
    ...item,
    rank: Object.freeze({
      ...item.rank,
      reasons: Object.freeze([...item.rank.reasons, reason]),
    }),
  }) as T;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

const CONSEQUENCE_RANK: Record<AttentionConsequence, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const URGENCY_RANK: Record<AttentionUrgency, number> = {
  now: 0,
  soon: 1,
  none: 2,
};
