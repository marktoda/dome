// agent-work/attempt: a provider-neutral attempt loop over derived work.
//
// The agent adapter may be Claude Code, the built-in hosted model, a local
// model, or a hermetic test. It receives one immutable packet and returns a
// decision plus the evidence it actually inspected. Dome validates and
// resolves through the same durable question path used by owner resolution.

import type { SourceRef } from "../core/source-ref";
import type {
  AgentWorkItem,
  AgentWorkSnapshot,
  CompleteAgentWorkInput,
} from "./agent-work";

export type AgentWorkDecision =
  | {
      readonly kind: "answer";
      readonly answer: string;
      readonly reason: string;
      readonly evidence: ReadonlyArray<SourceRef>;
    }
  | { readonly kind: "defer"; readonly reason: string };

export type AgentWorkAgent = (
  item: AgentWorkItem,
  signal?: AbortSignal,
) => Promise<AgentWorkDecision>;

export type AgentWorkCompletionReceipt =
  | { readonly kind: "completed" | "already-completed" }
  | { readonly kind: "not-found" }
  | { readonly kind: "rejected"; readonly problem: string; readonly message: string };

/** The small interface an agent runner needs. Vault is the production adapter. */
export type AgentWorkPort = {
  readonly agentWork: (opts?: {
    readonly limit?: number;
    readonly questionId?: number;
  }) => Promise<AgentWorkSnapshot>;
  readonly completeAgentWork: (
    input: CompleteAgentWorkInput,
  ) => Promise<AgentWorkCompletionReceipt>;
};

export type AgentWorkAttemptResult =
  | { readonly kind: "completed" | "already-completed"; readonly item: AgentWorkItem }
  | { readonly kind: "not-found"; readonly questionId: number }
  | {
      readonly kind: "not-ready";
      readonly item: AgentWorkItem;
      readonly reason: string;
    }
  | { readonly kind: "deferred"; readonly item: AgentWorkItem; readonly reason: string }
  | {
      readonly kind: "rejected";
      readonly item: AgentWorkItem;
      readonly problem: string;
      readonly message: string;
    }
  | { readonly kind: "failed"; readonly item: AgentWorkItem; readonly error: string };

/** Attempt one current question. Revision and evidence checks happen at completion. */
export async function attemptAgentWork(
  vault: AgentWorkPort,
  questionId: number,
  agent: AgentWorkAgent,
  signal?: AbortSignal,
): Promise<AgentWorkAttemptResult> {
  const snapshot = await vault.agentWork({ questionId, limit: 1 });
  const item = snapshot.items[0];
  if (item === undefined) {
    return Object.freeze({ kind: "not-found" as const, questionId });
  }
  if (item.readiness !== "ready") {
    return Object.freeze({
      kind: "not-ready" as const,
      item,
      reason: item.readinessReason,
    });
  }

  let decision: AgentWorkDecision;
  try {
    decision = await agent(item, signal);
  } catch (error) {
    return Object.freeze({
      kind: "failed" as const,
      item,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (decision.kind === "defer") {
    return Object.freeze({
      kind: "deferred" as const,
      item,
      reason: decision.reason,
    });
  }

  const input: CompleteAgentWorkInput = Object.freeze({
    questionId: item.questionId,
    expectedRevision: item.revision,
    answer: decision.answer,
    reason: decision.reason,
    evidence: decision.evidence,
  });
  const completed = await vault.completeAgentWork(input);
  switch (completed.kind) {
    case "completed":
    case "already-completed":
      return Object.freeze({ kind: completed.kind, item });
    case "not-found":
      return Object.freeze({ kind: "not-found" as const, questionId });
    case "rejected":
      return Object.freeze({
        kind: "rejected" as const,
        item,
        problem: completed.problem,
        message: completed.message,
      });
  }
}

export type DrainAgentWorkResult = {
  readonly schema: "dome.agent-work-drain/v1";
  readonly attempted: number;
  readonly results: ReadonlyArray<AgentWorkAttemptResult>;
  /** Fresh derived state after the bounded drain. */
  readonly remaining: AgentWorkSnapshot;
};

/**
 * Attempt a bounded ready set serially. Failures stay open and naturally
 * reappear next time; there is no retry table or claimed-job state to repair.
 */
export async function drainAgentWork(
  vault: AgentWorkPort,
  agent: AgentWorkAgent,
  opts?: { readonly limit?: number; readonly signal?: AbortSignal },
): Promise<DrainAgentWorkResult> {
  const limit = positiveLimit(opts?.limit, 5);
  const before = await vault.agentWork({ limit: 100 });
  const ready = before.items
    .filter((item) => item.readiness === "ready")
    .slice(0, limit);
  const results: AgentWorkAttemptResult[] = [];
  for (const item of ready) {
    if (opts?.signal?.aborted === true) break;
    results.push(
      await attemptAgentWork(vault, item.questionId, agent, opts?.signal),
    );
  }
  return Object.freeze({
    schema: "dome.agent-work-drain/v1" as const,
    attempted: results.length,
    results: Object.freeze(results),
    remaining: await vault.agentWork({ limit: 100 }),
  });
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? Math.min(value, 100)
    : fallback;
}
