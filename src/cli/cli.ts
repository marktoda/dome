import { Command, Option, CommanderError } from "commander";
import { domeInit } from "./commands/init";
import { domeReconcile } from "./commands/reconcile";
import { domeDoctor, type DoctorOpts } from "./commands/doctor";
import { domeMigrate } from "./commands/migrate";
import { domeLint } from "./commands/lint";
import { domeExportContext } from "./commands/export-context";
import { domeServe } from "./commands/serve";
import { formatMissingApiKey } from "./api-key-guard";
import type { ToolError } from "../types";

/**
 * Render a ToolError as a one-line stderr message. Special-cases the kinds
 * the user is most likely to encounter at the CLI surface; everything else
 * falls back to JSON so the structured shape is still visible.
 */
function renderToolError(error: ToolError): string {
  if (error.kind === "missing-api-key") return formatMissingApiKey(error);
  if (error.kind === "vault-not-git-repo") {
    return `Not a git repository: ${error.path}. Run 'git init' or use 'dome migrate' on an existing markdown vault.`;
  }
  if (error.kind === "config-invalid") {
    return `Vault config error: ${error.message}. Is this a Dome vault? Run 'dome init <path>' to bootstrap.`;
  }
  if (error.kind === "already-exists") {
    return `Already exists: ${error.path}`;
  }
  if (error.kind === "not-found") {
    return `Not found: ${error.path}`;
  }
  if (error.kind === "validation") return error.message;
  // Fall back to JSON for the less-common, more-structured kinds (invariant
  // violations, concurrent-write-conflict, dispatcher-owned-path, …) so the
  // user can see the full payload.
  return JSON.stringify(error);
}

// --------------------------------------------------------------------------
// Exit codes
// --------------------------------------------------------------------------
// POSIX convention: 0 = success (including explicit --help), 2 = usage error.
// Each runCli entry-point arm classifies its outcome into one of these.

export const ExitCode = {
  Success: 0,
  Failure: 1,
  Usage: 2,
} as const;
export type ExitCode = typeof ExitCode[keyof typeof ExitCode];

// --------------------------------------------------------------------------
// Doctor --show subjects
// --------------------------------------------------------------------------
// `--show` takes a structured subject keyword. Commander validates against
// this list; unknown subjects produce a usage error with a helpful message.

const DOCTOR_SHOW_SUBJECTS = [
  "review-queue",
  "raw-citations",
  "workflows",
  "events",
  "recent-hook-cycles",
] as const;
type DoctorShowSubject = typeof DOCTOR_SHOW_SUBJECTS[number];

interface DoctorCliOpts {
  rebuildIndex?: boolean;
  recentActivity?: boolean;
  drainHooks?: boolean;
  resetQuarantinedHooks?: boolean;
  show?: DoctorShowSubject;
}

function toDoctorOpts(cli: DoctorCliOpts): DoctorOpts {
  const opts: DoctorOpts = {};
  if (cli.rebuildIndex) opts.rebuildIndex = true;
  if (cli.recentActivity) opts.recentActivity = true;
  if (cli.drainHooks) opts.drainHooks = true;
  if (cli.resetQuarantinedHooks) opts.resetQuarantinedHooks = true;
  switch (cli.show) {
    case "review-queue": opts.showReviewQueue = true; break;
    case "raw-citations": opts.showRawCitations = true; break;
    case "workflows": opts.showWorkflows = true; break;
    case "events": opts.showEvents = true; break;
    case "recent-hook-cycles": opts.showRecentHookCycles = true; break;
  }
  return opts;
}

// --------------------------------------------------------------------------
// Program builder
// --------------------------------------------------------------------------
// Each command's action mutates `outcome` instead of returning — Commander's
// action callbacks don't propagate a return value the way runCli needs. After
// parseAsync resolves, runCli reads outcome to determine the exit code.

interface RunOutcome {
  code: ExitCode;
}

