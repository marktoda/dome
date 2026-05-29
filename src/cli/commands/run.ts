// cli/commands/run: the `dome run <name> [--json]` CLI command — Phase 13a.
//
// Thin CLI wrapper around Phase 4b's `src/engine/commands.ts:runViewCommand`.
// Parses argv, opens the vault runtime, resolves the adopted commit, calls
// `runViewCommand` against the runtime's `viewRunner`, captures the
// returned ViewEffects, and renders them as JSON on stdout.
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
// this file is required. `viewRunner` does the lookup; the bundle loader
// rejects collisions at load time.
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

import { resolve } from "node:path";

import { getAdoptedRef, getCurrentBranch } from "../../adopted-ref";
import { commitOid } from "../../core/source-ref";
import { runViewCommand } from "../../engine/commands";
import { openVaultRuntime } from "../../engine/vault-runtime";
import { buildSqliteSinks } from "../../projections/sinks";

import { resolveShippedBundlesRoot } from "./sync-shared";
import { formatJson } from "../format";

import type { ApplyEffectSinks } from "../../engine/apply-effect";
import type { ViewEffect } from "../../core/effect";

// ----- runRun ---------------------------------------------------------------

export type RunCommandOptions = {
  readonly name?: string | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
  readonly commandFlags?: Readonly<Record<string, string | boolean>> | undefined;
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

  const vaultPath = resolve(options.vault ?? process.cwd());

  const bundlesRoot = options.bundlesRoot ?? resolveShippedBundlesRoot();

  // ----- 2. Resolve the snapshot commit -----------------------------------
  // View-phase processors read the *adopted* snapshot, not HEAD. The
  // adopted ref is the trusted state — running a view against unstable
  // working-tree HEAD would surface stale or contradictory data. If the
  // adopted ref isn't initialized (the vault has never synced), refuse
  // with a usage error and a clear remediation.
  const branch = await getCurrentBranch(vaultPath);
  if (branch === null) {
    console.error(
      "dome run: HEAD is detached. The view-phase substrate requires a branch. Check out a branch and retry.",
    );
    return 64;
  }
  const adoptedSha = await getAdoptedRef(vaultPath, branch);
  if (adoptedSha === null) {
    console.error(
      `dome run: vault has no adopted ref for branch '${branch}'. Run \`dome sync\` first to initialize.`,
    );
    return 64;
  }
  const adopted = commitOid(adoptedSha);

  // ----- 3. Open the runtime ----------------------------------------------
  const runtimeResult = await openVaultRuntime({ vaultPath, bundlesRoot });
  if (!runtimeResult.ok) {
    console.error(
      `dome run: openVaultRuntime failed (${runtimeResult.error.kind}). Run \`dome init\` to initialize the vault.`,
    );
    return 1;
  }
  const runtime = runtimeResult.value;

  try {
    // ----- 4. Build commandArgs from non-meta flags -----------------------
    // View-phase processors that care about CLI flags inspect
    // `ctx.input.commandArgs.flags`. The envelope shape is opaque to
    // the engine — `runViewCommand` passes it through verbatim.
    const flags: Record<string, string | boolean> = {
      ...(options.commandFlags ?? {}),
    };
    const commandArgs = Object.freeze({
      flags: Object.freeze(flags),
    });

    // ----- 5. Build the sinks ---------------------------------------------
    // View-phase emissions are filtered into a captured array; non-View
    // effects route through the standard projection sinks (where the
    // broker's phase-mismatch check rejects them — `runViewCommand`
    // surfaces those rejections via `brokerDiagnostics`). We use the
    // standard SQLite sinks so even on the (rare) downgrade path the
    // emitted effect lands in the right place.
    const capturedViews: ViewEffect[] = [];
    const captureView: ApplyEffectSinks["captureView"] = async ({
      effect,
    }) => {
      capturedViews.push(effect);
    };
    // `applyPatch` should never be invoked under view-phase routing
    // (the broker rejects PatchEffect as phase-mismatch). Provide a
    // defensive placeholder that drops the patch + returns null.
    const applyPatch: ApplyEffectSinks["applyPatch"] = async () => null;
    const recoverQuarantine: ApplyEffectSinks["recoverQuarantine"] =
      async () => undefined;
    const sinks = buildSqliteSinks({
      projectionDb: runtime.projectionDb,
      outboxDb: runtime.outboxDb,
      adoptedCommit: adopted,
      captureView,
      applyPatch,
      externalHandlers: runtime.externalHandlers,
      recoverQuarantine,
    });

    // ----- 6. Dispatch via runViewCommand ---------------------------------
    const vault = Object.freeze({
      path: vaultPath,
      config: Object.freeze({
        git: Object.freeze({ auto_commit_workflows: false }),
      }),
    });

    let result;
    try {
      result = await runViewCommand({
        vault,
        adopted,
        commandName,
        commandArgs,
        viewRunner: runtime.processorRuntime.viewRunner,
        sinks,
        ledger: runtime.ledgerDb,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`dome run: runViewCommand threw: ${msg}`);
      return 1;
    }

    // ----- 7. Handle not-found --------------------------------------------
    if (result.kind === "not-found") {
      console.error(
        `dome run: unknown command '${result.commandName}'. No view-phase processor declares a matching command trigger.`,
      );
      return 64;
    }

    // ----- 8. Surface broker diagnostics ----------------------------------
    // Phase-mismatch + capability-deny diagnostics from the broker land
    // here. They indicate processor misbehavior (e.g., a view processor
    // emitting a FactEffect) — non-fatal but worth surfacing for the
    // operator's diagnostic surface.
    for (const d of result.brokerDiagnostics) {
      console.error(
        `dome run: broker diagnostic [${d.severity}] ${d.code}: ${d.message}`,
      );
    }

    // ----- 9. Render the captured ViewEffects -----------------------------
    // Prefer the captured-via-sink array (the sink is the canonical
    // delivery surface per ApplyEffectSinks's contract). `runViewCommand`
    // also returns `result.effects`; both should agree.
    const viewEffects =
      capturedViews.length > 0 ? capturedViews : [...result.effects];

    const rendered = await Promise.all(viewEffects.map(renderView));
    console.log(formatJson(rendered.length === 1 ? rendered[0] : rendered));
    return 0;
  } finally {
    await runtime.close();
  }
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
