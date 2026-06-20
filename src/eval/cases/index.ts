// The eval case registry. The CLI (Task 6) imports `ALL_EVAL_CASES` and runs
// each through `runEvalSuite`.

import type { EvalCase } from "../types";
import { briefCase } from "./brief";

export const ALL_EVAL_CASES: ReadonlyArray<EvalCase<unknown>> = Object.freeze([
  briefCase as EvalCase<unknown>,
]);
