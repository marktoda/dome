// assistant/runtime: bounded, provider-neutral foreground-agent sessions.
// Conversation remains ephemeral; this Module owns admission, lifecycle,
// bounded history, one-active-turn serialization, and cancellation while the
// provider adapter remains behind AgentTurnRunner.

import { randomUUID } from "node:crypto";
import type { Capability } from "../capabilities";
import type { AuthenticatedMutationActor } from "../request-receipts/assistant-mutation-executor";

import type { AgentChange, AgentMessage, Citation } from "./types";

export type AgentDone = {
  readonly citations: ReadonlyArray<Citation>;
  readonly changes: ReadonlyArray<AgentChange>;
  readonly stopReason: "final" | "budget";
};

export type AgentRuntimeFailureCode =
  | "runtime-closed"
  | "session-limit"
  | "device-session-limit"
  | "session-expired"
  | "session-closed"
  | "session-busy"
  | "turn-capacity"
  | "device-turn-capacity"
  | "turn-limit"
  | "turn-timeout"
  | "message-empty"
  | "message-too-large"
  | "turn-cancelled"
  | "id-unavailable";

export type AgentRuntimeFailure = Readonly<{
  code: AgentRuntimeFailureCode;
  message: string;
  retryable: boolean;
}>;

export class AgentRuntimeError extends Error {
  readonly code: AgentRuntimeFailureCode;
  readonly retryable: boolean;

  constructor(readonly failure: AgentRuntimeFailure) {
    super(failure.message);
    this.name = "AgentRuntimeError";
    this.code = failure.code;
    this.retryable = failure.retryable;
  }
}

export type AgentEvent =
  | { readonly kind: "text"; readonly text: string }
  | ({ readonly kind: "done" } & AgentDone)
  | {
      readonly kind: "error";
      readonly message: string;
      readonly code?: AgentRuntimeFailureCode;
    };

export type AgentTurn = {
  readonly events: AsyncIterable<AgentEvent>;
  /** Present only when admission failed before a runner was started. */
  readonly failure?: AgentRuntimeFailure;
};

/** One provider adapter run, before the runtime adds session semantics. */
export type AgentRun = {
  readonly text: AsyncIterable<string>;
  readonly finished: Promise<AgentDone>;
};

export type AgentSessionCancelResult =
  | { readonly kind: "cancelled" }
  | { readonly kind: "idle" | "closed" };

export type AgentSession = {
  readonly id: string;
  readonly ownerDeviceId: string | null;
  send(message: string, signal?: AbortSignal, mutationActor?: AuthenticatedMutationActor): AgentTurn;
  cancel(): AgentSessionCancelResult;
};

export type AgentSessionContext = {
  readonly deviceId: string;
  readonly capabilities: ReadonlySet<Capability>;
};

export type AgentSessionCreateResult =
  | { readonly ok: true; readonly session: AgentSession }
  | { readonly ok: false; readonly failure: AgentRuntimeFailure };

export type AgentSessionLookupResult =
  | { readonly kind: "active"; readonly session: AgentSession }
  | { readonly kind: "expired"; readonly ownerDeviceId: string | null }
  | { readonly kind: "not-found" | "closed" | "runtime-closed" };

export type AgentRuntime = {
  /** Compatibility method: throws typed AgentRuntimeError on bounded admission failure. */
  createSession(context?: AgentSessionContext): AgentSession;
  tryCreateSession(context?: AgentSessionContext): AgentSessionCreateResult;
  /** Compatibility method: every non-active typed lookup maps to null. */
  getSession(id: string): AgentSession | null;
  lookupSession(id: string): AgentSessionLookupResult;
  closeSession(id: string): boolean;
  cancelSession(id: string): AgentSessionCancelResult;
  close(): void;
};

export type AgentTurnRunner = (input: {
  readonly question: string;
  readonly history: ReadonlyArray<AgentMessage>;
  readonly sessionContext?: AgentSessionContext | undefined;
  readonly mutationActor?: AuthenticatedMutationActor | undefined;
  readonly signal?: AbortSignal | undefined;
}) => AgentRun;

