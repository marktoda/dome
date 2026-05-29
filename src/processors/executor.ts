import { createHash } from "node:crypto";

import {
  EffectSchema,
  type DiagnosticEffect,
  type Effect,
} from "../core/effect";
import { isTransientProcessorError } from "../core/processor-error";
import type { ProcessorContext, ProcessorPhase } from "../core/processor";
import { isModelExecutionError } from "../engine/model-invoke";
import type { RunId } from "../engine/runner-contract";
import type { ResolvedExecutionPolicy } from "./execution-policy";
import {
  diagnosticForExecutionError,
  errorMessage,
  makeExecutionError,
  type ProcessorCancelledExecutionError,
  type ProcessorFailedExecutionError,
  type ProcessorTimeoutExecutionError,
} from "./execution-error";

export const MAX_EFFECTS_PER_INVOCATION = 10_000;

export type ProcessorOutputPolicy = {
  readonly requireSourceBackedPatchEffects: boolean;
};

const DEFAULT_OUTPUT_POLICY: ProcessorOutputPolicy = Object.freeze({
  requireSourceBackedPatchEffects: false,
});

export type ProcessorExecutionResult =
  | ProcessorSucceededExecutionResult
  | ProcessorFailedExecutionResult
  | ProcessorTimedOutExecutionResult
  | ProcessorCancelledExecutionResult;

export type ProcessorSucceededExecutionResult = {
  readonly status: "succeeded";
  readonly runId: RunId;
  readonly processorId: string;
  readonly effects: ReadonlyArray<Effect>;
  readonly effectHashes: ReadonlyArray<string>;
  readonly durationMs: number;
};

export type ProcessorFailedExecutionResult = {
  readonly status: "failed";
  readonly runId: RunId;
  readonly processorId: string;
  readonly error: ProcessorFailedExecutionError;
  readonly diagnostic: DiagnosticEffect;
  readonly durationMs: number;
};

export type ProcessorTimedOutExecutionResult = {
  readonly status: "timed_out";
  readonly runId: RunId;
  readonly processorId: string;
  readonly error: ProcessorTimeoutExecutionError;
  readonly diagnostic: DiagnosticEffect;
  readonly durationMs: number;
};

export type ProcessorCancelledExecutionResult = {
  readonly status: "cancelled";
  readonly runId: RunId;
  readonly processorId: string;
  readonly error: ProcessorCancelledExecutionError;
  readonly diagnostic: DiagnosticEffect;
  readonly durationMs: number;
};

