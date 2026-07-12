/**
 * Versioned agent event stream shared by the host and browser client.
 * This companion contract intentionally has no Zod/runtime dependency: the
 * PWA is independently installable and the stateful SSE invariants (terminal
 * ordering, byte budgets, fragmented UTF-8) require the decoder regardless.
 * The small exact-shape checks below keep that one Interface self-contained.
 */
export const AGENT_STREAM_SCHEMA = "dome.agent.stream/v1" as const;

export type AgentStreamCitation = {
  readonly path: string;
  readonly commit?: string;
  readonly snippet?: string;
};

export type AgentStreamChange = {
  readonly path: string;
  readonly kind: "create" | "edit" | "capture" | "settle" | "resolve" | "apply" | "reject";
};

export type AgentStreamEvent =
  | {
      readonly schema: typeof AGENT_STREAM_SCHEMA;
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly schema: typeof AGENT_STREAM_SCHEMA;
      readonly type: "done";
      readonly citations: AgentStreamCitation[];
      readonly stopReason: "final" | "budget";
      readonly changes?: AgentStreamChange[];
    }
  | {
      readonly schema: typeof AGENT_STREAM_SCHEMA;
      readonly type: "error";
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };

export type AgentStreamDecoderOptions = {
  /** Maximum bytes in one SSE frame, excluding its blank-line delimiter. */
  readonly maxFrameBytes?: number;
  /** Maximum UTF-8 bytes across all text events in one response. */
  readonly maxTextBytes?: number;
};

export type AgentStreamDecoder = {
  /** Consume one arbitrarily fragmented response-body chunk. */
  readonly push: (chunk: Uint8Array) => ReadonlyArray<AgentStreamEvent>;
  /** Assert that EOF followed one, and only one, terminal event. */
  readonly finish: () => void;
};

export type AgentStreamProtocolErrorCode =
  | "frame-too-large"
  | "invalid-utf8"
  | "invalid-frame"
  | "invalid-json"
  | "invalid-schema"
  | "text-too-large"
  | "multiple-terminal-events"
  | "event-after-terminal"
  | "partial-frame"
  | "premature-eof";

export class AgentStreamProtocolError extends Error {
  readonly name = "AgentStreamProtocolError";

  constructor(readonly code: AgentStreamProtocolErrorCode, message: string) {
    super(message);
  }
}

const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;
const DEFAULT_MAX_TEXT_BYTES = 2 * 1024 * 1024;
const EMPTY = new Uint8Array(0);

/**
 * Create a strict, dependency-light SSE decoder.
 *
 * The decoder accepts only one `data: <json>` line per non-empty frame. JSON
 * and event shapes are validated at the wire seam. A stream is complete only
 * after exactly one `done` or `error` terminal and EOF immediately after it.
 */
export function createAgentStreamDecoder(
  options: AgentStreamDecoderOptions = {},
): AgentStreamDecoder {
  const maxFrameBytes = positiveLimit(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, "maxFrameBytes");
  const maxTextBytes = positiveLimit(options.maxTextBytes, DEFAULT_MAX_TEXT_BYTES, "maxTextBytes");
  let pending: Uint8Array = EMPTY;
  let textBytes = 0;
  let terminal = false;

  return {
    push(chunk) {
      if (!(chunk instanceof Uint8Array)) {
        throw protocolError("invalid-frame", "agent stream chunks must be Uint8Array values");
      }
      if (chunk.byteLength === 0) return [];
      if (terminal) {
        throw protocolError("event-after-terminal", "agent stream has bytes after its terminal event");
      }

      pending = appendBytes(pending, chunk);
      const events: AgentStreamEvent[] = [];
      for (;;) {
        const delimiter = findFrameDelimiter(pending);
        if (delimiter === null) {
          // Three bytes may be a fragmented CRLF/CRLF delimiter. The frame
          // itself is still checked exactly once the delimiter completes.
          if (pending.byteLength > maxFrameBytes + 3) {
            throw protocolError("frame-too-large", `agent stream frame exceeds ${maxFrameBytes} bytes`);
          }
          return events;
        }
        if (delimiter.index > maxFrameBytes) {
          throw protocolError("frame-too-large", `agent stream frame exceeds ${maxFrameBytes} bytes`);
        }

        const frame = pending.subarray(0, delimiter.index);
        pending = pending.slice(delimiter.index + delimiter.length);
        if (frame.byteLength === 0) continue;

        const event = parseFrame(frame);
        if (terminal) {
          throw protocolError(
            event.type === "text" ? "event-after-terminal" : "multiple-terminal-events",
            event.type === "text"
              ? "agent stream has an event after its terminal event"
              : "agent stream has multiple terminal events",
          );
        }
        if (event.type === "text") {
          textBytes += utf8Length(event.text);
          if (textBytes > maxTextBytes) {
            throw protocolError("text-too-large", `agent stream text exceeds ${maxTextBytes} bytes`);
          }
        } else {
          terminal = true;
        }
        events.push(event);
      }
    },

    finish() {
      if (pending.byteLength > 0) {
        throw protocolError("partial-frame", "agent stream ended with a partial frame");
      }
      if (!terminal) {
        throw protocolError("premature-eof", "agent stream ended before a terminal event");
      }
    },
  };
}

