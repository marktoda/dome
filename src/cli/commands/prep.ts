// cli/commands/prep: first-class wrapper for the dome.daily.prep view.
//
// `dome prep` renders a portable source-backed planning packet for a day —
// the same `dome.daily.prep` view processor previously reachable only via
// the hidden `dome run prep` dispatcher. See docs/wiki/specs/cli.md
// §"`dome prep`".

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
    commandLabel: "dome prep",
    commandName: "prep",
    commandArgs,
    vault: options.vault,
    bundlesRoot: options.bundlesRoot,
    json: options.json === true,
    failedError: "prep-failed",
    renderHuman: (data) => (data as { readonly markdown: string }).markdown,
  });
}