export async function executeProcessor(opts: {
  readonly processorId: string;
  readonly phase: ProcessorPhase;
  readonly runId: RunId;
  readonly signal?: AbortSignal;
  readonly makeContext: (signal: AbortSignal) => ProcessorContext<unknown>;
  readonly policy: ResolvedExecutionPolicy;
  readonly outputPolicy?: ProcessorOutputPolicy;
  readonly run: (ctx: ProcessorContext<unknown>) => Promise<unknown>;
}): Promise<ProcessorExecutionResult> {
  const startedAt = performance.now();
  const durationMs = () => Math.max(0, performance.now() - startedAt);

  if (opts.signal?.aborted === true) {
    return terminalResult({
      status: "cancelled",
      runId: opts.runId,
      processorId: opts.processorId,
      durationMs: durationMs(),
      error: makeExecutionError({
        code: "processor.cancelled",
        message: "Processor execution was cancelled.",
        retryable: false,
        phase: opts.phase,
        processorId: opts.processorId,
      }),
    });
  }

  const invocation = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let terminalOutcome:
    | { readonly kind: "timed_out" }
    | { readonly kind: "cancelled" }
    | undefined;

  const settleTerminal = (
    outcome:
      | { readonly kind: "timed_out" }
      | { readonly kind: "cancelled" },
  ): { readonly kind: "timed_out" } | { readonly kind: "cancelled" } => {
    if (terminalOutcome === undefined) {
      terminalOutcome = outcome;
      invocation.abort();
    }
    return terminalOutcome;
  };

  const runPromise: Promise<RunOutcome> = Promise.resolve()
    .then(() => opts.makeContext(invocation.signal))
    .then((invocationCtx) => opts.run(invocationCtx))
    .then(
      (value) => terminalOutcome ?? { kind: "returned", value },
      (error) => terminalOutcome ?? { kind: "threw", error },
    );
  const timeoutPromise = new Promise<RunOutcome>((resolve) => {
    timeout = setTimeout(
      () => resolve(settleTerminal({ kind: "timed_out" })),
      opts.policy.timeoutMs,
    );
  });
  const abortPromise = new Promise<RunOutcome>((resolve) => {
    onAbort = () => resolve(settleTerminal({ kind: "cancelled" }));
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });

  const outcome = await Promise.race([runPromise, timeoutPromise, abortPromise]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (onAbort !== undefined && opts.signal !== undefined) {
    opts.signal.removeEventListener("abort", onAbort);
  }

  switch (outcome.kind) {
    case "returned":
      return outputResult({
        value: outcome.value,
        runId: opts.runId,
        processorId: opts.processorId,
        phase: opts.phase,
        durationMs: durationMs(),
        outputPolicy: opts.outputPolicy ?? DEFAULT_OUTPUT_POLICY,
      });
    case "threw":
      return terminalResult({
        status: "failed",
        runId: opts.runId,
        processorId: opts.processorId,
        durationMs: durationMs(),
        error:
          specializedThrownExecutionError({
            error: outcome.error,
            phase: opts.phase,
            processorId: opts.processorId,
          }) ??
          makeExecutionError({
            code: "processor.threw",
            message: errorMessage(outcome.error),
            retryable: isRetryableThrownError(outcome.error, opts.phase),
            phase: opts.phase,
            processorId: opts.processorId,
          }),
      });
    case "timed_out":
      return terminalResult({
        status: "timed_out",
        runId: opts.runId,
        processorId: opts.processorId,
        durationMs: durationMs(),
        error: makeExecutionError({
          code: "processor.timeout",
          message: `Processor exceeded timeout of ${opts.policy.timeoutMs}ms.`,
          retryable: opts.phase !== "adoption",
          phase: opts.phase,
          processorId: opts.processorId,
        }),
      });
    case "cancelled":
      return terminalResult({
        status: "cancelled",
        runId: opts.runId,
        processorId: opts.processorId,
        durationMs: durationMs(),
        error: makeExecutionError({
          code: "processor.cancelled",
          message: "Processor execution was cancelled.",
          retryable: false,
          phase: opts.phase,
          processorId: opts.processorId,
        }),
      });
  }
}

function specializedThrownExecutionError(opts: {
  readonly error: unknown;
  readonly phase: ProcessorPhase;
  readonly processorId: string;
}): ProcessorFailedExecutionError | null {
  if (!isModelExecutionError(opts.error)) return null;
  return makeExecutionError({
    code: opts.error.code,
    message: errorMessage(opts.error),
    retryable: opts.error.retryable,
    phase: opts.phase,
    processorId: opts.processorId,
  });
}

function isRetryableThrownError(
  error: unknown,
  phase: ProcessorPhase,
): boolean {
  if (phase === "adoption") return false;
  try {
    return isTransientProcessorError(error);
  } catch {
    return false;
  }
}

export function hashEffect(effect: Effect): string {
  return createHash("sha256").update(JSON.stringify(effect)).digest("hex");
}

type RunOutcome =
  | { readonly kind: "returned"; readonly value: unknown }
  | { readonly kind: "threw"; readonly error: unknown }
  | { readonly kind: "timed_out" }
  | { readonly kind: "cancelled" };

function outputResult(input: {
  readonly value: unknown;
  readonly runId: RunId;
  readonly processorId: string;
  readonly phase: ProcessorPhase;
  readonly durationMs: number;
  readonly outputPolicy: ProcessorOutputPolicy;
}): ProcessorExecutionResult {
  let outputIsArray: boolean;
  try {
    outputIsArray = Array.isArray(input.value);
  } catch (e) {
    const error = makeExecutionError({
      code: "processor.invalid-output",
      message: `Processor returned invalid output: output container array check threw: ${errorMessage(e)}`,
      retryable: false,
      phase: input.phase,
      processorId: input.processorId,
    });
    return terminalResult({
      status: "failed",
      runId: input.runId,
      processorId: input.processorId,
      durationMs: input.durationMs,
      error,
    });
  }

  if (!outputIsArray) {
    const error = makeExecutionError({
      code: "processor.invalid-output",
      message: "Processor returned invalid output: expected an array of effects.",
      retryable: false,
      phase: input.phase,
      processorId: input.processorId,
    });
    return terminalResult({
      status: "failed",
      runId: input.runId,
      processorId: input.processorId,
      durationMs: input.durationMs,
      error,
    });
  }

  const output = input.value as {
    readonly length: unknown;
    readonly [index: number]: unknown;
  };
  let effectCount: unknown;
  try {
    effectCount = output.length;
  } catch (e) {
    const error = makeExecutionError({
      code: "processor.invalid-output",
      message: `Processor returned invalid output: output container length access threw: ${errorMessage(e)}`,
      retryable: false,
      phase: input.phase,
      processorId: input.processorId,
    });
    return terminalResult({
      status: "failed",
      runId: input.runId,
      processorId: input.processorId,
      durationMs: input.durationMs,
      error,
    });
  }
  if (
    typeof effectCount !== "number" ||
    !Number.isSafeInteger(effectCount) ||
    effectCount < 0
  ) {
    const error = makeExecutionError({
      code: "processor.invalid-output",
      message: "Processor returned invalid output: array length was invalid.",
      retryable: false,
      phase: input.phase,
      processorId: input.processorId,
    });
    return terminalResult({
      status: "failed",
      runId: input.runId,
      processorId: input.processorId,
      durationMs: input.durationMs,
      error,
    });
  }
  if (effectCount > MAX_EFFECTS_PER_INVOCATION) {
    const error = makeExecutionError({
      code: "processor.invalid-output",
      message: `Processor returned invalid output: too many effects (${effectCount}); limit is ${MAX_EFFECTS_PER_INVOCATION}.`,
      retryable: false,
      phase: input.phase,
      processorId: input.processorId,
    });
    return terminalResult({
      status: "failed",
      runId: input.runId,
      processorId: input.processorId,
      durationMs: input.durationMs,
      error,
    });
  }

  const effects: Array<Effect> = [];
  for (let index = 0; index < effectCount; index++) {
    let parsed: ReturnType<typeof EffectSchema.safeParse>;
    try {
      const effect = output[index];
      parsed = EffectSchema.safeParse(effect);
    } catch (e) {
      const error = makeExecutionError({
        code: "processor.invalid-output",
        message: `Processor returned invalid output at effect[${index}]: output access or schema validation threw: ${errorMessage(e)}`,
        retryable: false,
        phase: input.phase,
        processorId: input.processorId,
      });
      return terminalResult({
        status: "failed",
        runId: input.runId,
        processorId: input.processorId,
        durationMs: input.durationMs,
        error,
      });
    }
    if (!parsed.success) {
      const error = makeExecutionError({
        code: "processor.invalid-output",
        message: `Processor returned invalid output at effect[${index}]: ${parsed.error.message}`,
        retryable: false,
        phase: input.phase,
        processorId: input.processorId,
      });
      return terminalResult({
        status: "failed",
        runId: input.runId,
        processorId: input.processorId,
        durationMs: input.durationMs,
        error,
      });
    }
    effects.push(parsed.data as Effect);
  }

  const outputPolicyError = validateOutputPolicy({
    effects,
    outputPolicy: input.outputPolicy,
  });
  if (outputPolicyError !== null) {
    const error = makeExecutionError({
      code: "processor.invalid-output",
      message: outputPolicyError,
      retryable: false,
      phase: input.phase,
      processorId: input.processorId,
    });
    return terminalResult({
      status: "failed",
      runId: input.runId,
      processorId: input.processorId,
      durationMs: input.durationMs,
      error,
    });
  }

  let effectHashes: Array<string>;
  try {
    effectHashes = effects.map(hashEffect);
  } catch (e) {
    const error = makeExecutionError({
      code: "processor.invalid-output",
      message: `Processor returned output that could not be serialized to JSON for effect hashing: ${errorMessage(e)}`,
      retryable: false,
      phase: input.phase,
      processorId: input.processorId,
    });
    return terminalResult({
      status: "failed",
      runId: input.runId,
      processorId: input.processorId,
      durationMs: input.durationMs,
      error,
    });
  }

  const frozenEffects = Object.freeze(effects.slice());
  return Object.freeze({
    status: "succeeded",
    runId: input.runId,
    processorId: input.processorId,
    effects: frozenEffects,
    effectHashes: Object.freeze(effectHashes),
    durationMs: input.durationMs,
  });
}

function validateOutputPolicy(input: {
  readonly effects: ReadonlyArray<Effect>;
  readonly outputPolicy: ProcessorOutputPolicy;
}): string | null {
  if (!input.outputPolicy.requireSourceBackedPatchEffects) return null;
  for (const [index, effect] of input.effects.entries()) {
    if (effect.kind === "patch" && effect.sourceRefs.length === 0) {
      return (
        `Processor returned invalid output at effect[${index}]: ` +
        "model-capable processors must include at least one SourceRef on PatchEffect writes."
      );
    }
  }
  return null;
}

type TerminalResultInput =
  | {
      readonly status: "failed";
      readonly runId: RunId;
      readonly processorId: string;
      readonly error: ProcessorFailedExecutionError;
      readonly durationMs: number;
    }
  | {
      readonly status: "timed_out";
      readonly runId: RunId;
      readonly processorId: string;
      readonly error: ProcessorTimeoutExecutionError;
      readonly durationMs: number;
    }
  | {
      readonly status: "cancelled";
      readonly runId: RunId;
      readonly processorId: string;
      readonly error: ProcessorCancelledExecutionError;
      readonly durationMs: number;
    };

function terminalResult(
  input: TerminalResultInput,
):
  | ProcessorFailedExecutionResult
  | ProcessorTimedOutExecutionResult
  | ProcessorCancelledExecutionResult {
  switch (input.status) {
    case "failed":
      return Object.freeze({
        status: "failed",
        runId: input.runId,
        processorId: input.processorId,
        error: input.error,
        diagnostic: diagnosticForExecutionError(input.error),
        durationMs: input.durationMs,
      });
    case "timed_out":
      return Object.freeze({
        status: "timed_out",
        runId: input.runId,
        processorId: input.processorId,
        error: input.error,
        diagnostic: diagnosticForExecutionError(input.error),
        durationMs: input.durationMs,
      });
    case "cancelled":
      return Object.freeze({
        status: "cancelled",
        runId: input.runId,
        processorId: input.processorId,
        error: input.error,
        diagnostic: diagnosticForExecutionError(input.error),
        durationMs: input.durationMs,
      });
  }
}