export type AgentRuntimeLimits = {
  readonly maxSessions: number;
  readonly maxSessionsPerDevice: number;
  readonly maxActiveTurns: number;
  readonly maxActiveTurnsPerDevice: number;
  readonly idleTtlMs: number;
  readonly absoluteTtlMs: number;
  readonly maxCompletedTurns: number;
  readonly maxHistoryMessages: number;
  readonly maxHistoryChars: number;
  readonly maxMessageChars: number;
  readonly turnTimeoutMs: number;
};

const DEFAULT_LIMITS: AgentRuntimeLimits = Object.freeze({
  maxSessions: 100,
  maxSessionsPerDevice: 10,
  maxActiveTurns: 10,
  maxActiveTurnsPerDevice: 2,
  idleTtlMs: 30 * 60 * 1_000,
  absoluteTtlMs: 24 * 60 * 60 * 1_000,
  maxCompletedTurns: 50,
  maxHistoryMessages: 20,
  maxHistoryChars: 64_000,
  maxMessageChars: 32_000,
  turnTimeoutMs: 120_000,
});

type SessionState = {
  readonly id: string;
  readonly messages: AgentMessage[];
  readonly context: AgentSessionContext | null;
  readonly createdAt: number;
  lastActivityAt: number;
  completedTurns: number;
  busy: boolean;
  closed: boolean;
  activeController: AbortController | null;
  activeTimer: ReturnType<typeof setTimeout> | null;
  activeStarted: boolean;
};

/**
 * Build the bounded in-memory session runtime shared by production and tests.
 * Expiry cleanup is lazy and deterministic: every create/lookup/access checks
 * the injected clock; absolute expiry also aborts an active runner on access.
 */
