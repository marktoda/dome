// cli/structured-view-command: the shared CLI scaffold for first-party
// structured-view verbs (`dome query`, `dome export-context`, `dome lint`).
//
// Each of those commands is the same skeleton once its usage-guard has run:
// call `runStructuredViewCommand` for its `FirstPartyViewEntry`, render the
// error path through `printViewCommandError`, surface broker diagnostics, then
// branch JSON-vs-human and return an exit code — all wrapped in a try/catch
// that maps any thrown error to the command's `<name>-failed` envelope.
//
// Only the arg-building (caller-side, before this runs), the human renderer,
// and lint's data-derived success exit code differ; everything else lives here
// so the three commands stay ~15 lines each. `dome run` (stringly-typed
// dynamic dispatch) and `dome today` (its own not-found/watch rendering) do
// NOT route through here.

import { formatJson } from "../surface/format";
import {
  runStructuredViewCommand,
  structuredViewBrokerMessages,
} from "../surface/view";
import type { FirstPartyViewEntry } from "../surface/view-catalog";
import {
  printViewCommandError,
  printViewCommandMessages,
} from "./commands/view-shared";

export type CliStructuredViewOptions<TPayload = unknown> = {
  /** Operator-facing command label, e.g. "dome query". */
  readonly commandLabel: string;
  /** The first-party view this verb wraps. */
  readonly entry: FirstPartyViewEntry<TPayload>;
  /** Structured args handed to the processor (already built by the caller). */
  readonly commandArgs?: unknown;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  /** Whether `--json` was requested. */
  readonly json: boolean;
  /** Per-caller override for the no-structured-result wording. */
  readonly noStructuredResultMessage: string;
  /** The `error` tag used in the `<name>-failed` JSON envelope. */
  readonly failedError: string;
  /** Renders the human (non-JSON) output from the validated payload. */
  readonly renderHuman: (data: TPayload) => string;
  /**
   * Success exit code derived from the validated payload (default 0). lint
   * maps a `fail` status to 1; query/export-context always succeed with 0.
   * Called inside the shared try/catch, so a throw here lands in
   * `<name>-failed`.
   */
  readonly successExitCode?: (data: TPayload) => number;
};

export async function runCliStructuredView<TPayload>(
  opts: CliStructuredViewOptions<TPayload>,
): Promise<number> {
  try {
    const run = await runStructuredViewCommand({
      commandLabel: opts.commandLabel,
      entry: opts.entry,
      commandArgs: opts.commandArgs,
      vault: opts.vault,
      bundlesRoot: opts.bundlesRoot,
      noStructuredResultMessage: opts.noStructuredResultMessage,
    });

    if (run.kind === "error") {
      printViewCommandError({
        commandLabel: opts.commandLabel,
        json: opts.json,
        messages: run.messages,
      });
      return run.exitCode;
    }
    printViewCommandMessages(
      structuredViewBrokerMessages(opts.commandLabel, run.brokerDiagnostics),
    );

    const exitCode = opts.successExitCode?.(run.data) ?? 0;
    if (opts.json) {
      console.log(formatJson(run.data));
    } else {
      console.log(opts.renderHuman(run.data));
    }
    return exitCode;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    printViewCommandError({
      commandLabel: opts.commandLabel,
      json: opts.json,
      error: opts.failedError,
      messages: [`${opts.commandLabel}: failed: ${msg}`],
    });
    return 1;
  }
}
