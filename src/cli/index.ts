#!/usr/bin/env bun
//
// Dome CLI entry.
//
// Commander owns command parsing, help, option validation, and usage errors.
// Command modules expose typed handler inputs so tests can call the handlers
// directly without constructing Commander objects or spawning subprocesses.

import { Command, CommanderError, Option } from "commander";

import { runCheck } from "./commands/check";
import { runAgenda } from "./commands/agenda";
import { runAnswer } from "./commands/answer";
import { runExportContext } from "./commands/export-context";
import { runInit } from "./commands/init";
import { runDoctor } from "./commands/doctor";
import { runInspect } from "./commands/inspect";
import { runLint, type LintFailOn } from "./commands/lint";
import { runPrep } from "./commands/prep";
import { runQuery } from "./commands/query";
import { runRebuild } from "./commands/rebuild";
import { runResolve } from "./commands/resolve";
import { runRun } from "./commands/run";
import { runServe } from "./commands/serve";
import { runStatus } from "./commands/status";
import { runSync } from "./commands/sync";
import { runToday } from "./commands/today";
import {
  parseNonNegativeIntegerOption,
  parsePositiveIntegerOption,
} from "./parse-options";

const EX_USAGE = 64;

// ----- runCli ---------------------------------------------------------------

/**
 * Run the CLI against a raw argv slice. Returns the exit code. Expected CLI
 * errors are reported by Commander and mapped to Dome's POSIX-ish exit code
 * policy: 0 for help, 64 for usage errors.
 */
export async function runCli(argv: ReadonlyArray<string>): Promise<number> {
  let actionExitCode = 0;
  const program = buildProgram((code) => {
    actionExitCode = code;
  });

  if (argv.length === 0) {
    console.error(program.helpInformation().trimEnd());
    return EX_USAGE;
  }

  try {
    await program.parseAsync([...argv], { from: "user" });
    return actionExitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? 0 : EX_USAGE;
    }
    throw error;
  }
}

// ----- internals ------------------------------------------------------------

