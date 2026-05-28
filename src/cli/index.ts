#!/usr/bin/env bun
//
// Dome CLI entry — v1 minimal surface.
//
// Commands shipped in v1.0: init, doctor, status, serve. The full CLI
// surface per [[wiki/specs/cli]] has 14 commands; v1.0 ships the most-
// essential to prove the v1 stack works end-to-end. The user-facing
// `dome sync` (one-shot catch-up) lands in Phase 11c; the wrong-shape
// `dome submit` was retired in Phase 11a (the canonical write path is
// `git commit` + the `dome serve` watcher daemon).
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
import { runServe } from "./commands/serve";
import { runStatus } from "./commands/status";

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
    case "serve":
      return runServe(args);
    case "status":
      return runStatus(args);
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
      "  doctor --show <subject>          Read-only diagnostic view.",
      "         [--limit <n>] [--json]    Subjects: runs, diagnostics, questions, outbox.",
      "  serve [--poll-interval-ms <n>]   Run the commit-watcher daemon.",
      "  status [--json]                  Read-only adoption snapshot.",
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