export function createAgentRuntime(opts: {
  readonly runTurn: AgentTurnRunner;
  readonly createId?: (() => string) | undefined;
  readonly now?: (() => Date | number) | undefined;
  readonly limits?: Partial<AgentRuntimeLimits> | undefined;
}): AgentRuntime {
  const sessions = new Map<string, SessionState>();
  const expiredOwners = new Map<string, { readonly ownerDeviceId: string | null; readonly expiredAt: number }>();
  const createId = opts.createId ?? randomUUID;
  const now = (): number => {
    const value = opts.now?.() ?? Date.now();
    return value instanceof Date ? value.getTime() : value;
  };
  const limits = resolveLimits(opts.limits);
  let runtimeClosed = false;

  const rememberExpired = (state: SessionState, at: number): void => {
    expiredOwners.delete(state.id);
    expiredOwners.set(state.id, {
      ownerDeviceId: state.context?.deviceId ?? null,
      expiredAt: at,
    });
    const cap = Math.max(1, limits.maxSessions * 2);
    while (expiredOwners.size > cap) {
      const oldest = expiredOwners.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      expiredOwners.delete(oldest);
    }
  };

  const expireIfNeeded = (state: SessionState, at: number): boolean => {
    const absoluteExpired = at - state.createdAt >= limits.absoluteTtlMs;
    const idleExpired = !state.busy && at - state.lastActivityAt >= limits.idleTtlMs;
    if (!absoluteExpired && !idleExpired) return false;
    rememberExpired(state, at);
    state.closed = true;
    state.activeController?.abort(failure("session-expired"));
    // A cancellation-resistant runner keeps consuming capacity until its
    // stream exits. Remove idle sessions immediately; active ones leave in
    // their `finally` after cooperative shutdown.
    if (!state.busy) sessions.delete(state.id);
    return true;
  };

  const cleanup = (at: number): void => {
    for (const state of sessions.values()) expireIfNeeded(state, at);
    for (const [id, expired] of expiredOwners) {
      if (at - expired.expiredAt >= limits.absoluteTtlMs) expiredOwners.delete(id);
    }
  };

  const cancelState = (state: SessionState): AgentSessionCancelResult => {
    if (state.closed) return { kind: "closed" };
    if (!state.busy || state.activeController === null) return { kind: "idle" };
    state.activeController.abort(failure("turn-cancelled"));
    if (!state.activeStarted) {
      if (state.activeTimer !== null) clearTimeout(state.activeTimer);
      state.activeTimer = null;
      state.activeController = null;
      state.busy = false;
      state.lastActivityAt = now();
    }
    return { kind: "cancelled" };
  };

  const bind = (state: SessionState): AgentSession => Object.freeze({
    id: state.id,
    ownerDeviceId: state.context?.deviceId ?? null,
    send(message: string, signal?: AbortSignal, mutationActor?: AuthenticatedMutationActor): AgentTurn {
      const at = now();
      if (runtimeClosed || state.closed) return failedTurn("session-closed");
      if (expireIfNeeded(state, at)) return failedTurn("session-expired");
      const question = message.trim();
      if (question.length === 0) return failedTurn("message-empty");
      if (question.length > limits.maxMessageChars) return failedTurn("message-too-large");
      if (state.completedTurns >= limits.maxCompletedTurns) return failedTurn("turn-limit");
      if (state.busy) return failedTurn("session-busy");
      const active = [...sessions.values()].filter((candidate) => candidate.busy);
      if (active.length >= limits.maxActiveTurns) return failedTurn("turn-capacity");
      const owner = state.context?.deviceId ?? null;
      if (active.filter(
        (candidate) => (candidate.context?.deviceId ?? null) === owner,
      ).length >= limits.maxActiveTurnsPerDevice) {
        return failedTurn("device-turn-capacity");
      }
      if (signal?.aborted === true) return failedTurn("turn-cancelled");

      const controller = new AbortController();
      const remainingAbsoluteMs = Math.max(1, limits.absoluteTtlMs - (at - state.createdAt));
      const timeout = setTimeout(
        () => {
          const absolute = now() - state.createdAt >= limits.absoluteTtlMs;
          if (absolute) {
            rememberExpired(state, now());
            state.closed = true;
          }
          controller.abort(failure(absolute ? "session-expired" : "turn-timeout"));
          if (!state.activeStarted && state.activeController === controller) {
            state.activeTimer = null;
            state.activeController = null;
            state.busy = false;
            state.lastActivityAt = now();
            if (state.closed) sessions.delete(state.id);
          }
        },
        Math.min(limits.turnTimeoutMs, remainingAbsoluteMs),
      );
      const forwardAbort = (): void => controller.abort(failure("turn-cancelled"));
      signal?.addEventListener("abort", forwardAbort, { once: true });
      state.busy = true;
      state.activeController = controller;
      state.activeTimer = timeout;
      state.activeStarted = false;
      state.lastActivityAt = at;
      const history = Object.freeze([...state.messages]);
      const trustedMutationActor = mutationActor !== undefined &&
          state.context !== null && mutationActor.deviceId === state.context.deviceId
        ? mutationActor
        : undefined;

      async function* events(): AsyncIterable<AgentEvent> {
        if (state.activeController === controller) state.activeStarted = true;
        let answer = "";
        try {
          if (controller.signal.aborted) {
            yield runtimeErrorEvent(abortCode(controller.signal));
            return;
          }
          const run = opts.runTurn({
            question,
            history,
            ...(state.context !== null ? { sessionContext: state.context } : {}),
            ...(trustedMutationActor !== undefined ? { mutationActor: trustedMutationActor } : {}),
            signal: controller.signal,
          });
          for await (const text of run.text) {
            if (controller.signal.aborted) {
              yield runtimeErrorEvent(abortCode(controller.signal));
              return;
            }
            answer += text;
            yield { kind: "text", text };
          }
          const finished = await run.finished;
          if (controller.signal.aborted) {
            yield runtimeErrorEvent(abortCode(controller.signal));
            return;
          }
          state.messages.push(
            Object.freeze({ role: "user" as const, content: question }),
            Object.freeze({ role: "assistant" as const, content: answer }),
          );
          pruneHistory(state.messages, limits);
          state.completedTurns += 1;
          yield {
            kind: "done",
            citations: Object.freeze([...finished.citations]),
            changes: Object.freeze([...finished.changes]),
            stopReason: finished.stopReason,
          };
        } catch (error) {
          if (controller.signal.aborted) {
            yield runtimeErrorEvent(abortCode(controller.signal));
          } else {
            yield {
              kind: "error",
              message: error instanceof Error ? error.message : String(error),
            };
          }
        } finally {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", forwardAbort);
          if (state.activeController === controller) {
            state.activeController = null;
            state.activeTimer = null;
            state.activeStarted = false;
            state.busy = false;
            state.lastActivityAt = now();
            if (state.closed) sessions.delete(state.id);
          }
        }
      }

      return Object.freeze({ events: events() });
    },
    cancel(): AgentSessionCancelResult {
      return cancelState(state);
    },
  });

  const tryCreateSession = (context?: AgentSessionContext): AgentSessionCreateResult => {
    if (runtimeClosed) return createFailed("runtime-closed");
    const at = now();
    cleanup(at);
    if (sessions.size >= limits.maxSessions) return createFailed("session-limit");
    const owner = context?.deviceId ?? null;
    const owned = [...sessions.values()].filter(
      (state) => (state.context?.deviceId ?? null) === owner,
    ).length;
    if (owned >= limits.maxSessionsPerDevice) {
      return createFailed("device-session-limit");
    }
    let id = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      id = createId();
      if (!sessions.has(id) && !expiredOwners.has(id)) break;
      id = "";
    }
    if (id === "") return createFailed("id-unavailable");
    const state: SessionState = {
      id,
      messages: [],
      context: context === undefined
        ? null
        : Object.freeze({
            deviceId: context.deviceId,
            capabilities: new Set(context.capabilities),
          }),
      createdAt: at,
      lastActivityAt: at,
      completedTurns: 0,
      busy: false,
      closed: false,
      activeController: null,
      activeTimer: null,
      activeStarted: false,
    };
    sessions.set(id, state);
    return Object.freeze({ ok: true as const, session: bind(state) });
  };

  const lookupSession = (id: string): AgentSessionLookupResult => {
    if (runtimeClosed) return { kind: "runtime-closed" };
    const expired = expiredOwners.get(id);
    if (expired !== undefined) {
      return { kind: "expired", ownerDeviceId: expired.ownerDeviceId };
    }
    const state = sessions.get(id);
    if (state === undefined) return { kind: "not-found" };
    if (state.closed) return { kind: "closed" };
    if (expireIfNeeded(state, now())) {
      return { kind: "expired", ownerDeviceId: state.context?.deviceId ?? null };
    }
    return Object.freeze({ kind: "active" as const, session: bind(state) });
  };

  return Object.freeze({
    createSession(context?: AgentSessionContext): AgentSession {
      const result = tryCreateSession(context);
      if (!result.ok) throw new AgentRuntimeError(result.failure);
      return result.session;
    },
    tryCreateSession,
    getSession(id: string): AgentSession | null {
      const result = lookupSession(id);
      return result.kind === "active" ? result.session : null;
    },
    lookupSession,
    closeSession(id: string): boolean {
      const state = sessions.get(id);
      if (state === undefined || state.closed) return false;
      state.closed = true;
      state.activeController?.abort(failure("session-closed"));
      if (!state.activeStarted) {
        if (state.activeTimer !== null) clearTimeout(state.activeTimer);
        state.activeTimer = null;
        state.activeController = null;
        state.busy = false;
      }
      if (!state.busy) sessions.delete(id);
      return true;
    },
    cancelSession(id: string): AgentSessionCancelResult {
      const result = lookupSession(id);
      return result.kind === "active" ? cancelState(sessions.get(id)!) : { kind: "closed" };
    },
    close(): void {
      if (runtimeClosed) return;
      runtimeClosed = true;
      for (const state of sessions.values()) {
        state.closed = true;
        if (!state.activeStarted && state.activeTimer !== null) clearTimeout(state.activeTimer);
        state.activeController?.abort(failure("session-closed"));
      }
      sessions.clear();
    },
  });
}

