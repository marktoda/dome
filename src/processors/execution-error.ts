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
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    const json = JSON.stringify(e);
    if (json !== undefined) return json;
  } catch {
    // Fall through to String below.
  }
  return String(e);
}
