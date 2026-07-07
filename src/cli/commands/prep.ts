// cli/commands/prep: wrapper for the dome.daily.prep view.
//
// `dome today --prep` renders a portable source-backed planning packet for a
// day — the day surface's planning framing, folded into the `today` verb
// (cohesion review 2026-07-06; formerly the top-level `dome prep`). See
// docs/wiki/specs/cli.md §"`dome today`".

import { runNamedViewCommand } from "../named-view-command";

export type PrepCommandOptions = {
  readonly date?: string | undefined;
  readonly limit?: number | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
};

export async function runPrep(
  options: PrepCommandOptions = {},
): Promise<number> {
  const commandArgs = Object.freeze({
    ...(options.date !== undefined ? { date: options.date } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });

  return runNamedViewCommand({
    commandLabel: "dome today --prep",
    commandName: "prep",
    commandArgs,
    vault: options.vault,
    bundlesRoot: options.bundlesRoot,
    json: options.json === true,
    failedError: "prep-failed",
    renderHuman: (data) => (data as { readonly markdown: string }).markdown,
  });
}
