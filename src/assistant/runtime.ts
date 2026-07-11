// assistant/runtime: the provider-neutral foreground-agent seam.
//
// The HTTP/PWA protocol speaks AgentEvent and session ids from this module;
// provider SDK stream parts stay behind AgentTurnRunner. The built-in adapter
// supplies a runner backed by runAgentStream, while tests and future
// Claude/Codex/local-model adapters can supply independent implementations.

import { randomUUID } from "node:crypto";

import type {
  AgentChange,
  AgentMessage,
  Citation,
} from "./types";

export type AgentDone = {
  readonly citations: ReadonlyArray<Citation>;
  readonly changes: ReadonlyArray<AgentChange>;
  readonly stopReason: "final" | "budget";
};

export type AgentEvent =
  | { readonly kind: "text"; readonly text: string }
  | ({ readonly kind: "done" } & AgentDone)
  | { readonly kind: "error"; readonly message: string };

export type AgentTurn = {
  readonly events: AsyncIterable<AgentEvent>;
};

/** One provider adapter run, before the runtime adds session semantics. */
export type AgentRun = {
  readonly text: AsyncIterable<string>;
  readonly finished: Promise<AgentDone>;
};

export type AgentSession = {
  readonly id: string;
  send(message: string, signal?: AbortSignal): AgentTurn;
};

export type AgentRuntime = {
  createSession(): AgentSession;
  getSession(id: string): AgentSession | null;
  closeSession(id: string): boolean;
  close(): void;
};

export type AgentTurnRunner = (input: {
  readonly question: string;
  readonly history: ReadonlyArray<AgentMessage>;
  readonly signal?: AbortSignal | undefined;
}) => AgentRun;

type SessionState = {
  readonly id: string;
  readonly messages: AgentMessage[];
  busy: boolean;
  closed: boolean;
};

/**
 * Build the in-memory session runtime shared by the built-in production agent
 * and hermetic test adapters. History becomes durable only when a future
 * implementation replaces this adapter; no engine/projection state is used.
 */
export function createAgentRuntime(opts: {
  readonly runTurn: AgentTurnRunner;
  readonly createId?: (() => string) | undefined;
}): AgentRuntime {
  const sessions = new Map<string, SessionState>();
  const createId = opts.createId ?? randomUUID;
  let runtimeClosed = false;

  const bind = (state: SessionState): AgentSession => Object.freeze({
    id: state.id,
    send(message: string, signal?: AbortSignal): AgentTurn {
      const question = message.trim();
      if (question.length === 0) {
        return oneEvent({ kind: "error", message: "message must not be empty" });
      }
      if (runtimeClosed || state.closed) {
        return oneEvent({ kind: "error", message: "agent session is closed" });
      }
      if (state.busy) {
        return oneEvent({ kind: "error", message: "agent session already has a turn in progress" });
      }

      state.busy = true;
      const history = Object.freeze([...state.messages]);

      async function* events(): AsyncIterable<AgentEvent> {
        let answer = "";
        try {
          const run = opts.runTurn({
            question,
            history,
            ...(signal !== undefined ? { signal } : {}),
          });
          for await (const text of run.text) {
            answer += text;
            yield { kind: "text", text };
          }
          const finished = await run.finished;
          if (signal?.aborted === true) {
            yield { kind: "error", message: "agent turn aborted" };
            return;
          }
          state.messages.push(
            Object.freeze({ role: "user" as const, content: question }),
            Object.freeze({ role: "assistant" as const, content: answer }),
          );
          yield {
            kind: "done",
            citations: Object.freeze([...finished.citations]),
            changes: Object.freeze([...finished.changes]),
            stopReason: finished.stopReason,
          };
        } catch (error) {
          yield {
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          };
        } finally {
          state.busy = false;
        }
      }

      return Object.freeze({ events: events() });
    },
  });

  return Object.freeze({
    createSession(): AgentSession {
      if (runtimeClosed) throw new Error("agent runtime is closed");
      let id = createId();
      while (sessions.has(id)) id = createId();
      const state: SessionState = {
        id,
        messages: [],
        busy: false,
        closed: false,
      };
      sessions.set(id, state);
      return bind(state);
    },

    getSession(id: string): AgentSession | null {
      if (runtimeClosed) return null;
      const state = sessions.get(id);
      return state === undefined || state.closed ? null : bind(state);
    },

    closeSession(id: string): boolean {
      const state = sessions.get(id);
      if (state === undefined || state.closed) return false;
      state.closed = true;
      sessions.delete(id);
      return true;
    },

    close(): void {
      runtimeClosed = true;
      for (const state of sessions.values()) state.closed = true;
      sessions.clear();
    },
  });
}

function oneEvent(event: AgentEvent): AgentTurn {
  return Object.freeze({
    events: (async function* (): AsyncIterable<AgentEvent> {
      yield event;
    })(),
  });
}