function buildProgram(setExitCode: (code: number) => void): Command {
  const program = new Command();
  program
    .name("dome")
    .description("Dome vault compiler and operational CLI.")
    .showHelpAfterError()
    .showSuggestionAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (text) => writeConsole(console.log, text),
      writeErr: (text) => writeConsole(console.error, text),
      outputError: (text, write) => write(text),
    });

  program
    .command("init")
    .description("Initialize a vault.")
    .argument("[path]", "Vault path (defaults to current directory).")
    .option(
      "--refresh-config",
      "Fill missing first-party default grant keys in an existing config.",
    )
    .option(
      "--refresh-instructions",
      "Repair old AGENTS.md/CLAUDE.md orientation shims.",
    )
    .action(async (path: string | undefined, options: InitCliOptions) => {
      setExitCode(
        await runInit({
          path,
          refreshConfig: options.refreshConfig,
          refreshInstructions: options.refreshInstructions,
        }),
      );
    });

  program
    .command("check")
    .description("Explain compiler attention.")
    .option("--engine", "Show engine health findings.")
    .option("--content", "Show adopted-state diagnostics.")
    .option("--decisions", "Show open Dome questions.")
    .option(
      "--attention",
      "For content diagnostics, show only warning/error/block rows.",
    )
    .option("--limit <n>", "Maximum rows per section.", parsePositiveIntegerOption)
    .option(
      "--orphan-threshold-ms <n>",
      "Age before a running row is reported as orphaned.",
      parseNonNegativeIntegerOption,
    )
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (options: CheckCliOptions) => {
      setExitCode(
        await runCheck({
          engine: options.engine,
          content: options.content,
          decisions: options.decisions,
          attention: options.attention,
          limit: options.limit,
          orphanThresholdMs: options.orphanThresholdMs,
          json: options.json,
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
        }),
      );
    });

  program
    .command("inspect")
    .description("Read operational substrate rows.")
    .argument(
      "<subject>",
      "runs, diagnostics, questions, outbox, or quarantine.",
    )
    .option("--limit <n>", "Maximum rows to show.", parsePositiveIntegerOption)
    .option("--summary", "Group diagnostics by severity and code.")
    .option("--severity <level>", "Filter diagnostics by severity.")
    .option("--code <code>", "Filter diagnostics by code.")
    .option("--processor <id>", "Filter diagnostics by processor id.")
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (subject: string, options: InspectCliOptions) => {
      setExitCode(
        await runInspect({
          subject,
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
          limit: options.limit,
          json: options.json,
          summary: options.summary,
          severity: options.severity,
          code: options.code,
          processor: options.processor,
        }),
      );
    });

  program
    .command("doctor")
    .description("Run engine-substrate health checks.")
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .option(
      "--orphan-threshold-ms <n>",
      "Age before a running row is reported as orphaned.",
      parseNonNegativeIntegerOption,
    )
    .option("--repair", "Apply safe mitigations when implemented.")
    .action(async (options: DoctorCliOptions) => {
      setExitCode(
        await runDoctor({
          repair: options.repair,
          json: options.json,
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
          orphanThresholdMs: options.orphanThresholdMs,
        }),
      );
    });

  program
    .command("agenda")
    .description("Render a source-backed agenda for a person or topic.")
    .argument("<topic...>", "Person or topic to prepare for.")
    .option("--date <YYYY-MM-DD>", "Date context (defaults to local today).")
    .option(
      "--limit <n>",
      "Maximum items per agenda section.",
      parsePositiveIntegerOption,
    )
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (topic: string[], options: AgendaCliOptions) => {
      setExitCode(
        await runAgenda({
          topic: topic.join(" "),
          date: options.date,
          limit: options.limit,
          json: options.json,
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
        }),
      );
    });

  program
    .command("resolve")
    .description("Resolve an engine-raised decision.")
    .argument("<question-id>", "Question row id from `dome check`.")
    .argument("[value...]", "Decision value. Omit to print the question.")
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (
      id: string,
      value: string[] | undefined,
      options: ResolveCliOptions,
    ) => {
      setExitCode(
        await runResolve({
          id,
          value: value?.join(" "),
          json: options.json,
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
        }),
      );
    });

  program
    .command("answer")
    .description("Resolve an engine-raised question.")
    .argument("<question-id>", "Question row id from `dome inspect questions`.")
    .argument("[value...]", "Answer value. Omit to print the question.")
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (
      id: string,
      value: string[] | undefined,
      options: AnswerCliOptions,
    ) => {
      setExitCode(
        await runAnswer({
          id,
          value: value?.join(" "),
          json: options.json,
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
        }),
      );
    });

  program
    .command("run")
    .description("Invoke a view-phase command-triggered processor.")
    .argument("<name>", "View command name.")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (name: string, options: RunCliOptions, command: Command) => {
      setExitCode(
        await runRun({
          name,
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
          json: options.json,
          commandFlags: parseProcessorFlags(processorArgs(command.args)),
        }),
      );
    });

  program
    .command("lint")
    .description("Render the adopted-state lint report.")
    .option(
      "--fail-on <severity>",
      "Exit nonzero at severity: info, warning, error, block, or never.",
      parseLintFailOnOption,
    )
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (options: LintCliOptions) => {
      setExitCode(
        await runLint({
          failOn: options.failOn,
          json: options.json,
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
        }),
      );
    });

  program
    .command("query")
    .description("Search adopted vault state.")
    .argument("<text...>", "Query text.")
    .option("--category <category>", "Filter by document category.")
    .option("--type <type>", "Filter by page type.")
    .option("--limit <n>", "Maximum matches to show.", parsePositiveIntegerOption)
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (text: string[], options: QueryCliOptions) => {
      setExitCode(
        await runQuery({
          text: text.join(" "),
          category: options.category,
          type: options.type,
          limit: options.limit,
          json: options.json,
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
        }),
      );
    });

  program
    .command("export-context")
    .description("Export a source-backed context packet for a topic.")
    .argument("<topic...>", "Topic to export.")
    .option("--limit <n>", "Maximum matches to include.", parsePositiveIntegerOption)
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (topic: string[], options: ExportContextCliOptions) => {
      setExitCode(
        await runExportContext({
          topic: topic.join(" "),
          limit: options.limit,
          json: options.json,
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
        }),
      );
    });

  program
    .command("today")
    .description("Render today's source-backed task surface.")
    .option("--date <YYYY-MM-DD>", "Date to render (defaults to local today).")
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (options: TodayCliOptions) => {
      setExitCode(
        await runToday({
          date: options.date,
          json: options.json,
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
        }),
      );
    });

  program
    .command("prep")
    .description("Render source-backed planning context for a day.")
    .option("--date <YYYY-MM-DD>", "Date to prep (defaults to local today).")
    .option(
      "--limit <n>",
      "Maximum items per prep section.",
      parsePositiveIntegerOption,
    )
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (options: PrepCliOptions) => {
      setExitCode(
        await runPrep({
          date: options.date,
          limit: options.limit,
          json: options.json,
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
        }),
      );
    });

  program
    .command("rebuild")
    .description("Rebuild projection.db from the adopted commit.")
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (options: RebuildCliOptions) => {
      setExitCode(
        await runRebuild({
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
          json: options.json,
        }),
      );
    });

  program
    .command("serve")
    .description("Run the local compiler host.")
    .option(
      "--poll-interval-ms <n>",
      "Polling interval in milliseconds.",
      parsePositiveIntegerOption,
    )
    .option("-v, --verbose", "Print adoption progress events.")
    .option(
      "--filter-processor <glob>",
      "In verbose mode, only print matching processor ids.",
    )
    .addOption(
      new Option("-q, --quiet", "Suppress non-error text output.").conflicts(
        "verbose",
      ),
    )
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (options: ServeCliOptions) => {
      setExitCode(
        await runServe({
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
          pollIntervalMs: options.pollIntervalMs,
          verbose: options.verbose,
          quiet: options.quiet,
          ...(options.filterProcessor !== undefined
            ? { filterProcessor: options.filterProcessor }
            : {}),
        }),
      );
    });

  program
    .command("status")
    .description("Vault health + content dashboard.")
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (options: StatusCliOptions) => {
      setExitCode(
        await runStatus({
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
          json: options.json,
        }),
      );
    });

  program
    .command("sync")
    .description("One-shot catch-up: adopt working-tree HEAD.")
    .option("--json", "Emit JSON.")
    .option("-v, --verbose", "Print adoption progress events.")
    .option(
      "--filter-processor <glob>",
      "In verbose mode, only print matching processor ids.",
    )
    .addOption(
      new Option("-q, --quiet", "Suppress non-error text output.").conflicts(
        "verbose",
      ),
    )
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (options: SyncCliOptions) => {
      setExitCode(
        await runSync({
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
          json: options.json,
          verbose: options.verbose,
          quiet: options.quiet,
          ...(options.filterProcessor !== undefined
            ? { filterProcessor: options.filterProcessor }
            : {}),
        }),
      );
    });

  return program;
}

