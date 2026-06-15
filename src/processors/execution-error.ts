import { diagnosticEffect, type DiagnosticEffect } from "../core/effect";
import type { ProcessorExecutionError } from "../engine/core/runner-contract";

export type {
  ProcessorCancelledExecutionError,
  ProcessorExecutionError,
  ProcessorExecutionErrorCode,
  ProcessorExecutionErrorForCode,
  ProcessorFailedExecutionError,
  ProcessorTimeoutExecutionError,
} from "../engine/core/runner-contract";

export function makeExecutionError<T extends ProcessorExecutionError>(
  input: T,
): T {
  return Object.freeze({ ...input }) as T;
}

export function diagnosticForExecutionError(
  error: ProcessorExecutionError,
): DiagnosticEffect {
  return diagnosticEffect({
    severity: error.phase === "adoption" ? "block" : "error",
    code: error.code,
    message: `${error.processorId}: ${error.message}`,
    sourceRefs: [],
  });
}

export function errorMessage(e: unknown): string {
  try {
    if (e instanceof Error) {
      try {
        return e.message;
      } catch {
        return "[unprintable Error message]";
      }
    }
  } catch {
    // Fall through to other formatting paths.
  }
  try {
    if (typeof e === "string") return e;
  } catch {
    // Fall through to JSON formatting.
  }
  try {
    const json = JSON.stringify(e);
    if (json !== undefined) return json;
  } catch {
    // Fall through to String below.
  }
  try {
    return String(e);
  } catch {
    return "[unprintable thrown value]";
  }
}
