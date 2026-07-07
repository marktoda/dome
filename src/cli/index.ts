#!/usr/bin/env bun
//
// Dome CLI entry.
//
// Commander owns command parsing, help, option validation, and usage errors.
// Command modules expose typed handler inputs so tests can call the handlers
// directly without constructing Commander objects or spawning subprocesses.

import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from "commander";

import { runCapture } from "./commands/capture";
import { runCheck } from "./commands/check";
import { runAnswer } from "./commands/answer";
import { runAgendaWith } from "./commands/agenda-with";
import { runApply } from "./commands/apply";
import { runExplain } from "./commands/explain";
import { runExportContext } from "./commands/export-context";
import { runInit } from "./commands/init";
import { runInstall, runRestart, runUninstall } from "./commands/install";
import { runDoctor } from "./commands/doctor";
import { runInspect } from "./commands/inspect";
import { runLint, type LintFailOn } from "./commands/lint";
import { runLog } from "./commands/log";
import { runOrphanPages } from "./commands/orphan-pages";
import { runPrep } from "./commands/prep";
import { runProposals } from "./commands/proposals";
import { runQuery } from "./commands/query";
import { runReanchor } from "./commands/reanchor";
import { runReject } from "./commands/reject";
import { runRepair } from "./commands/repair";
import { runRecipe } from "./commands/recipe";
import { runRebuild } from "./commands/rebuild";
import { runResolve } from "./commands/resolve";
import { runRun } from "./commands/run";
import { runSettle } from "./commands/settle";
import { runServe } from "./commands/serve";
import { runStaleClaims } from "./commands/stale-claims";
import { runStatus } from "./commands/status";
import { runSync } from "./commands/sync";
import { runToday } from "./commands/today";
import {
  parseNonNegativeIntegerOption,
  parsePositiveIntegerOption,
} from "./parse-options";
import { EX_USAGE } from "./exit-codes";

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
  if (argv[0] === "submit" || argv[0] === "reconcile") {
    console.error(`dome ${argv[0]}: retired. Use \`dome sync\` instead.`);
    return EX_USAGE;
  }

  try {
    await program.parseAsync([...argv], { from: "user" });
    return actionExitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? 0 : EX_USAGE;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (argv.includes("--json")) {
      console.log(
        JSON.stringify(
          {
            status: "error",
            error: "internal-error",
            message,
          },
          null,
          2,
        ),
      );
    } else {
      console.error(`dome: failed: ${message}`);
    }
    return 1;
  }
}

// ----- internals ------------------------------------------------------------

// `dome --help` heading per visible command, so the surface reads as a few
// small verb sets instead of one flat wall. Registration order is unchanged;
// headings render in first-registered-command order (Getting started → Daily
// loop → Decisions → Recall & views → Service → Adapters). NB: heading text is
// fence-tested against hidden command names as substrings
// (tests/cli/index.test.ts).
const GROUP_START = "Getting started:";
const GROUP_LOOP = "Daily loop:";
const GROUP_DECISIONS = "Decisions:";
const GROUP_RECALL = "Recall & views:";
const GROUP_SERVICE = "Service:";
const GROUP_ADAPTERS = "Adapters:";

