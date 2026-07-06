// cli/commands/explain: `dome explain <target>` — the provenance debugger.
// The data core (`collectExplain` / `buildExplain`) lives in
// src/surface/explain.ts and is shared with the MCP `explain` tool; this
// module owns terminal rendering only (mirrors src/cli/commands/proposals.ts).
//
// Exit codes: 0 on a rendered view; 64 (EX_USAGE) for an invalid target or a
// path absent from adopted state — with the `dome.command-error/v1` envelope
// on stdout under `--json`; 1 when the vault runtime fails to open.

import {
  buildExplain,
  explainJson,
  type ExplainView,
} from "../../surface/explain";
import { COMMAND_ERROR_SCHEMA } from "../../surface/command-error";
import { formatJson } from "../../surface/format";
import { emitRuntimeOpenFailure } from "../command-error";

export type RunExplainOptions = {
  readonly target?: string | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
};

export async function runExplain(
  options: RunExplainOptions = {},
): Promise<number> {
  const json = options.json === true;
  const outcome = await buildExplain({
    vault: options.vault,
    bundlesRoot: options.bundlesRoot,
    target: options.target ?? "",
  });

  if (outcome.kind === "runtime-open-failed") {
    return emitRuntimeOpenFailure({
      command: "explain",
      json,
      errorKind: outcome.errorKind,
    });
  }

  if (outcome.kind !== "ok") {
    if (json) {
      console.log(
        formatJson({
          schema: COMMAND_ERROR_SCHEMA,
          status: "error",
          command: "explain",
          error: outcome.kind,
          message: outcome.message,
        }),
      );
    } else {
      console.error(`dome explain: ${outcome.message}`);
    }
    return 64;
  }

  if (json) {
    console.log(formatJson(explainJson(outcome.view)));
    return 0;
  }

  console.log(formatExplainText(outcome.view));
  return 0;
}

// ----- internals -------------------------------------------------------------

/**
 * Render the provenance chain top-down: the claim (when anchored), the
 * facts with their producing processors, the runs with cost, then the
 * recent commits with their Dome-* trailers.
 */
export function formatExplainText(view: ExplainView): string {
  const lines: string[] = [
    `explain ${view.target}  ·  adopted ${view.adoptedCommit.slice(0, 7)}`,
  ];

  if (view.anchor !== null) {
    lines.push("", "Claim");
    if (view.claim === null) {
      lines.push(`  no claim carries ^${view.anchor} on ${view.path}`);
    } else {
      const asOf = view.claim.asOf !== null ? ` (as of ${view.claim.asOf})` : "";
      const line = view.claim.line !== null ? `, line ${view.claim.line}` : "";
      lines.push(
        `  ${view.claim.key}: ${view.claim.value}${asOf}`,
        `  [^${view.claim.anchor}${line}]`,
      );
    }
  }

  lines.push("", `Facts (${view.facts.length})`);
  if (view.facts.length === 0) {
    lines.push("  none in the projection for this target");
  }
  for (const fact of view.facts) {
    const at =
      fact.sourceRef?.startLine != null ? `  line ${fact.sourceRef.startLine}` : "";
    lines.push(`  ${fact.predicate}  ·  by ${fact.processorId}  ·  ${fact.runId}${at}`);
  }

  lines.push("", `Runs (${view.runs.length})`);
  if (view.runs.length === 0) {
    lines.push("  none — no facts carry run provenance for this target");
  }
  for (const run of view.runs) {
    if (!run.inLedger) {
      lines.push(`  ${run.runId}  ${run.processorId}  (not in ledger — aged out)`);
      continue;
    }
    const cost = run.costUsd !== null ? `  $${run.costUsd.toFixed(4)}` : "";
    lines.push(
      `  ${run.runId}  ${run.processorId}  ${run.status}  ${run.startedAt}${cost}`,
    );
  }

  lines.push("", `Recent commits touching ${view.path} (${view.commits.length})`);
  if (view.commits.length === 0) {
    lines.push("  none");
  }
  for (const commit of view.commits) {
    const trailer =
      commit.domeRun !== null
        ? `  [engine: ${commit.domeExtension ?? "?"} ${commit.domeRun}]`
        : "";
    lines.push(
      `  ${commit.sha.slice(0, 7)}  ${commit.committedAt}  ${commit.subject}${trailer}`,
    );
  }

  return lines.join("\n");
}
