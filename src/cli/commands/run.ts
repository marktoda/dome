// cli/commands/run: the `dome run <name> [--json]` CLI command — Phase 13a.
//
// Thin CLI wrapper over the public `openVault` wrapper's `vault.runView`
// (via the shared view-command helpers). Parses argv, dispatches the named
// view command, and renders the returned ViewEffects as JSON on stdout.
//
// Per [[wiki/specs/processors]] §"View phase":
//   - View-phase processors are read-only. PatchEffect / DiagnosticEffect
//     (severity: "block") / FactEffect / QuestionEffect / JobEffect /
//     ExternalActionEffect are rejected by the broker as `phase-mismatch`.
//     The phase-mismatch diagnostics accumulate in
//     `runViewCommand`'s `brokerDiagnostics` for the caller to surface.
//   - View processors read from the projection store via
//     `ctx.projection`. The runtime's view-phase dispatcher wires the
//     live `ProjectionQueryView` against the runtime's open projection DB.
//
// Per docs/wiki/specs/cli.md §"Adding a new command", this command is the
// "command-triggered view-phase processor" pattern: each new
// `dome run <name>` command is realized by adding a view-phase processor
// whose `command` trigger declares `name` — no per-command code change in
// this file is required. `viewRunner` does the lookup; registry validation
// rejects duplicate command triggers before runtime construction succeeds.
//
// Exit codes:
//   - 0   on successful run (the processor returned without throwing;
//         emitted effects are rendered to stdout).
//   - 1   on runtime open failure or unexpected runViewCommand throw.
//   - 64  (EX_USAGE) on:
//           - missing command name positional,
//           - no view-phase processor with matching command trigger,
//           - detached HEAD or missing adopted ref (the view-phase
//             substrate requires a trusted adopted commit to read from).
//
// Output:
//   - Default `--json` (currently the only renderer; non-JSON formatters
//     land in v1.x): when exactly one ViewEffect is emitted, the
//     command emits a single render-object; when multiple are emitted
//     it emits an array. Broker diagnostics (phase-mismatch surprises)
//     are written to stderr, one line each.
//
// House-style notes (matches src/cli/commands/sync.ts, status.ts):
//   - `type X = { ... }` aliases, every field `readonly`.
//   - The handler returns the exit code; the dispatcher
//     (`src/cli/index.ts`) calls `process.exit(code)`.
//   - Console output goes through `console.log` / `console.error`.

import { runSharedViewCommand } from "./view-shared";
import { formatJson } from "../format";
import type { ViewEffect } from "../../core/effect";

// ----- runRun ---------------------------------------------------------------

export type RunCommandOptions = {
  readonly name?: string | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
  readonly commandFlags?: Readonly<Record<string, string | boolean>> | undefined;
  readonly commandArgs?: {
    readonly raw: ReadonlyArray<string>;
    readonly flags: Readonly<Record<string, string | boolean | ReadonlyArray<string | boolean>>>;
    readonly positionals: ReadonlyArray<string>;
  } | undefined;
};

/**
 * Execute `dome run <name>`. Returns the exit code.
 *
 * Positionals + flags:
 *   - `<name>` (positional)        the command name; matched against
 *                                   view-phase processors' `command`
 *                                   triggers by the runtime's
 *                                   `viewRunner`.
 *   - `--vault <path>`              override the vault path (default: cwd).
 *   - `--bundles-root <path>`       override the bundles root (default:
 *                                   the SDK's shipped first-party
 *                                   bundles directory).
 *   - `--json`                      currently the default; reserved for
 *                                   future format toggles.
 *   - any `--<key>=<value>`         passed through to the processor's
 *                                   `ctx.input.commandArgs` as
 *                                   `{ flags: { ... } }`.
 */