function buildProgram(setExitCode: (code: number) => void): Command {
  const program = new Command();
  program
    .name("dome")
    .description("Dome vault compiler and operational CLI.")
    .showHelpAfterError()
    .showSuggestionAfterError()
    // No implicit `help [command]` subcommand: it cannot join a help group,
    // so it would render as a stray "Commands:" heading amid the grouped
    // surface. `-h` / `--help` remain on every command.
    .helpCommand(false)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => writeConsole(console.log, text),
      writeErr: (text) => writeConsole(console.error, text),
      outputError: (text, write) => write(text),
    });

  program
    .command("init")
    .helpGroup(GROUP_START)
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
    .option(
      "--with-model-provider <provider>",
      "Write a local command model provider template (currently: anthropic).",
      parseInitModelProviderOption,
    )
    .option(
      "--with-source <kind>",
      "Scaffold a source fetch adapter + disabled subscription stanza " +
        "(repeatable; kinds: calendar, slack).",
      parseInitSourceOption,
      [] as ReadonlyArray<"calendar" | "slack">,
    )
    .option("--json", "Emit JSON.")
    .action(async (path: string | undefined, options: InitCliOptions) => {
      setExitCode(
        await runInit({
          path,
          refreshConfig: options.refreshConfig,
          refreshInstructions: options.refreshInstructions,
          modelProvider: options.withModelProvider,
          withSource: options.withSource,
          json: options.json,
        }),
      );
    });

  program
    .command("capture")
    .helpGroup(GROUP_LOOP)
    .description("Capture text into inbox/raw/ and commit it on the current branch.")
    .argument("[text]", "Capture text (omit to read stdin or use --file).")
    .option("--file <path>", "Read the capture body from a file.")
    .option("--title <title>", "Explicit capture title (drives the slug and heading).")
    .option(
      "--capture-id <id>",
      "Retry-idempotency key: drives the filename slug; an existing capture for the same id answers duplicate.",
    )
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    // Accepted for surface uniformity (callers append it to every command);
    // capture never loads bundles or opens the runtime, so it is unused.
    .option("--bundles-root <path>", "Ignored; capture does not open the runtime.")
    .action(async (text: string | undefined, options: CaptureCliOptions) => {
      setExitCode(
        await runCapture({
          text,
          file: options.file,
          title: options.title,
          captureId: options.captureId,
          vault: options.vault,
          json: options.json,
        }),
      );
    });

  program
    .command("check")
    .helpGroup(GROUP_LOOP)
    .description("Explain compiler attention.")
    .option("--engine", "Show engine health findings.")
    .option("--content", "Show full adopted-state diagnostics.")
    .option("--decisions", "Show open Dome questions.")
    .option("--loops", "Show maintenance-loop detail rows in text output.")
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
    .option("-v, --verbose", "Show the full breakdown.")
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (options: CheckCliOptions) => {
      setExitCode(
        await runCheck({
          engine: options.engine,
          content: options.content,
          decisions: options.decisions,
          loops: options.loops,
          attention: options.attention,
          limit: options.limit,
          orphanThresholdMs: options.orphanThresholdMs,
          verbose: options.verbose,
          json: options.json,
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
        }),
      );
    });

  program
    .command("inspect", { hidden: true })
    .description("Read operational substrate rows.")
    .argument(
      "<subject>",
      "bundles, processors, runs, patches, facts, diagnostics, questions, outbox, quarantine, or cost.",
    )
    .option("--limit <n>", "Maximum rows to show.", parsePositiveIntegerOption)
    .option(
      "--days <n>",
      "Cost window in days (cost subject only; default 7).",
      parsePositiveIntegerOption,
    )
    .option("--summary", "Group diagnostics by severity and code.")
    .option("--severity <level>", "Filter diagnostics by severity.")
    .option("--code <code>", "Filter diagnostics by code.")
    .option("--processor <id>", "Filter diagnostics or patches by processor id.")
    .option("--predicate <predicate>", "Filter facts by predicate.")
    .option("--subject-kind <kind>", "Filter facts by subject kind.")
    .option("--subject-id <id>", "Filter facts by subject id.")
    .option("--model", "Show only model-capable bundles or processors.")
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
          predicate: options.predicate,
          subjectKind: options.subjectKind,
          subjectId: options.subjectId,
          model: options.model,
          days: options.days,
        }),
      );
    });

  program
    .command("doctor", { hidden: true })
    .description("Run engine-substrate health checks.")
    .option("-v, --verbose", "Show the full breakdown.")
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .option(
      "--orphan-threshold-ms <n>",
      "Age before a running row is reported as orphaned.",
      parseNonNegativeIntegerOption,
    )
    .option("--repair", "Reserved in V1; recovery flows through dome resolve.")
    .action(async (options: DoctorCliOptions) => {
      setExitCode(
        await runDoctor({
          repair: options.repair,
          verbose: options.verbose,
          json: options.json,
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
          orphanThresholdMs: options.orphanThresholdMs,
        }),
      );
    });

  program
    .command("repair", { hidden: true })
    .description("Run an explicit guarded vault/content-state repair.")
    .argument("[subject]", "Repair subject: task-anchors or run-ledger.")
    .option("--dry-run", "Show planned changes without writing files.")
    .option("--apply", "Apply the planned repair.")
    .option(
      "--older-than-days <n>",
      "For run-ledger: prune eligible rows older than N days.",
      parsePositiveIntegerOption,
    )
    .option("--vacuum", "For run-ledger: VACUUM runs.db after --apply.")
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .action(async (subject: string | undefined, options: RepairCliOptions) => {
      setExitCode(
        await runRepair({
          subject,
          dryRun: options.dryRun,
          apply: options.apply,
          olderThanDays: options.olderThanDays,
          vacuum: options.vacuum,
          json: options.json,
          vault: options.vault,
        }),
      );
    });

  program
    .command("resolve")
    .helpGroup(GROUP_DECISIONS)
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
    .command("settle")
    .helpGroup(GROUP_DECISIONS)
    .description("Settle a task line by its ^block-anchor: close, defer, or keep.")
    .argument("<block-id>", "The task's ^block-anchor id.")
    .argument("<disposition>", "close | defer | keep")
    .option("--until <date>", "YYYY-MM-DD due date; required when disposition is defer.")
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .action(async (
      blockId: string,
      disposition: string,
      options: SettleCliOptions,
    ) => {
      setExitCode(
        await runSettle({
          blockId,
          disposition,
          until: options.until,
          json: options.json,
          vault: options.vault,
        }),
      );
    });

  program
    .command("proposals")
    .helpGroup(GROUP_DECISIONS)
    .description("List pending garden propose-mode patches awaiting review.")
    .option("--all", "Include applied and rejected proposals, not just pending.")
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .action(async (options: ProposalsCliOptions) => {
      setExitCode(
        await runProposals({
          all: options.all,
          json: options.json,
          vault: options.vault,
        }),
      );
    });

  program
    .command("apply")
    .helpGroup(GROUP_DECISIONS)
    .description("Apply a pending proposal: write its changes and land one commit.")
    .argument("<id>", "Proposal row id from `dome proposals`.")
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .action(async (id: string, options: ApplyCliOptions) => {
      setExitCode(
        await runApply({
          id,
          json: options.json,
          vault: options.vault,
        }),
      );
    });

  program
    .command("reject")
    .helpGroup(GROUP_DECISIONS)
    .description("Reject a pending proposal. Records the decision; writes no files.")
    .argument("<id>", "Proposal row id from `dome proposals`.")
    .argument("[note...]", "Optional note explaining the rejection.")
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .action(async (
      id: string,
      note: string[] | undefined,
      options: RejectCliOptions,
    ) => {
      setExitCode(
        await runReject({
          id,
          note: note !== undefined && note.length > 0 ? note.join(" ") : undefined,
          json: options.json,
          vault: options.vault,
        }),
      );
    });

  program
    .command("answer", { hidden: true })
    .description(
      "Resolve an engine-raised question. (deprecated alias — use dome resolve)",
    )
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
    .command("run", { hidden: true })
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
          commandArgs: parseProcessorArgs(processorArgs(command.args)),
        }),
      );
    });

  program
    .command("lint", { hidden: true })
    .description("Render the adopted-state lint report.")
    .option(
      "--fail-on <severity>",
      "Exit nonzero at severity: info, warning, error, block, or never.",
      parseLintFailOnOption,
    )
    .option("--limit <n>", "Maximum issues to show.", parsePositiveIntegerOption)
    .option("-v, --verbose", "Show the full breakdown.")
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (options: LintCliOptions) => {
      setExitCode(
        await runLint({
          failOn: options.failOn,
          limit: options.limit,
          verbose: options.verbose,
          json: options.json,
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
        }),
      );
    });

  program
    .command("query")
    .helpGroup(GROUP_RECALL)
    .description("Search adopted vault state.")
    .argument("<text...>", "Query text.")
    .option("--category <category>", "Filter by document category.")
    .option("--type <type>", "Filter by page type.")
    .option("--limit <n>", "Maximum matches to show.", parsePositiveIntegerOption)
    .option(
      "--miss [note]",
      "Record this query as a retrieval miss after printing results (meta/retrieval-misses.md); optional note.",
    )
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
          miss: options.miss,
          json: options.json,
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
        }),
      );
    });

  program
    .command("today")
    .helpGroup(GROUP_RECALL)
    .description(
      "Render today's action surface (open tasks, follow-ups, questions).",
    )
    .option("--date <yyyy-mm-dd>", "Render a specific day (default: today).")
    .option("--limit <n>", "Maximum rows per section.", parsePositiveIntegerOption)
    .option("--watch", "Re-render on an interval until ctrl-c (the cockpit).")
    .option(
      "--interval <seconds>",
      "Watch refresh interval (default 5).",
      parsePositiveIntegerOption,
    )
    .option("-v, --verbose", "Show full brief prose and source paths.")
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (options: TodayCliOptions) => {
      setExitCode(
        await runToday({
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
          date: options.date,
          limit: options.limit,
          json: options.json,
          watch: options.watch,
          interval: options.interval,
          verbose: options.verbose,
        }),
      );
    });

  program
    .command("log")
    .helpGroup(GROUP_RECALL)
    .description("Show vault activity: git history joined with the engine ledger.")
    .option("--since <date>", "Only show commits newer than this date.")
    .option("--processor <id>", "Only show engine entries from this processor.")
    .option("--grep <text>", "Filter entries by subject/body substring.")
    .option("--limit <n>", "Maximum entries to show.", parsePositiveIntegerOption)
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .action(async (options: LogCliOptions) => {
      setExitCode(
        await runLog({
          vault: options.vault,
          since: options.since,
          processor: options.processor,
          grep: options.grep,
          limit: options.limit,
          json: options.json,
        }),
      );
    });

  program
    .command("explain")
    .helpGroup(GROUP_RECALL)
    .description(
      // NB: help output is fence-tested against hidden command names as
      // substrings (tests/cli/index.test.ts), so this line avoids the word
      // "run(s)"; the full chain is claim → facts → runs → engine commits.
      "Explain a page or claim's provenance: claim → facts → ledger evidence → engine commits.",
    )
    .argument(
      "<target>",
      '"<path>" or "<path>#^<anchor>" — a vault page, optionally one claim anchor.',
    )
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (target: string, options: ExplainCliOptions) => {
      setExitCode(
        await runExplain({
          target,
          json: options.json,
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
        }),
      );
    });

  program
    .command("export-context")
    .helpGroup(GROUP_RECALL)
    .description("Export a source-backed context packet for a topic.")
    .argument("<topic...>", "Topic to export.")
    .option("--limit <n>", "Maximum matches to include.", parsePositiveIntegerOption)
    .option(
      "--miss [note]",
      "Record this topic as a retrieval miss after printing the packet (meta/retrieval-misses.md); optional note.",
    )
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (topic: string[], options: ExportContextCliOptions) => {
      setExitCode(
        await runExportContext({
          topic: topic.join(" "),
          limit: options.limit,
          miss: options.miss,
          json: options.json,
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
        }),
      );
    });

  program
    .command("prep")
    .helpGroup(GROUP_RECALL)
    .description("Render a source-backed planning packet for a day.")
    .option("--date <yyyy-mm-dd>", "Render a specific day (default: today).")
    .option("--limit <n>", "Maximum rows per section.", parsePositiveIntegerOption)
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
    .command("agenda-with")
    .helpGroup(GROUP_RECALL)
    .description("Render source-backed open tasks, follow-ups, and context for a person or topic.")
    .argument("<person-or-topic...>", "Person or topic to filter by.")
    .option("--date <yyyy-mm-dd>", "Daily-note context date (default: today).")
    .option("--limit <n>", "Maximum rows per section.", parsePositiveIntegerOption)
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (topic: string[], options: AgendaWithCliOptions) => {
      setExitCode(
        await runAgendaWith({
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
    .command("stale-claims")
    .helpGroup(GROUP_RECALL)
    .description("List claims whose *(as of)* date is older than the staleness horizon.")
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (options: StaleClaimsCliOptions) => {
      setExitCode(
        await runStaleClaims({
          json: options.json,
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
        }),
      );
    });

  program
    .command("orphan-pages")
    .helpGroup(GROUP_RECALL)
    .description("List markdown pages with no incoming wikilinks.")
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (options: OrphanPagesCliOptions) => {
      setExitCode(
        await runOrphanPages({
          json: options.json,
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
        }),
      );
    });

  program
    .command("reanchor", { hidden: true })
    .description(
      "Re-anchor the adopted ref after a history rewrite (backs up the old SHA first).",
    )
    .option(
      "--to <sha>",
      "Commit OID to anchor to (defaults to the current HEAD).",
    )
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (options: ReanchorCliOptions) => {
      setExitCode(
        await runReanchor({
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
          to: options.to,
          json: options.json,
        }),
      );
    });

  program
    .command("rebuild", { hidden: true })
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
    .helpGroup(GROUP_SERVICE)
    .description("Run the local compiler host.")
    .option(
      "--poll-interval-ms <n>",
      "Polling interval in milliseconds.",
      parsePositiveIntegerOption,
    )
    .option("-v, --verbose", "Print adoption progress events.")
    .option("--daemon", "Start the compiler host in the background.")
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
          daemon: options.daemon,
          ...(options.filterProcessor !== undefined
            ? { filterProcessor: options.filterProcessor }
            : {}),
        }),
      );
    });

  program
    .command("install")
    .helpGroup(GROUP_SERVICE)
    .description("Install dome serve as a background service (launchd on macOS, systemd --user on Linux).")
    .option("--status", "Report installed/loaded service state without changes.")
    .option(
      "--env <KEY=VALUE>",
      "Add a service EnvironmentVariables entry (repeatable; rebuilt on each install).",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      "--env-file <path>",
      "Read KEY=VALUE service environment entries from a file.",
    )
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .action(async (options: InstallCliOptions) => {
      setExitCode(
        await runInstall({
          vault: options.vault,
          status: options.status,
          env: options.env,
          envFile: options.envFile,
          json: options.json,
        }),
      );
    });

  program
    .command("restart")
    .helpGroup(GROUP_SERVICE)
    .description("Restart the vault's launchd service from the installed plist.")
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .action(async (options: RestartCliOptions) => {
      setExitCode(
        await runRestart({
          vault: options.vault,
          json: options.json,
        }),
      );
    });

  program
    .command("uninstall")
    .helpGroup(GROUP_SERVICE)
    .description("Boot out and remove the vault's launchd service.")
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .action(async (options: UninstallCliOptions) => {
      setExitCode(
        await runUninstall({
          vault: options.vault,
          json: options.json,
        }),
      );
    });

  program
    .command("mcp")
    .helpGroup(GROUP_ADAPTERS)
    .description("Run the stdio MCP server over this vault (read/capture protocol adapter).")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (options: McpCliOptions) => {
      // Dynamic import keeps @modelcontextprotocol/sdk out of the CLI's
      // static import graph — the companion-entrypoint discipline pinned by
      // ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY (see src/cli/commands/mcp.ts).
      const { runMcp } = await import("./commands/mcp");
      setExitCode(
        await runMcp({
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
        }),
      );
    });

  program
    .command("http")
    .helpGroup(GROUP_ADAPTERS)
    .description("Run the Dome HTTP surface over this vault: read · capture · resolve · agent · transcribe · PWA (bearer-token auth; loopback by default).")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .option("--port <port>", "Port to listen on (default 3663).")
    .option("--host <host>", "Interface to bind (default 127.0.0.1).")
    .option("--token <token>", "Bearer token (or set DOME_HTTP_TOKEN).")
    .option("--model <model>", "Agent model id override (else the provider default).")
    .option("--static-dir <path>", "Serve a built PWA from this directory (or set DOME_PWA_DIR).")
    .option("--allow-write", "Grant the agent the `author` (write) capability (or set DOME_ALLOW_WRITE).")
    .option("--transcribe-cmd <cmd>", "Local shell command for server-side transcription, e.g. whisper (or set DOME_TRANSCRIBE_CMD; space-split into argv). Takes precedence over the cloud key.")
    .option("--transcribe-key <key>", "API key for cloud transcription (or set DOME_TRANSCRIBE_KEY, falling back to OPENAI_API_KEY).")
    .option("--transcribe-url <url>", "Base URL for cloud transcription (or set DOME_TRANSCRIBE_URL; default https://api.openai.com/v1).")
    .option("--transcribe-model <model>", "Cloud transcription model (or set DOME_TRANSCRIBE_MODEL; default whisper-1).")
    .option("--agent-log <path>", "Append one JSON line per /agent request to <path> (or set DOME_AGENT_LOG).")
    .action(async (options: HttpCliOptions) => {
      // Dynamic import keeps the listener entrypoint (and the AI SDK it pulls
      // for /agent) out of the CLI's static graph, matching the `dome mcp`
      // companion-entrypoint pattern. ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY.
      const { runHttp } = await import("./commands/http");
      setExitCode(
        await runHttp({
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
          port: options.port,
          host: options.host,
          token: options.token,
          model: options.model,
          staticDir: options.staticDir,
          allowWrite: options.allowWrite,
          transcribeCmd: options.transcribeCmd,
          transcribeKey: options.transcribeKey,
          transcribeUrl: options.transcribeUrl,
          transcribeModel: options.transcribeModel,
          agentLog: options.agentLog,
        }),
      );
    });


  program
    .command("recipe <kind>")
    .helpGroup(GROUP_START)
    .description(
      "Print a setup recipe (available: ios — voice capture via Shortcuts; capture-queue — the laptop-side iCloud queue drain; core-seed — owner interview for core.md).",
    )
    .option(
      "--url <base>",
      "Base URL of your dome http server (default http://<your-server>:3663).",
    )
    .action(async (kind: string, options: { readonly url?: string }) => {
      setExitCode(await runRecipe({ kind, url: options.url }));
    });

  program
    .command("status")
    .helpGroup(GROUP_LOOP)
    .description("Vault health + content dashboard.")
    .option("--loops", "Show maintenance-loop detail rows in text output.")
    .option(
      "--probe",
      "Run a fresh model-provider probe (up to 8s) instead of the cached result.",
    )
    .option("-v, --verbose", "Show the full breakdown.")
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (options: StatusCliOptions) => {
      setExitCode(
        await runStatus({
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
          loops: options.loops,
          probe: options.probe,
          verbose: options.verbose,
          json: options.json,
        }),
      );
    });

  program
    .command("sync")
    .helpGroup(GROUP_LOOP)
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
  readonly withModelProvider?: "anthropic";
  readonly withSource?: ReadonlyArray<"calendar" | "slack">;
  readonly json?: boolean;
};

