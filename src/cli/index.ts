#!/usr/bin/env bun
//
// Dome CLI entry — v1 minimal surface.
//
// Commands shipped in v1.0: init, inspect, doctor (stub), status, serve, sync.
// The full CLI surface per [[wiki/specs/cli]] has 14 commands; v1.0 ships
// the most-essential to prove the v1 stack works end-to-end. The
// wrong-shape `dome submit` was retired in Phase 11a (the canonical
// write path is `git commit` + the `dome serve` watcher daemon, with
// `dome sync` as the one-shot catch-up for users who don't want a
// long-running daemon).
//
// CLI surface recut: the pre-recut `dome doctor --show <subject>` was
// split into `dome inspect <subject>` (the v1.0 read surface) plus
// `dome doctor` (reserved for the v1.x health-check verb). The
// `dome answer <id>` surface is also reserved for v1.x. See
// [[wiki/specs/cli]] §"dome inspect" / §"dome doctor" / §"dome answer".
//
// This file's two responsibilities:
//
//   1. When imported as a module (`import { runCli } from ".../cli"`):
//      expose `runCli(argv: ReadonlyArray<string>): Promise<number>` so
//      callers (the `bin/dome` shim, the tests) can invoke without
//      spawning a subprocess.
//
//   2. When invoked directly via Bun (`bun src/cli/index.ts`):
//      `import.meta.main` is true; the bottom-of-file block dispatches
//      `process.argv` and exits with the returned code.
//
// Exit codes (POSIX):
//   - 0 on success.
//   - 1 on runtime error (I/O failure, etc.).
//   - 64 EX_USAGE on malformed command line.

import { parseArgs, type ParsedArgs } from "./args";
import { runInit } from "./commands/init";
import { runDoctor } from "./commands/doctor";
import { runInspect } from "./commands/inspect";
import { runServe } from "./commands/serve";
import { runStatus } from "./commands/status";
import { runSync } from "./commands/sync";

// ----- runCli ---------------------------------------------------------------

/**
 * Run the CLI against a raw argv slice. Returns the exit code. Never
 * throws on expected errors — each command handler is responsible for
 * surfacing its own failures and returning the right code.
 *
 * Programmer errors (e.g., a bug in a command handler that throws
 * unexpectedly) propagate; the caller's `process.exit(code)` site
 * surfaces them as crashes, which is the right loudness for a CLI.
 */
export async function runCli(argv: ReadonlyArray<string>): Promise<number> {
  const args = parseArgs(argv);

  if (args.command === "") {
    printUsage();
    return 64;
  }

  switch (args.command) {
    case "init":
      return runInit(args);
    case "doctor":
      return runDoctor(args);
    case "inspect":
      return runInspect(args);
    case "serve":
      return runServe(args);
    case "status":
      return runStatus(args);
    case "sync":
      return runSync(args);
    case "help":
    case "--help":
    case "-h":
      printUsage();
      return 0;
    default:
      console.error(`dome: unknown command '${args.command}'`);
      printUsage();
      return 64;
  }
}

// ----- internals ------------------------------------------------------------

function printUsage(): void {
  console.error(
    [
      "Usage: dome <command> [options]",
      "",
      "Commands (v1.0):",
      "  init [path]                      Initialize a vault.",
      "  inspect <subject> [--limit <n>] [--json]",
      "                                   Read-only view over the operational substrate.",
      "                                   Subjects: runs, diagnostics, questions, outbox.",
      "  doctor [--repair]                (reserved for v1.x) Engine-substrate health checks.",
      "  serve [--poll-interval-ms <n>]   Run the commit-watcher daemon.",
      "  status [--json]                  Read-only adoption snapshot.",
      "  sync [--json]                    One-shot catch-up: adopt working-tree HEAD.",
      "",
      "Common flags:",
      "  --vault <path>                   Override the vault path (default: cwd).",
    ].join("\n"),
  );
}

// ----- Direct-invocation entry ----------------------------------------------
//
// When this file is run via `bun src/cli/index.ts` (or via `bin/dome`'s
// `import "../src/cli/index.ts"` form), `import.meta.main` is true and we
// dispatch immediately. When the file is imported as a module (the
// test suite, the type-check pass), the block below is skipped.

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}

// Re-export the ParsedArgs type so test consumers can build their own
// args without re-importing `./args` directly.
export type { ParsedArgs };
