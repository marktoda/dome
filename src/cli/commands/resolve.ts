// cli/commands/resolve: user-facing decision resolution.
//
// This is a friendly name over the existing QuestionEffect answer machinery.
// It deliberately does not add a second mutation path.

import { runAnswer, type RunAnswerOptions } from "./answer";

export type RunResolveOptions = RunAnswerOptions;

export async function runResolve(
  options: RunResolveOptions = {},
): Promise<number> {
  return runAnswer({
    ...options,
    commandLabel: "dome resolve",
  });
}