function resolveLimits(input: Partial<AgentRuntimeLimits> | undefined): AgentRuntimeLimits {
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...input });
  for (const [name, value] of Object.entries(limits)) {
    const permitsZero = name === "maxHistoryMessages" || name === "maxHistoryChars";
    if (!Number.isInteger(value) || value < (permitsZero ? 0 : 1)) {
      throw new RangeError(`${name} must be ${permitsZero ? "a nonnegative" : "a positive"} integer`);
    }
  }
  return limits;
}

function pruneHistory(messages: AgentMessage[], limits: AgentRuntimeLimits): void {
  let characters = messages.reduce((sum, message) => sum + message.content.length, 0);
  while (
    messages.length > 0 &&
    (messages.length > limits.maxHistoryMessages || characters > limits.maxHistoryChars)
  ) {
    const removed = messages.splice(0, Math.min(2, messages.length));
    characters -= removed.reduce((sum, message) => sum + message.content.length, 0);
  }
}

function abortCode(signal: AbortSignal): "session-expired" | "session-closed" | "turn-cancelled" | "turn-timeout" {
  const reason: unknown = signal.reason;
  if (
    typeof reason === "object" && reason !== null && "code" in reason &&
    (reason as { readonly code?: unknown }).code === "session-expired"
  ) return "session-expired";
  if (
    typeof reason === "object" && reason !== null && "code" in reason &&
    (reason as { readonly code?: unknown }).code === "session-closed"
  ) return "session-closed";
  if (
    typeof reason === "object" && reason !== null && "code" in reason &&
    (reason as { readonly code?: unknown }).code === "turn-timeout"
  ) return "turn-timeout";
  return "turn-cancelled";
}

