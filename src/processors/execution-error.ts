import { diagnosticEffect, type DiagnosticEffect } from "../core/effect";
import type { ProcessorPhase } from "../core/processor";

export type ProcessorExecutionErrorCode =
  | "processor.threw"
  | "processor.invalid-output"
  | "processor.timeout"
  | "processor.cancelled";

export type ProcessorExecutionError = {
  readonly code: ProcessorExecutionErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly phase: ProcessorPhase;
  readonly processorId: string;
};

export function makeExecutionError(
  input: ProcessorExecutionError,
): ProcessorExecutionError {
  return Object.freeze({ ...input });
}

export function executionErrorToJson(error: ProcessorExecutionError): string {
  return JSON.stringify(error);
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
