// cli/commands/agenda-with: wrapper for the dome.daily.agenda-with view.
//
// `dome today --with <person-or-topic>` filters the same source-backed daily
// action state as `dome today` down to items matching a person or topic, and
// joins adopted-state search context — the day surface's filtered framing,
// folded into the `today` verb (cohesion review 2026-07-06; formerly the
// top-level `dome agenda-with`). See docs/wiki/specs/cli.md §"`dome today`".

import { runNamedViewCommand } from "../named-view-command";
import { printViewCommandError } from "./view-shared";

export type AgendaWithCommandOptions = {
  readonly topic?: string | undefined;
  readonly date?: string | undefined;
  readonly limit?: number | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
};

export async function runAgendaWith(
  options: AgendaWithCommandOptions = {},
): Promise<number> {
  const topic = options.topic?.trim() ?? "";
  if (topic.length === 0) {
    printViewCommandError({
      commandLabel: "dome today --with",
      json: options.json === true,
      error: "agenda-with-usage",
      messages: [
        "dome today --with: missing person or topic. Usage: dome today --with <person-or-topic>",
      ],
    });
    return 64;
  }

  const commandArgs = Object.freeze({
    topic,
    ...(options.date !== undefined ? { date: options.date } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });

  return runNamedViewCommand({
    commandLabel: "dome today --with",
    commandName: "agenda-with",
    commandArgs,
    vault: options.vault,
    bundlesRoot: options.bundlesRoot,
    json: options.json === true,
    failedError: "agenda-with-failed",
    renderHuman: (data) => (data as { readonly markdown: string }).markdown,
  });
}