function runtimeErrorEvent(
  code: "session-expired" | "session-closed" | "turn-cancelled" | "turn-timeout",
): Extract<AgentEvent, { readonly kind: "error" }> {
  const problem = failure(code);
  return Object.freeze({ kind: "error", code, message: problem.message });
}

function failedTurn(code: AgentRuntimeFailureCode): AgentTurn {
  const problem = failure(code);
  return Object.freeze({
    failure: problem,
    events: (async function* (): AsyncIterable<AgentEvent> {
      yield Object.freeze({ kind: "error" as const, code, message: problem.message });
    })(),
  });
}

function createFailed(code: AgentRuntimeFailureCode): AgentSessionCreateResult {
  return Object.freeze({ ok: false as const, failure: failure(code) });
}

function failure(code: AgentRuntimeFailureCode): AgentRuntimeFailure {
  const values: Record<AgentRuntimeFailureCode, readonly [string, boolean]> = {
    "runtime-closed": ["agent runtime is closed", false],
    "session-limit": ["agent session capacity is full", true],
    "device-session-limit": ["device agent session capacity is full", true],
    "session-expired": ["agent session expired", false],
    "session-closed": ["agent session is closed", false],
    "session-busy": ["agent session already has a turn in progress", true],
    "turn-capacity": ["agent active-turn capacity is full", true],
    "device-turn-capacity": ["device active-turn capacity is full", true],
    "turn-limit": ["agent session completed-turn limit reached", false],
    "turn-timeout": ["agent turn timed out", true],
    "message-empty": ["message must not be empty", false],
    "message-too-large": ["message exceeds the agent session limit", false],
    "turn-cancelled": ["agent turn cancelled", true],
    "id-unavailable": ["could not allocate an agent session id", true],
  };
  const [message, retryable] = values[code];
  return Object.freeze({ code, message, retryable });
}
