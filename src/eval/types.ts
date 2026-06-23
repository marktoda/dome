import type { ModelStepProvider } from "../engine/core/model-invoke";

/**
 * One recorded model step. Each entry is a single `step()` invocation the
 * provider answered — the tool calls it returned (names only) and any
 * terminal text. The provider appends to `EvalEnv.trajectory` as it runs, so
 * the case can read the realized trajectory back after the engine drives it.
 *
 * Defined here (rather than in provider.ts) because `EvalEnv` carries the
 * `trajectory` array: keeping the type with `EvalEnv` avoids a types.ts →
 * provider.ts import cycle. `provider.ts` re-exports it for existing
 * consumers (`assertions.ts`, the provider tests).
 */
export type ToolCallTrace = {
  readonly step: number;
  readonly toolCalls: ReadonlyArray<{ name: string }>;
  readonly text: string | null;
};

export type EvalEnv = {
  readonly modelStepProvider: ModelStepProvider;
  readonly mode: "hermetic" | "live";
  /**
   * Live recording of every model step the provider answered during the
   * case's run. Both `hermeticEvalEnv` and `liveEvalEnv` attach this array
   * and wrap their provider to push a `ToolCallTrace` per call; the case
   * reads it back after driving the engine. This is what makes
   * `trajectoryReadsBeforeWrites` meaningful for both hermetic and `--live`
   * runs.
   */
  readonly trajectory: ToolCallTrace[];
};

export type Assertion<O> = (output: O) => string | null | Promise<string | null>;

export type EvalCase<O> = {
  readonly name: string;
  readonly run: (env: EvalEnv) => Promise<O>;
  readonly assertions: ReadonlyArray<Assertion<O>>;
};

export type EvalResult = {
  readonly case: string;
  readonly failures: ReadonlyArray<string>;
};

export type EvalReport = {
  readonly results: ReadonlyArray<EvalResult>;
  readonly passed: number;
  readonly failed: number;
};
