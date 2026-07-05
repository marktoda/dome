// cli/commands/agenda-with: first-class wrapper for the
// dome.daily.agenda-with view.
//
// `dome agenda-with <person-or-topic>` filters the same source-backed daily
// action state as `dome prep` / `dome today` down to items matching a person
// or topic, and joins adopted-state search context. Previously reachable
// only via the hidden `dome run agenda-with` dispatcher. See
// docs/wiki/specs/cli.md §"`dome agenda-with`".

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
      commandLabel: "dome agenda-with",
      json: options.json === true,
      error: "agenda-with-usage",
      messages: [
        "dome agenda-with: missing person or topic. Usage: dome agenda-with <person-or-topic>",
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
    commandLabel: "dome agenda-with",
    commandName: "agenda-with",
    commandArgs,
    vault: options.vault,
    bundlesRoot: options.bundlesRoot,
    json: options.json === true,
    failedError: "agenda-with-failed",
    renderHuman: (data) => (data as { readonly markdown: string }).markdown,
  });
}
