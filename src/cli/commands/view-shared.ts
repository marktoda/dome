// cli/commands/view-shared: CLI printers for view-command results.
//
// The protocol-neutral runners (`runSharedViewCommand`,
// `runStructuredViewCommand`) live in src/surface/view.ts; this module owns
// only the CLI's message channel — stderr for human mode, a structured
// error envelope on stdout for `--json`.

import { formatJson } from "../../surface/format";

export function printViewCommandMessages(
  messages: ReadonlyArray<string>,
): void {
  for (const message of messages) console.error(message);
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
