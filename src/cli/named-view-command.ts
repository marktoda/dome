// cli/named-view-command: the shared CLI scaffold for dedicated top-level
// verbs that wrap a single known, first-party view-phase processor without
// imposing a `FIRST_PARTY_VIEWS` zod schema (`dome prep`, `dome agenda-with`,
// `dome stale-claims`, `dome orphan-pages`).
//
// This is the sibling of `structured-view-command.ts`'s `runCliStructuredView`
// (which backs `dome query` / `dome lint` / `dome export-context` with a
// validated `FirstPartyViewEntry`). Those three commands are recall surfaces
// third-party bundles could plausibly want to interoperate with, so they pay
// for the zod validation tier. The four processors this module backs are
// internal, static, single-purpose debug/planning views (Phase 13a's "command
// trigger, no dedicated schema" shape) — this scaffold reuses the exact same
// `runSharedViewCommand` boundary `dome run` dispatches through (no parallel
// mechanism), adds the human/`--json` branch every dedicated verb has, and
// renders the processor's own single emitted ViewEffect directly.

import { formatJson } from "../surface/format";
import {
  runSharedViewCommand,
  structuredViewBrokerMessages,
} from "../surface/view";
import {
  printViewCommandError,
  printViewCommandMessages,
} from "./commands/view-shared";

export type NamedViewCommandOptions = {
  /** Operator-facing command label, e.g. "dome prep". */
  readonly commandLabel: string;
  /** The view-phase processor's command trigger name, e.g. "prep". */
  readonly commandName: string;
  /** Structured args handed to the processor (already built by the caller). */
  readonly commandArgs?: unknown;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  /** Whether `--json` was requested. */
  readonly json: boolean;
  /** The `error` tag used in the `<name>-failed` JSON envelope. */
  readonly failedError: string;
  /** Renders the human (non-JSON) output from the structured payload. */
  readonly renderHuman: (data: unknown) => string;
};

/**
 * Runs a named view-phase command and prints its result. Returns the exit
 * code. Mirrors `runCliStructuredView`'s error-handling shape but works off
 * the processor's raw `ViewEffect` — this module's four callers each expect
 * exactly one `structured` ViewEffect, so a mismatched shape (wrong count, or
 * a `markdown` / `stream` content kind) renders as `<name>-failed` rather
 * than being silently coerced.
 */
export async function runNamedViewCommand(
  opts: NamedViewCommandOptions,
): Promise<number> {
  let run;
  try {
    run = await runSharedViewCommand({
      commandLabel: opts.commandLabel,
      commandName: opts.commandName,
      commandArgs: opts.commandArgs,
      vault: opts.vault,
      bundlesRoot: opts.bundlesRoot,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    printViewCommandError({
      commandLabel: opts.commandLabel,
      json: opts.json,
      messages: [`${opts.commandLabel}: failed: ${msg}`],
    });
    return 1;
  }

  if (run.kind === "usage-error") {
    printViewCommandError({
      commandLabel: opts.commandLabel,
      json: opts.json,
      messages: [run.message],
    });
    return 64;
  }
  if (run.kind === "runtime-error") {
    printViewCommandError({
      commandLabel: opts.commandLabel,
      json: opts.json,
      messages: [run.message],
    });
    return 1;
  }
  if (run.kind === "not-found") {
    printViewCommandError({
      commandLabel: opts.commandLabel,
      json: opts.json,
      messages: [
        `${opts.commandLabel}: no view-phase processor declares command trigger '${opts.commandName}'.`,
      ],
    });
    return 64;
  }
  if (run.kind === "failed") {
    const messages = [
      `${opts.commandLabel}: processor '${run.processorId}' finished with ${run.executionStatus}.`,
    ];
    if (run.executionError !== null) {
      messages.push(
        `${opts.commandLabel}: ${run.executionError.code}: ${run.executionError.message}`,
      );
    }
    for (const d of run.diagnostics) {
      messages.push(
        `${opts.commandLabel}: diagnostic [${d.severity}] ${d.code}: ${d.message}`,
      );
    }
    printViewCommandError({
      commandLabel: opts.commandLabel,
      json: opts.json,
      error: opts.failedError,
      messages,
    });
    return 1;
  }

  printViewCommandMessages(
    structuredViewBrokerMessages(opts.commandLabel, run.brokerDiagnostics),
  );

  const view = run.views.length === 1 ? run.views[0] : undefined;
  if (view === undefined || view.content.kind !== "structured") {
    printViewCommandError({
      commandLabel: opts.commandLabel,
      json: opts.json,
      error: opts.failedError,
      messages: [
        `${opts.commandLabel}: view processor returned no structured result.`,
      ],
    });
    return 1;
  }

  if (opts.json) {
    console.log(formatJson(view.content.data));
  } else {
    console.log(opts.renderHuman(view.content.data));
  }
  return 0;
}
