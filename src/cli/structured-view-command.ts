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
  catalogViewProblemExitCode,
  catalogViewProblemMessage,
  dispatchView,
  vaultOpenFailureMessage,
  type CatalogViewProblem,
  type ViewRenderer,
} from "../surface/adapter";
import { resolveVaultPath } from "../surface/resolve-vault";
import { structuredViewBrokerMessages } from "../surface/view";
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

/**
 * The CLI stderr lines for a catalog-view problem. `no-structured-result`
 * keeps the per-caller override wording; `processor-failed` expands the
 * execution error + each diagnostic into its own line (the multi-line output
 * the structured CLI verbs have always emitted); everything else is the single
 * shared operator line. Exported for byte-identity unit coverage.
 */
export function cliProblemMessages<TPayload>(
  commandLabel: string,
  entry: FirstPartyViewEntry<TPayload>,
  problem: CatalogViewProblem,
  noStructuredResultMessage: string,
): ReadonlyArray<string> {
  if (problem.kind === "no-structured-result") {
    return [noStructuredResultMessage];
  }
  const messages = [catalogViewProblemMessage(commandLabel, entry, problem)];
  if (problem.kind === "processor-failed") {
    if (problem.executionError !== null) {
      messages.push(
        `${commandLabel}: ${problem.executionError.code}: ${problem.executionError.message}`,
      );
    }
    for (const d of problem.diagnostics) {
      messages.push(
        `${commandLabel}: diagnostic [${d.severity}] ${d.code}: ${d.message}`,
      );
    }
  }
  return messages;
}

/** The CLI error-rendering seam: prints to its channel, returns the exit code. */
function cliViewRenderer<TPayload>(opts: {
  readonly commandLabel: string;
  readonly entry: FirstPartyViewEntry<TPayload>;
  readonly json: boolean;
  readonly noStructuredResultMessage: string;
}): ViewRenderer<number> {
  return {
    openFailed: (error) => {
      printViewCommandError({
        commandLabel: opts.commandLabel,
        json: opts.json,
        messages: [vaultOpenFailureMessage(opts.commandLabel, error)],
      });
      return error.kind === "not-a-vault" ? 64 : 1;
    },
    problem: (problem) => {
      printViewCommandError({
        commandLabel: opts.commandLabel,
        json: opts.json,
        messages: cliProblemMessages(
          opts.commandLabel,
          opts.entry,
          problem,
          opts.noStructuredResultMessage,
        ),
      });
      return catalogViewProblemExitCode(problem);
    },
  };
}

export async function runCliStructuredView<TPayload>(
  opts: CliStructuredViewOptions<TPayload>,
): Promise<number> {
  try {
    let run;
    try {
      run = await dispatchView(
        {
          path: resolveVaultPath(opts.vault),
          bundlesRoot: opts.bundlesRoot,
        },
        opts.entry,
        opts.commandArgs,
        cliViewRenderer({
          commandLabel: opts.commandLabel,
          entry: opts.entry,
          json: opts.json,
          noStructuredResultMessage: opts.noStructuredResultMessage,
        }),
      );
    } catch (e) {
      // Preserve the prior two-tier catch: an unexpected throw *during view
      // execution* renders as the generic `view-command-failed` envelope (no
      // `error` tag), distinct from the caller's `<name>-failed` tag reserved
      // for the outer rendering catch below.
      const msg = e instanceof Error ? e.message : String(e);
      printViewCommandError({
        commandLabel: opts.commandLabel,
        json: opts.json,
        messages: [`${opts.commandLabel}: failed: ${msg}`],
      });
      return 1;
    }

    if (run.kind === "rendered") {
      // The renderer already printed; the envelope is the exit code.
      return run.envelope;
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
