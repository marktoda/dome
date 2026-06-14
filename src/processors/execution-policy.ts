import type {
  ExecutionClass,
  ExecutionPolicyRequest,
  ProcessorPhase,
} from "../core/processor";
import { err, ok, type Result } from "../types";

export type { ExecutionPolicyRequest } from "../core/processor";

export type ExecutionPolicyCap = {
  readonly timeoutMs?: number;
  readonly modelCallTimeoutMs?: number;
};

export type ResolvedExecutionPolicy = {
  readonly class: ExecutionClass;
  readonly timeoutMs: number;
  readonly lateEffectBehavior: "discard";
  readonly modelCallTimeoutMs?: number;
};

export type ExecutionPolicyError = {
  readonly code: "execution-policy.phase-class-denied";
  readonly phase: ProcessorPhase;
  readonly class: ExecutionClass;
  readonly message: string;
};

/**
 * The hard ceiling for an adoption-phase deterministic timeout. Adoption is
 * the merge gate, so its DEFAULT stays low (10s — see the deterministic class
 * default) to keep the common single-file path fast. But a genuine whole-vault
 * adoption scan (e.g. `dome.markdown.duplicate-detection`, which reads and
 * parses every comparable page on each changed file) legitimately needs more
 * than 10s on a large vault, and silently timing out ~every tick wedges
 * adoption with zero health signal. A processor may therefore REQUEST a larger
 * deterministic timeout via its manifest `execution.timeoutMs`, clamped to this
 * ceiling — the gate stays bounded (it can never hang indefinitely), it just is
 * not pinned to the 10s default for the rare processor that opts in. A tighter
 * vault `processor_timeout_ms` cap still wins (it is a min, not a max).
 */
export const ADOPTION_DETERMINISTIC_TIMEOUT_CEILING_MS = 60_000;

export const DEFAULT_EXECUTION_POLICY_BY_CLASS: Readonly<
  Record<ExecutionClass, ResolvedExecutionPolicy>
> = Object.freeze({
  deterministic: Object.freeze({
    class: "deterministic",
    timeoutMs: 10_000,
    lateEffectBehavior: "discard",
  }),
  interactive: Object.freeze({
    class: "interactive",
    timeoutMs: 30_000,
    lateEffectBehavior: "discard",
  }),
  background: Object.freeze({
    class: "background",
    timeoutMs: 120_000,
    lateEffectBehavior: "discard",
  }),
  llm: Object.freeze({
    class: "llm",
    timeoutMs: 600_000,
    lateEffectBehavior: "discard",
    modelCallTimeoutMs: 180_000,
  }),
  batch: Object.freeze({
    class: "batch",
    timeoutMs: 600_000,
    lateEffectBehavior: "discard",
  }),
});

export function defaultExecutionClassForPhase(
  phase: ProcessorPhase,
): ExecutionClass {
  switch (phase) {
    case "adoption":
      return "deterministic";
    case "garden":
      return "background";
    case "view":
      return "interactive";
  }
}

export function resolveExecutionPolicy(opts: {
  readonly phase: ProcessorPhase;
  readonly request: ExecutionPolicyRequest | undefined;
  readonly vaultCap: ExecutionPolicyCap | undefined;
}): Result<ResolvedExecutionPolicy, ExecutionPolicyError> {
  const executionClass =
    opts.request?.class ?? defaultExecutionClassForPhase(opts.phase);
  if (opts.phase === "adoption" && executionClass !== "deterministic") {
    return err({
      code: "execution-policy.phase-class-denied",
      phase: opts.phase,
      class: executionClass,
      message: "Adoption processors must use deterministic execution.",
    });
  }

  const defaults = DEFAULT_EXECUTION_POLICY_BY_CLASS[executionClass];
  const requested = {
    class: executionClass,
    timeoutMs: opts.request?.timeoutMs ?? defaults.timeoutMs,
    lateEffectBehavior: defaults.lateEffectBehavior,
    modelCallTimeoutMs: opts.request?.modelCallTimeoutMs ?? defaults.modelCallTimeoutMs,
  };
  // Adoption stays bounded as the merge gate, but the cap is the adoption
  // ceiling (not the 10s default): a processor may request a longer
  // deterministic timeout for a heavy whole-vault scan, clamped to the ceiling.
  // With no explicit request the deterministic default (10s) flows through, so
  // the common path is unchanged.
  const phaseTimeoutCap =
    opts.phase === "adoption"
      ? ADOPTION_DETERMINISTIC_TIMEOUT_CEILING_MS
      : undefined;

  const resolved: {
    -readonly [K in keyof ResolvedExecutionPolicy]: ResolvedExecutionPolicy[K];
  } = {
    class: requested.class,
    timeoutMs: minDefined(
      requested.timeoutMs,
      opts.vaultCap?.timeoutMs,
      phaseTimeoutCap,
    ),
    lateEffectBehavior: requested.lateEffectBehavior,
  };

  const requestedModelCallTimeoutMs =
    requested.modelCallTimeoutMs !== undefined &&
    opts.vaultCap?.modelCallTimeoutMs !== undefined
      ? Math.min(requested.modelCallTimeoutMs, opts.vaultCap.modelCallTimeoutMs)
      : requested.modelCallTimeoutMs;
  if (requestedModelCallTimeoutMs !== undefined) {
    resolved.modelCallTimeoutMs = Math.min(
      requestedModelCallTimeoutMs,
      resolved.timeoutMs,
    );
  }

  return ok(Object.freeze(resolved));
}

function minDefined(value: number, ...caps: ReadonlyArray<number | undefined>): number {
  let result = value;
  for (const cap of caps) {
    if (cap !== undefined) result = Math.min(result, cap);
  }
  return result;
}