type CaptureCliOptions = {
  readonly file?: string;
  readonly title?: string;
  readonly captureId?: string;
  readonly json?: boolean;
  readonly vault?: string;
};

type InstallCliOptions = {
  readonly status?: boolean;
  readonly env?: string[];
  readonly envFile?: string;
  readonly json?: boolean;
  readonly vault?: string;
};

type UninstallCliOptions = {
  readonly json?: boolean;
  readonly vault?: string;
};

type RestartCliOptions = {
  readonly json?: boolean;
  readonly vault?: string;
};

type McpCliOptions = {
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type HttpCliOptions = {
  readonly vault?: string;
  readonly bundlesRoot?: string;
  readonly port?: string;
  readonly host?: string;
  readonly token?: string;
  readonly model?: string;
  readonly staticDir?: string;
  readonly allowWrite?: boolean;
  readonly transcribeCmd?: string;
  readonly transcribeKey?: string;
  readonly transcribeUrl?: string;
  readonly transcribeModel?: string;
  readonly agentLog?: string;
};


type CheckCliOptions = {
  readonly engine?: boolean;
  readonly content?: boolean;
  readonly decisions?: boolean;
  readonly loops?: boolean;
  readonly attention?: boolean;
  readonly limit?: number;
  readonly orphanThresholdMs?: number;
  readonly verbose?: boolean;
  readonly json?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type InspectCliOptions = {
  readonly limit?: number;
  readonly days?: number;
  readonly summary?: boolean;
  readonly severity?: string;
  readonly code?: string;
  readonly processor?: string;
  readonly predicate?: string;
  readonly subjectKind?: string;
  readonly subjectId?: string;
  readonly model?: boolean;
  readonly json?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type DoctorCliOptions = {
  readonly repair?: boolean;
  readonly verbose?: boolean;
  readonly json?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
  readonly orphanThresholdMs?: number;
};

type RepairCliOptions = {
  readonly dryRun?: boolean;
  readonly apply?: boolean;
  readonly olderThanDays?: number;
  readonly vacuum?: boolean;
  readonly json?: boolean;
  readonly vault?: string;
};

type AnswerCliOptions = {
  readonly json?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type ResolveCliOptions = AnswerCliOptions;

type SettleCliOptions = {
  readonly until?: string;
  readonly json?: boolean;
  readonly vault?: string;
};

type ProposalsCliOptions = {
  readonly all?: boolean;
  readonly json?: boolean;
  readonly vault?: string;
};

type ApplyCliOptions = {
  readonly json?: boolean;
  readonly vault?: string;
};

type RejectCliOptions = {
  readonly json?: boolean;
  readonly vault?: string;
};

type RunCliOptions = {
  readonly json?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type LintCliOptions = {
  readonly failOn?: LintFailOn;
  readonly limit?: number;
  readonly verbose?: boolean;
  readonly json?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type QueryCliOptions = {
  readonly category?: string;
  readonly type?: string;
  readonly limit?: number;
  readonly miss?: string | boolean;
  readonly json?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type TodayCliOptions = {
  readonly date?: string;
  readonly limit?: number;
  readonly watch?: boolean;
  readonly interval?: number;
  readonly json?: boolean;
  readonly verbose?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type LogCliOptions = {
  readonly since?: string;
  readonly processor?: string;
  readonly grep?: string;
  readonly limit?: number;
  readonly json?: boolean;
  readonly vault?: string;
};

type ExplainCliOptions = {
  readonly json?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type ExportContextCliOptions = {
  readonly limit?: number;
  readonly miss?: string | boolean;
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

type AgendaWithCliOptions = {
  readonly date?: string;
  readonly limit?: number;
  readonly json?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type StaleClaimsCliOptions = {
  readonly json?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type OrphanPagesCliOptions = {
  readonly json?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type ReanchorCliOptions = {
  readonly to?: string;
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
  readonly daemon?: boolean;
  readonly filterProcessor?: string;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};

type StatusCliOptions = {
  readonly loops?: boolean;
  readonly probe?: boolean;
  readonly verbose?: boolean;
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

type ParsedProcessorArgs = {
  readonly raw: ReadonlyArray<string>;
  readonly flags: Readonly<Record<string, string | boolean | ReadonlyArray<string | boolean>>>;
  readonly positionals: ReadonlyArray<string>;
};

function parseProcessorArgs(
  argv: ReadonlyArray<string>,
): ParsedProcessorArgs {
  const flags: Record<string, string | boolean | Array<string | boolean>> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token === undefined || !token.startsWith("--") || token.length <= 2) {
      if (token !== undefined) positionals.push(token);
      continue;
    }

    const body = token.slice(2);
    const eqIdx = body.indexOf("=");
    if (eqIdx >= 0) {
      const key = body.slice(0, eqIdx);
      if (key.length > 0) addProcessorFlag(flags, key, body.slice(eqIdx + 1));
      continue;
    }

    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      addProcessorFlag(flags, body, next);
      i++;
    } else {
      addProcessorFlag(flags, body, true);
    }
  }
  return Object.freeze({
    raw: Object.freeze([...argv]),
    flags: Object.freeze(flags),
    positionals: Object.freeze(positionals),
  });
}

function addProcessorFlag(
  flags: Record<string, string | boolean | Array<string | boolean>>,
  key: string,
  value: string | boolean,
): void {
  const existing = flags[key];
  if (existing === undefined) {
    flags[key] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    flags[key] = [existing, value];
  }
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

function parseInitModelProviderOption(value: string): "anthropic" {
  if (value === "anthropic") return value;
  throw new InvalidArgumentError(
    "invalid provider; expected one of: anthropic",
  );
}

/** Repeatable `--with-source <kind>` accumulator. Unknown kind → EX_USAGE. */
function parseInitSourceOption(
  value: string,
  previous: ReadonlyArray<"calendar" | "slack">,
): ReadonlyArray<"calendar" | "slack"> {
  if (value === "calendar" || value === "slack") return [...previous, value];
  throw new InvalidArgumentError(
    "invalid source kind; expected one of: calendar, slack",
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