export async function runRun(
  options: RunCommandOptions = {},
): Promise<number> {
  // ----- 1. Parse positional + flags --------------------------------------
  const commandName = options.name;
  if (commandName === undefined || commandName.length === 0) {
    console.error(
      "dome run: missing command name. Usage: dome run <name> [--vault <path>] [--json]",
    );
    return 64;
  }

  // ----- 2. Build commandArgs from non-meta flags -----------------------
  // View-phase processors that care about CLI flags inspect
  // `ctx.input.commandArgs.flags`. The envelope shape is opaque to
  // the engine — `runViewCommand` passes it through verbatim.
  const commandArgs = Object.freeze({
    raw: Object.freeze([...(options.commandArgs?.raw ?? [])]),
    flags: Object.freeze({
      ...(options.commandFlags ?? {}),
      ...(options.commandArgs?.flags ?? {}),
    }),
    positionals: Object.freeze([...(options.commandArgs?.positionals ?? [])]),
  });

  // ----- 3. Dispatch via shared view-command boundary -------------------
  let run;
  try {
    run = await runSharedViewCommand({
      commandLabel: "dome run",
      commandName,
      commandArgs,
      vault: options.vault,
      bundlesRoot: options.bundlesRoot,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`dome run: view command failed: ${msg}`);
    return 1;
  }

  if (run.kind === "usage-error") {
    console.error(run.message);
    return 64;
  }
  if (run.kind === "runtime-error") {
    console.error(run.message);
    return 1;
  }

  // ----- 4. Handle not-found --------------------------------------------
  if (run.kind === "not-found") {
    console.error(
      `dome run: unknown command '${commandName}'. No view-phase processor declares a matching command trigger.`,
    );
    return 64;
  }
  if (run.kind === "failed") {
    console.error(
      `dome run: processor '${run.processorId}' finished with ${run.executionStatus}.`,
    );
    if (run.executionError !== null) {
      console.error(
        `dome run: ${run.executionError.code}: ${run.executionError.message}`,
      );
    }
    for (const d of run.diagnostics) {
      console.error(
        `dome run: diagnostic [${d.severity}] ${d.code}: ${d.message}`,
      );
    }
    return 1;
  }

  // ----- 5. Surface broker diagnostics ----------------------------------
  // Phase-mismatch + capability-deny diagnostics from the broker land
  // here. They indicate processor misbehavior (e.g., a view processor
  // emitting a FactEffect) — non-fatal but worth surfacing for the
  // operator's diagnostic surface.
  for (const d of run.brokerDiagnostics) {
    console.error(
      `dome run: broker diagnostic [${d.severity}] ${d.code}: ${d.message}`,
    );
  }

  // ----- 6. Render the ViewEffects ---------------------------------------
  // `vault.runView` already prefers the captured-via-sink array (the sink
  // is the canonical delivery surface per ApplyEffectSinks's contract).
  const rendered = await Promise.all(run.views.map(renderView));
  console.log(formatJson(rendered.length === 1 ? rendered[0] : rendered));
  return 0;
}

// ----- internals ------------------------------------------------------------

/**
 * Render one ViewEffect into a JSON-emittable shape. Splits on the
 * `content.kind` discriminator:
 *
 *   - `markdown`   → `{ name, kind: "markdown", body }`.
 *   - `structured` → `{ name, kind: "structured", schema, data }`.
 *   - `stream`     → `{ name, kind: "stream", chunks: [...] }` (collected).
 *
 * The outer envelope carries the ViewEffect's `name` so a downstream
 * consumer can distinguish which view emitted which payload when multiple
 * are returned.
 */
async function renderView(effect: ViewEffect): Promise<unknown> {
  switch (effect.content.kind) {
    case "markdown":
      return {
        name: effect.name,
        kind: "markdown",
        body: effect.content.body,
      };
    case "structured":
      return {
        name: effect.name,
        kind: "structured",
        schema: effect.content.schema,
        data: effect.content.data,
      };
    case "stream": {
      const chunks: string[] = [];
      for await (const chunk of effect.content.chunks) {
        chunks.push(chunk);
      }
      return {
        name: effect.name,
        kind: "stream",
        chunks,
      };
    }
  }
}
