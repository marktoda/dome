import type { ModelStepProvider } from "../engine/core/model-invoke";

export type EvalEnv = {
  readonly modelStepProvider: ModelStepProvider;
  readonly mode: "hermetic" | "live";
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