function buildProgram(outcome: RunOutcome): Command {
  const program = new Command();

  program
    .name("dome")
    .description(
      [
        "Dome v0.5 — a brain-companion substrate.",
        "",
        "Dome turns a markdown vault into a typed, invariant-enforcing memory",
        "your AI tools can read, write, and reason over. Every mutation flows",
        "through one of seven Tools; the four-concept core (Vault, Document,",
        "Tool, Hook) is sealed.",
      ].join("\n"),
    )
    .version("0.0.1", "-v, --version", "Print version and exit")
    .helpOption("-h, --help", "Show help")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  dome init ~/vaults/work             # bootstrap a new vault",
        "  cd ~/vaults/work && dome doctor     # structural diagnostic",
        "  cd ~/vaults/work && dome reconcile  # catch up hook state",
        "  dome serve --vault ~/vaults/work    # start MCP server + watcher",
        "",
        "Environment:",
        "  ANTHROPIC_API_KEY  Required for workflow-driven commands",
        "                     (lint, migrate, export-context).",
        "",
        "Exit codes:",
        "  0  success",
        "  1  command-level failure (vault open failed, violations found, ...)",
        "  2  usage error (missing arg, unknown flag, unknown command)",
        "",
        "Run `dome <command> --help` for per-command details.",
      ].join("\n"),
    );

  // ------ init ------
  program
    .command("init")
    .description("Bootstrap a new Dome vault at <path>.")
    .argument("<path>", "Directory to create the vault in")
    .addHelpText(
      "after",
      [
        "",
        "Creates the directory tree (raw/, wiki/, inbox/raw/, .dome/),",
        "writes shipped-default config + page-types + intake-raw hook,",
        "initializes a git repo, and makes the initial commit.",
        "",
        "Refuses if <path> already contains .dome/ — use `dome migrate` instead.",
      ].join("\n"),
    )
    .action(async (path: string) => {
      const r = await domeInit(path);
      if (!r.ok) { console.error(renderToolError(r.error)); outcome.code = ExitCode.Failure; return; }
      console.log(`Initialized Dome vault at ${r.value.path} (sha ${r.value.sha.slice(0, 7)})`);
    });

  // ------ migrate ------
  program
    .command("migrate")
    .description("Convert an existing markdown vault to Dome shape.")
    .argument("<path>", "Existing vault directory")
    .option("--apply", "Apply the migration plan (default: dry-run + write plan)")
    .addHelpText(
      "after",
      [
        "",
        "Runs the `migrate` workflow against an LLM. Without --apply, writes",
        "a plan to <path>/.dome/migration-plan.md for review. With --apply,",
        "executes the plan via Dome's Tools (every move + frontmatter add",
        "is logged).",
        "",
        "Requires ANTHROPIC_API_KEY.",
      ].join("\n"),
    )
    .action(async (path: string, opts: { apply?: boolean }) => {
      const r = await domeMigrate(path, opts.apply === true, {});
      if (!r.ok) { console.error(renderToolError(r.error)); outcome.code = ExitCode.Failure; return; }
      if (r.value.text.length > 0) console.log(r.value.text);
      console.error(`migrate complete: ${r.value.steps} step(s)`);
    });

  // ------ serve ------
  program
    .command("serve")
    .description("Start the MCP server + filesystem watcher.")
    .option("--vault <path>", "Vault path (defaults to current directory)")
    .addHelpText(
      "after",
      [
        "",
        "Opens the vault, runs reconcile to catch up missed events,",
        "starts the chokidar watcher, and connects the MCP server over stdio.",
        "Press Ctrl-C to stop.",
        "",
        "Typically invoked by a harness (Claude Code) as a child process,",
        "or by the user as a launchd/systemd service.",
      ].join("\n"),
    )
    .action(async (opts: { vault?: string }) => {
      const path = opts.vault ?? process.cwd();
      // connectStdio: true wires the MCP server's request handlers to the
      // process's stdin/stdout — Claude Code (and any stdio-MCP harness)
      // spawns this command as a child process and speaks JSON-RPC over that
      // channel. server.connect(transport) inside serveStdio runs the
      // transport's read loop on a Node event-loop handle, which keeps the
      // process alive until stdin closes.
      const r = await domeServe(path, { connectStdio: true });
      if (!r.ok) { console.error(renderToolError(r.error)); outcome.code = ExitCode.Failure; return; }
      // serveStdio has connected the transport. Log to stderr so the JSON-RPC
      // channel on stdout stays clean; log to stdout would corrupt the
      // protocol on the first message.
      console.error("[dome serve] MCP server connected on stdio; press Ctrl-C to stop");
      // Park the action until the transport closes. v0.5 keeps it simple —
      // full daemonization (signal handling, graceful stop, log rotation) is
      // deferred to v1.
      await new Promise<void>(() => {});
    });

  // ------ reconcile ------
  program
    .command("reconcile")
    .description("Catch up the vault's hook execution state.")
    .addHelpText(
      "after",
      [
        "",
        "Runs three phases:",
        "  1. Inbox processing  — fires document.written.inbox.<bucket> for",
        "                         each file in inbox/<bucket>/",
        "  2. Git-diff replay   — fires document.written.<category>.<type>",
        "                         for files changed since the last reconcile",
        "  3. Scheduled catchup — fires clock.tick.<interval> for elapsed",
        "                         schedules",
        "",
        "Run from inside a vault directory. Refuses to run during a mid-merge,",
        "mid-rebase, or mid-cherry-pick.",
      ].join("\n"),
    )
    .action(async () => {
      const r = await domeReconcile(process.cwd());
      if (!r.ok) { console.error(renderToolError(r.error)); outcome.code = ExitCode.Failure; return; }
      const v = r.value;
      console.log(`reconcile complete: ${v.inboxProcessed} inbox, ${v.changedFiles} changed, ${v.scheduledFired} scheduled`);
    });

  // ------ lint ------
  program
    .command("lint")
    .description("Run the lint workflow against the vault (semantic; LLM-driven).")
    .addHelpText(
      "after",
      [
        "",
        "Walks the wiki and surfaces orphans, stale claims, missing",
        "cross-references, contradictions, and schema-violating frontmatter.",
        "Proposes fixes; does not apply them without user confirmation.",
        "",
        "For deterministic structural checks (no LLM), use `dome doctor`.",
        "",
        "Requires ANTHROPIC_API_KEY.",
      ].join("\n"),
    )
    .action(async () => {
      const r = await domeLint(process.cwd(), {});
      if (!r.ok) { console.error(renderToolError(r.error)); outcome.code = ExitCode.Failure; return; }
      if (r.value.text.length > 0) console.log(r.value.text);
      console.error(`lint complete: ${r.value.steps} step(s)`);
    });

  // ------ export-context ------
  program
    .command("export-context")
    .description("Produce a markdown context-packet for cross-AI handoff.")
    .argument("<topic>", "Topic to export context for (in quotes if multi-word)")
    .addHelpText(
      "after",
      [
        "",
        "Produces a structured markdown packet with sections for entities,",
        "current synthesis, open questions, related decisions, and source",
        "trail. Pipe into your next AI tool to resume thinking with full",
        "context.",
        "",
        "Requires ANTHROPIC_API_KEY.",
      ].join("\n"),
    )
    .action(async (topic: string) => {
      const r = await domeExportContext(process.cwd(), topic, {});
      if (!r.ok) { console.error(renderToolError(r.error)); outcome.code = ExitCode.Failure; return; }
      if (r.value.text.length > 0) console.log(r.value.text);
      console.error(`export-context complete: ${r.value.steps} step(s)`);
    });

  // ------ doctor ------
  program
    .command("doctor")
    .description("Run deterministic structural checks on the vault.")
    .option("--rebuild-index", "Regenerate index.md from scratch by walking wiki/")
    .option("--recent-activity", "Show recent activity (v0.5 no-op; use `git log`)")
    .option("--drain-hooks", "Wait for async hook queue to drain (v0.5 no-op)")
    .option("--reset-quarantined-hooks", "Clear hook quarantine list (v0.5 no-op)")
    .addOption(
      new Option("--show <subject>", "Show a specific diagnostic surface").choices([...DOCTOR_SHOW_SUBJECTS]),
    )
    .addHelpText(
      "after",
      [
        "",
        "Checks performed (each surfaces violations or info):",
        "  - Frontmatter type matches its wiki/<type>/ directory",
        "  - Wikilinks use full-path form (WIKILINKS_ARE_FULLPATH)",
        "  - Wikilinks resolve to existing files",
        "  - No unknown wiki subdirectories",
        "  - Raw files not modified after creation (RAW_IS_IMMUTABLE)",
        "  - log.md timestamps monotonically non-decreasing",
        "  - Frontmatter fields within the per-type schema (soft warning)",
        "  - Unused page-type extensions (info)",
        "",
        "Subjects for --show:",
        "  review-queue        Items in inbox/review/ awaiting human review",
        "  raw-citations       Wiki pages that cite each raw source",
        "  workflows           Resolved workflow set (defaults + plugins + local)",
        "  events              Event taxonomy",
        "  recent-hook-cycles  Recent hook.cycle-detected events",
        "",
        "Exit code is 0 if clean, 1 if any violation was found. Soft warnings",
        "don't affect the exit code.",
      ].join("\n"),
    )
    .action(async (cliOpts: DoctorCliOpts) => {
      const r = await domeDoctor(process.cwd(), toDoctorOpts(cliOpts));
      if (!r.ok) { console.error(renderToolError(r.error)); outcome.code = ExitCode.Failure; return; }
      for (const line of r.value.info) console.log(line);
      if (r.value.violations.length === 0) {
        console.log("doctor: clean");
        return;
      }
      for (const v of r.value.violations) console.log(`! ${v}`);
      outcome.code = ExitCode.Failure;
    });

  // Suppress Commander's process.exit; runCli is the one place that decides
  // exit behavior. By configuring exitOverride, Commander throws CommanderError
  // instead of calling process.exit, which lets runCli classify the outcome.
  program.exitOverride();
  program.configureOutput({
    writeOut: (s) => process.stdout.write(s),
    writeErr: (s) => process.stderr.write(s),
  });

  return program;
}

/**
 * Execute the Dome CLI against `argv` (without the leading "dome" token).
 * Returns the exit code; the caller (bin/dome) is responsible for process.exit.
 */
export async function runCli(argv: ReadonlyArray<string>): Promise<ExitCode> {
  const outcome: RunOutcome = { code: ExitCode.Success };
  const program = buildProgram(outcome);

  // Commander expects argv in `process.argv` shape (with two leading slots);
  // parseAsync from "user" treats argv[0] as the first user-supplied token.
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (e) {
    if (e instanceof CommanderError) {
      // Commander signals --help and --version through CommanderError with
      // exitCode 0; treat those as success and let other errors fall through
      // as Usage. The code field distinguishes the classes:
      //   commander.helpDisplayed / commander.version  -> success
      //   commander.missingArgument / .unknownCommand / .invalidArgument -> usage
      //   commander.unknownOption / .conflictingOption                    -> usage
      if (e.exitCode === 0) return ExitCode.Success;
      return ExitCode.Usage;
    }
    // Unexpected error in an action — already logged by the action; surface
    // as Failure.
    console.error(e instanceof Error ? e.message : String(e));
    return ExitCode.Failure;
  }
  return outcome.code;
}
