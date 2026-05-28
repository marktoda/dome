import { createHash } from "node:crypto";

import {
  EffectSchema,
  type DiagnosticEffect,
  type Effect,
} from "../core/effect";
import type { ProcessorContext, ProcessorPhase } from "../core/processor";
import type { RunId } from "../engine/runner-contract";
import type { ResolvedExecutionPolicy } from "./execution-policy";
import {
  diagnosticForExecutionError,
  errorMessage,
  makeExecutionError,
  type ProcessorExecutionError,
} from "./execution-error";

export type ProcessorExecutionResult =
  | {
      readonly status: "succeeded";
      readonly runId: RunId;
      readonly processorId: string;
      readonly effects: ReadonlyArray<Effect>;
      readonly effectHashes: ReadonlyArray<string>;
      readonly durationMs: number;
    }
  | {
      readonly status: "failed";
      readonly runId: RunId;
      readonly processorId: string;
      readonly error: ProcessorExecutionError;
      readonly diagnostic: DiagnosticEffect;
      readonly durationMs: number;
    }
  | {
      readonly status: "timed_out";
      readonly runId: RunId;
      readonly processorId: string;
      readonly error: ProcessorExecutionError;
      readonly diagnostic: DiagnosticEffect;
      readonly durationMs: number;
    }
  | {
      readonly status: "cancelled";
      readonly runId: RunId;
      readonly processorId: string;
      readonly error: ProcessorExecutionError;
      readonly diagnostic: DiagnosticEffect;
      readonly durationMs: number;
    };

export async function executeProcessor(opts: {
  readonly processorId: string;
  readonly phase: ProcessorPhase;
  readonly runId: RunId;
  readonly ctx: ProcessorContext<unknown>;
  readonly policy: ResolvedExecutionPolicy;
  readonly run: (ctx: ProcessorContext<unknown>) => Promise<unknown>;
}): Promise<ProcessorExecutionResult> {
  const startedAt = performance.now();
  const durationMs = () => Math.max(0, performance.now() - startedAt);

  if (opts.ctx.signal.aborted) {
    return terminalResult({
      status: "cancelled",
      runId: opts.runId,
      processorId: opts.processorId,
      durationMs: durationMs(),
      error: makeExecutionError({
        code: "processor.cancelled",
        message: "Processor execution was cancelled.",
        retryable: opts.phase !== "adoption",
        phase: opts.phase,
        processorId: opts.processorId,
      }),
    });
  }

  const invocation = new AbortController();
  const invocationCtx = Object.freeze({
    ...opts.ctx,
    signal: invocation.signal,
  }) as ProcessorContext<unknown>;
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
    .then(() => opts.run(invocationCtx))
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
    opts.ctx.signal.addEventListener("abort", onAbort, { once: true });
  });

  const outcome = await Promise.race([runPromise, timeoutPromise, abortPromise]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (onAbort !== undefined) {
    opts.ctx.signal.removeEventListener("abort", onAbort);
  }

  switch (outcome.kind) {
    case "returned":
      return outputResult({
        value: outcome.value,
        runId: opts.runId,
        processorId: opts.processorId,
        phase: opts.phase,
        durationMs: durationMs(),
      });
    case "threw":
      return terminalResult({
        status: "failed",
        runId: opts.runId,
        processorId: opts.processorId,
        durationMs: durationMs(),
        error: makeExecutionError({
          code: "processor.threw",
          message: errorMessage(outcome.error),
          retryable: false,
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
          retryable: opts.phase !== "adoption",
          phase: opts.phase,
          processorId: opts.processorId,
        }),
      });
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
}): ProcessorExecutionResult {
  if (!Array.isArray(input.value)) {
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

  const effects: Array<Effect> = [];
  for (const [index, effect] of input.value.entries()) {
    let parsed: ReturnType<typeof EffectSchema.safeParse>;
    try {
      parsed = EffectSchema.safeParse(effect);
    } catch (e) {
      const error = makeExecutionError({
        code: "processor.invalid-output",
        message: `Processor returned invalid output at effect[${index}]: schema validation threw while accessing effect output: ${errorMessage(e)}`,
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

function terminalResult(input: {
  readonly status: "failed" | "timed_out" | "cancelled";
  readonly runId: RunId;
  readonly processorId: string;
  readonly error: ProcessorExecutionError;
  readonly durationMs: number;
}): ProcessorExecutionResult {
  return Object.freeze({
    status: input.status,
    runId: input.runId,
    processorId: input.processorId,
    error: input.error,
    diagnostic: diagnosticForExecutionError(input.error),
    durationMs: input.durationMs,
  });
}
