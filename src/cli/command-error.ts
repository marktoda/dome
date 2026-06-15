// Shared runtime-open failure emitter for CLI command handlers.
//
// Agent-facing contract: a command invoked with `--json` must put a
// structured document on STDOUT for every outcome, including its failure
// path. Before this helper, `status` / `check` / `inspect` / `doctor`
// printed the vault-open failure to stderr only and exited 1 — the exact
// commands AGENTS.md tells agents to run at session start returned empty
// stdout on the most common failure mode, and MCP clients received
// non-JSON fallback text.

import { runtimeOpenFailureMessage } from "../surface/adapter";
import { COMMAND_ERROR_SCHEMA } from "../surface/command-error";
import { formatJson } from "../surface/format";

/**
 * Emit a vault-open failure consistently: a `dome.command-error/v1`
 * envelope on stdout in JSON mode, the human message on stderr otherwise.
 * Returns the exit code (always 1) so call sites stay one-line:
 * `return emitRuntimeOpenFailure({...})`.
 */
export function emitRuntimeOpenFailure(opts: {
  readonly command: string;
  readonly json: boolean;
  readonly errorKind: string;
}): 1 {
  const message = runtimeOpenFailureMessage(
    `dome ${opts.command}`,
    opts.errorKind,
  );
  if (opts.json) {
    console.log(
      formatJson({
        schema: COMMAND_ERROR_SCHEMA,
        status: "error",
        command: opts.command,
        error: opts.errorKind,
        message,
      }),
    );
  } else {
    console.error(message);
  }
  return 1;
}