type InitCliOptions = {
  readonly refreshConfig?: boolean;
  readonly refreshInstructions?: boolean;
};

type CheckCliOptions = {
  readonly engine?: boolean;
  readonly content?: boolean;
  readonly decisions?: boolean;
  readonly attention?: boolean;
  readonly limit?: number;
  readonly orphanThresholdMs?: number;
  readonly json?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type InspectCliOptions = {
  readonly limit?: number;
  readonly summary?: boolean;
  readonly severity?: string;
  readonly code?: string;
  readonly processor?: string;
  readonly json?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type DoctorCliOptions = {
  readonly repair?: boolean;
  readonly json?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
  readonly orphanThresholdMs?: number;
};

type AgendaCliOptions = {
  readonly date?: string;
  readonly limit?: number;
  readonly json?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type AnswerCliOptions = {
  readonly json?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type ResolveCliOptions = AnswerCliOptions;

type RunCliOptions = {
  readonly json?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type LintCliOptions = {
  readonly failOn?: LintFailOn;
  readonly json?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type QueryCliOptions = {
  readonly category?: string;
  readonly type?: string;
  readonly limit?: number;
  readonly json?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type ExportContextCliOptions = {
  readonly limit?: number;
  readonly json?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type TodayCliOptions = {
  readonly date?: string;
  readonly json?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type PrepCliOptions = {
  readonly date?: string;
  readonly limit?: number;
  readonly json?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type RebuildCliOptions = {
  readonly json?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type ServeCliOptions = {
  readonly pollIntervalMs?: number;
  readonly verbose?: boolean;
  readonly quiet?: boolean;
  readonly filterProcessor?: string;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type StatusCliOptions = {
  readonly json?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type SyncCliOptions = {
  readonly json?: boolean;
  readonly verbose?: boolean;
  readonly quiet?: boolean;
  readonly filterProcessor?: string;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

function processorArgs(commandArgs: readonly string[]): ReadonlyArray<string> {
  // Commander includes the command argument itself in `command.args`; pass only
  // the opaque extension arguments through to the view processor.
  return commandArgs.slice(1);
}

function parseProcessorFlags(
  argv: ReadonlyArray<string>,
): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined || !token.startsWith("--") || token.length <= 2) {
      continue;
    }

    const body = token.slice(2);
    const eqIdx = body.indexOf("=");
    if (eqIdx >= 0) {
      const key = body.slice(0, eqIdx);
      if (key.length > 0) flags[key] = body.slice(eqIdx + 1);
      continue;
    }

    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next;
      i++;
    } else {
      flags[body] = true;
    }
  }
  return flags;
}

function parseLintFailOnOption(value: string): LintFailOn {
  if (
    value === "info" ||
    value === "warning" ||
    value === "error" ||
    value === "block" ||
    value === "never"
  ) {
    return value;
  }
  throw new CommanderError(
    EX_USAGE,
    "commander.invalidArgument",
    `error: invalid lint severity '${value}'`,
  );
}

function writeConsole(write: (text: string) => void, text: string): void {
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (trimmed.length > 0) write(trimmed);
}

// ----- Direct-invocation entry ----------------------------------------------

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
