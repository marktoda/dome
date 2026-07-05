// cli/commands/view-shared: CLI printers for view-command results.
//
// The protocol-neutral runners (`runSharedViewCommand`,
// `runStructuredViewCommand`) live in src/surface/view.ts; this module owns
// only the CLI's message channel — stderr for human mode, a structured
// error envelope on stdout for `--json`.

import { formatJson } from "../../surface/format";
import { reportMissFromCliFlag } from "../../surface/report-miss";

export function printViewCommandMessages(
  messages: ReadonlyArray<string>,
): void {
  for (const message of messages) console.error(message);
}

/**
 * The `--miss [note]` side channel shared by `dome query` and
 * `dome export-context`: after the command's own output has printed,
 * record the query as a retrieval miss (Task 12;
 * `src/surface/report-miss.ts`) and print a one-line acknowledgment to
 * stderr — stdout stays exclusively the command's own output/JSON.
 * No-ops (prints nothing) when `flag` is absent.
 */
export async function printMissOutcome(input: {
  readonly commandLabel: string;
  readonly vault: string;
  readonly query: string;
  readonly flag: string | boolean | undefined;
}): Promise<void> {
  const outcome = await reportMissFromCliFlag({
    vault: input.vault,
    query: input.query,
    flag: input.flag,
  });
  if (outcome === null) return;
  console.error(
    outcome.status === "recorded"
      ? `${input.commandLabel}: miss recorded (${outcome.commit.slice(0, 7)})`
      : `${input.commandLabel}: miss not recorded: ${outcome.message}`,
  );
}

export function printViewCommandError(opts: {
  readonly commandLabel: string;
  readonly json: boolean;
  readonly messages: ReadonlyArray<string>;
  readonly error?: string;
}): void {
  if (!opts.json) {
    printViewCommandMessages(opts.messages);
    return;
  }
  const message = opts.messages[0] ?? `${opts.commandLabel}: failed.`;
  console.log(
    formatJson({
      status: "error",
      error: opts.error ?? "view-command-failed",
      message,
      messages: opts.messages,
    }),
  );
}