/** Validate and encode one server event as one SSE frame. */
export function encodeAgentStreamEvent(event: AgentStreamEvent): Uint8Array {
  const validated = parseAgentStreamEvent(event);
  return new TextEncoder().encode(`data: ${JSON.stringify(validated)}\n\n`);
}

/** Validate an independently decoded event at the shared contract seam. */
export function parseAgentStreamEvent(value: unknown): AgentStreamEvent {
  if (!isRecord(value) || value.schema !== AGENT_STREAM_SCHEMA || typeof value.type !== "string") {
    throw protocolError("invalid-schema", `agent stream event must use ${AGENT_STREAM_SCHEMA}`);
  }

  if (value.type === "text") {
    exactKeys(value, ["schema", "type", "text"]);
    if (typeof value.text !== "string" || value.text.length === 0) {
      throw protocolError("invalid-schema", "agent stream text must be a non-empty string");
    }
    return value as AgentStreamEvent;
  }

  if (value.type === "error") {
    exactKeys(value, ["schema", "type", "code", "message", "retryable"]);
    if (
      typeof value.code !== "string" || value.code.length === 0 ||
      typeof value.message !== "string" || value.message.length === 0 ||
      typeof value.retryable !== "boolean"
    ) {
      throw protocolError("invalid-schema", "agent stream error must have code, message, and retryable fields");
    }
    return value as AgentStreamEvent;
  }

  if (value.type === "done") {
    exactKeys(value, value.changes === undefined
      ? ["schema", "type", "citations", "stopReason"]
      : ["schema", "type", "citations", "stopReason", "changes"]);
    if (value.stopReason !== "final" && value.stopReason !== "budget") {
      throw protocolError("invalid-schema", "agent stream done event has an invalid stopReason");
    }
    if (!Array.isArray(value.citations) || !value.citations.every(isCitation)) {
      throw protocolError("invalid-schema", "agent stream done event has invalid citations");
    }
    if (value.changes !== undefined && (!Array.isArray(value.changes) || !value.changes.every(isChange))) {
      throw protocolError("invalid-schema", "agent stream done event has invalid changes");
    }
    return value as AgentStreamEvent;
  }

  throw protocolError("invalid-schema", "agent stream event has an unknown type");
}

function parseFrame(frame: Uint8Array): AgentStreamEvent {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
  } catch {
    throw protocolError("invalid-utf8", "agent stream frame is not valid UTF-8");
  }
  const lines = text.split(/\r?\n/);
  if (lines.length !== 1 || !lines[0]!.startsWith("data:")) {
    throw protocolError("invalid-frame", "agent stream frame must contain exactly one data line");
  }
  const json = lines[0]!.slice("data:".length).trimStart();
  if (json.length === 0) {
    throw protocolError("invalid-json", "agent stream data line is empty");
  }
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    throw protocolError("invalid-json", "agent stream data is not valid JSON");
  }
  return parseAgentStreamEvent(value);
}

function findFrameDelimiter(bytes: Uint8Array): { readonly index: number; readonly length: 2 | 4 } | null {
  for (let index = 0; index < bytes.byteLength - 1; index += 1) {
    if (bytes[index] === 10 && bytes[index + 1] === 10) return { index, length: 2 };
    if (
      bytes[index] === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    ) {
      return { index, length: 4 };
    }
  }
  return null;
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right.slice();
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left);
  joined.set(right, left.byteLength);
  return joined;
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return limit;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isCitation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const optional = ["commit", "snippet"].filter((key) => value[key] !== undefined);
  try {
    exactKeys(value, ["path", ...optional]);
  } catch {
    return false;
  }
  return nonEmptyString(value.path) &&
    (value.commit === undefined || nonEmptyString(value.commit)) &&
    (value.snippet === undefined || typeof value.snippet === "string");
}

const CHANGE_KINDS = new Set(["create", "edit", "capture", "settle", "resolve", "apply", "reject"]);

function isChange(value: unknown): boolean {
  if (!isRecord(value)) return false;
  try {
    exactKeys(value, ["path", "kind"]);
  } catch {
    return false;
  }
  return nonEmptyString(value.path) && typeof value.kind === "string" && CHANGE_KINDS.has(value.kind);
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlyArray<string>): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw protocolError("invalid-schema", "agent stream event contains unexpected or missing fields");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function protocolError(code: AgentStreamProtocolErrorCode, message: string): AgentStreamProtocolError {
  return new AgentStreamProtocolError(code, message);
}
