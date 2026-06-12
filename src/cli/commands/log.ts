// cli/commands/log: `dome log` — the vault's activity view, rendered from
// git history joined with the run ledger. The collector lives in
// src/surface/activity.ts (shared surface; adapters can adopt it later);
// this module owns flag handling and human-mode rendering.
//
// CLI-native posture (the `dome status` stance): read-only, no runtime
// lock, no Proposal. Exit codes: 0 on a clean read; 1 when the vault has
// no git history surface (not a repo).

import {
  buildActivityLog,
  type ActivityEntry,
} from "../../surface/activity";
import { COMMAND_ERROR_SCHEMA } from "../../surface/command-error";
import { formatJson } from "../../surface/format";
import { paint, resolveCaps, type Caps } from "../presenter";

export const LOG_SCHEMA = "dome.log/v1";

export type RunLogOptions = {
  readonly vault?: string | undefined;
  /** Lower time bound; anything `git log --since` accepts. */
  readonly since?: string | undefined;
  /** Keep only engine entries from this processor/extension id. */
  readonly processor?: string | undefined;
  /** Case-insensitive substring filter over subject + body. */
  readonly grep?: string | undefined;
  /** Maximum entries (default 30). */
  readonly limit?: number | undefined;
  readonly json?: boolean | undefined;
};

export async function runLog(options: RunLogOptions = {}): Promise<number> {
  let entries: ReadonlyArray<ActivityEntry>;
  try {
    entries = await buildActivityLog({
      vault: options.vault,
      since: options.since,
      processor: options.processor,
      grep: options.grep,
      limit: options.limit,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json === true) {
      console.log(
        formatJson({
          schema: COMMAND_ERROR_SCHEMA,
          status: "error",
          command: "log",
          error: "activity-read-failed",
          message: `dome log: ${message}`,
        }),
      );
    } else {
      console.error(`dome log: ${message}`);
    }
    return 1;
  }

  if (options.json === true) {
    console.log(formatJson({ schema: LOG_SCHEMA, entries }));
    return 0;
  }

  printLogText(entries, resolveCaps());
  return 0;
}

// ----- internals ------------------------------------------------------------

/**
 * One block per entry: a `when · author · subject` headline, the narrative
 * body muted underneath, and a muted run line (`run <id> <status> · 3.2s ·
 * $0.04`) when the ledger join landed.
 */
function printLogText(entries: ReadonlyArray<ActivityEntry>, caps: Caps): void {
  if (entries.length === 0) {
    console.log("(no activity)");
    return;
  }
  const blocks = entries.map((entry) => formatEntry(entry, caps));
  console.log(blocks.join("\n\n"));
}

function formatEntry(entry: ActivityEntry, caps: Caps): string {
  const lines = [`${entry.when} · ${entry.author} · ${entry.subject}`];
  for (const bodyLine of entry.body.split("\n")) {
    if (bodyLine.trim().length === 0) continue;
    lines.push(paint(`  ${bodyLine}`, "muted", caps));
  }
  if (entry.run !== null && entry.runId !== null) {
    const segments = [`run ${entry.runId} ${entry.run.status}`];
    if (entry.run.durationMs !== null) {
      segments.push(`${(entry.run.durationMs / 1000).toFixed(1)}s`);
    }
    if (entry.run.costUsd !== null) {
      segments.push(`$${entry.run.costUsd.toFixed(2)}`);
    }
    lines.push(paint(`  ${segments.join(" · ")}`, "muted", caps));
  }
  return lines.join("\n");
}
