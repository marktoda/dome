// src/http/agent-log.ts
//
// Structured per-agent-turn log. One JSON line per request, appended to a
// configurable file. When no path is configured the sink is a no-op and has
// zero runtime cost. The sink MUST NEVER throw into the request path — any
// write error is caught and logged to stderr, not propagated.
//
// This is a process-scoped operational append-only log; not a vault write.
// Same boundary class as the server's POST /transcribe temp-write — allowed
// in the mutation-fence test (tests/integration/no-direct-mutation-outside-boundaries.test.ts).

import { appendFileSync } from "node:fs";

// ----- Public types ----------------------------------------------------------

export type AgentLogEntry = {
  readonly ts: string;
  readonly route: "/sessions/:id/messages";
  readonly question: string;
  readonly capabilities: ReadonlyArray<string>;
  readonly authorEnabled: boolean;
  readonly changes: ReadonlyArray<{ readonly path: string; readonly kind: string }>;
  readonly stopReason: string | null;
  readonly answerPreview: string | null;
  readonly durationMs: number;
  readonly error: string | null;
};

/** Fire-and-forget sink. MUST NOT throw into the request path. */
export type AgentLogSink = (entry: AgentLogEntry) => void;

// ----- Implementation --------------------------------------------------------

const TRUNCATE = 500;

/** Truncate a string to at most `max` characters. */
function trunc(s: string, max = TRUNCATE): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Build a log sink from an optional file path.
 * - `undefined` → no-op, zero cost.
 * - A path → append-only JSON-line sink; write errors are caught, logged to
 *   stderr as `http.agent.log_write_failed`, and never propagated.
 */
export function makeAgentLogSink(path: string | undefined): AgentLogSink {
  if (path === undefined) {
    return () => {};
  }

  return (entry: AgentLogEntry): void => {
    // Truncate variable-length fields before serializing.
    const safe: AgentLogEntry = {
      ...entry,
      question: trunc(entry.question),
      answerPreview:
        entry.answerPreview !== null ? trunc(entry.answerPreview) : null,
    };
    const line = JSON.stringify(safe) + "\n";
    // Synchronous append: the write is small (one JSON line) and happens after
    // the response is formed — acceptable latency. Synchronous avoids a
    // fire-and-forget timing gap that would make tests flaky, and errors are
    // still caught so they never propagate into the request path.
    try {
      appendFileSync(path, line, "utf8");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[http.agent.log_write_failed] failed to write agent log entry to ${path}: ${message}`,
      );
    }
  };
}
