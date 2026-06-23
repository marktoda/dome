// cli/commands/lint: first-class wrapper for the dome.lint report view.

import { basename } from "node:path";

import { parsePositiveIntegerValue } from "../parse-options";
import {
  dimZeros,
  finding,
  headline,
  kv,
  resolveCaps,
  section,
  type Status,
} from "../presenter";
import { FIRST_PARTY_VIEWS } from "../../surface/view-catalog";
import {
  type LintData,
  type LintSeverity,
} from "../../surface/lint-view";
import { printViewCommandError } from "./view-shared";
import { runCliStructuredView } from "../structured-view-command";

import { resolveVaultPath } from "../../surface/resolve-vault";
export type LintFailOn = "info" | "warning" | "error" | "block" | "never";

export type LintCommandOptions = {
  readonly failOn?: LintFailOn | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
  readonly verbose?: boolean | undefined;
  readonly limit?: string | number | boolean | undefined;
};

export async function runLint(
  options: LintCommandOptions = {},
): Promise<number> {
  const limit = parsePositiveIntegerValue(options.limit, null);
  if (options.limit !== undefined && limit === null) {
    printViewCommandError({
      commandLabel: "dome lint",
      json: options.json === true,
      error: "lint-usage",
      messages: ["dome lint: --limit must be a positive integer."],
    });
    return 64;
  }

  return runCliStructuredView({
    commandLabel: "dome lint",
    entry: FIRST_PARTY_VIEWS.lint,
    commandArgs: Object.freeze({
      ...(options.failOn !== undefined ? { failOn: options.failOn } : {}),
      ...(limit !== null ? { limit } : {}),
    }),
    vault: options.vault,
    bundlesRoot: options.bundlesRoot,
    json: options.json === true,
    noStructuredResultMessage:
      "dome lint: lint processor returned no structured result.",
    failedError: "lint-failed",
    renderHuman: (data) =>
      renderLintText(
        data,
        resolveVaultPath(options.vault),
        options.verbose === true,
      ),
    successExitCode: (data) => (data.status === "fail" ? 1 : 0),
  });
}

export function renderLintText(data: LintData, vaultPath: string, verbose: boolean = false): string {
  const caps = resolveCaps();

  // Determine verdict status.
  // Pass: single "✓ pass — N files, no issues" line.
  // Issues: ⚠ warn tone if only warning/info; ✗ err tone if any block/error.
  const hasBlockOrError = data.counts.block > 0 || data.counts.error > 0;
  const n = data.counts.total;
  const files = data.checked.markdownFiles;
  const passLabel = n === 0
    ? `pass — ${files} files, no issues`
    : `pass — ${files} files, ${n} ${n === 1 ? "issue" : "issues"} below threshold`;
  const headStatus: Status = data.status === "pass"
    ? { tone: "ok", label: passLabel }
    : hasBlockOrError
      ? { tone: "err", label: `${n} ${n === 1 ? "issue" : "issues"}` }
      : { tone: "warn", label: `${n} ${n === 1 ? "issue" : "issues"}` };

  const lines: string[] = [
    headline({ cmd: "lint", context: basename(vaultPath) }, headStatus, caps),
  ];

  // Verbose: CHECKED section with files / fail-on / dimZeros breakdown.
  if (verbose) {
    lines.push(
      ...section(
        "Checked",
        kv(
          [
            { label: "files", value: `${data.checked.markdownFiles} markdown` },
            { label: "fail-on", value: data.failOn },
            {
              label: "issues",
              value: dimZeros(
                [
                  `${data.counts.total} total`,
                  `${data.counts.block} block`,
                  `${data.counts.error} error`,
                  `${data.counts.warning} warning`,
                  `${data.counts.info} info`,
                ],
                caps,
              ),
            },
          ],
          caps,
        ),
        caps,
      ),
    );
  }

  // Local copy — not imported from health-finding-view — because lint treats
  // `block` and `error` as distinct severities (0 vs 1), whereas the health
  // bridge collapses both to 0 so check/doctor sort them as peers.
  const SEVERITY_ORDER: Record<LintSeverity, number> = {
    block: 0,
    error: 1,
    warning: 2,
    info: 3,
  };

  if (data.issues.length > 0) {
    const sortedIssues = data.issues.slice().sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );
    // Render findings directly (no ISSUES section header) — matches check/doctor default.
    for (let i = 0; i < sortedIssues.length; i++) {
      const issue = sortedIssues[i]!;
      lines.push("");
      const subject = issue.sourceRefs.length > 0 ? issue.sourceRefs[0]!.path : issue.code;
      lines.push(
        ...finding(
          {
            severity: issue.severity,
            code: issue.code,
            subject,
            what: issue.message,
          },
          caps,
          verbose,
        ),
      );
    }
    if (data.omittedIssues > 0) {
      const noun = data.omittedIssues === 1 ? "issue" : "issues";
      lines.push(
        `  ... ${data.omittedIssues} more ${noun} (use --limit ${data.counts.total} to show all)`,
      );
    }
  }

  // No footer/rule — matches check/doctor style.

  return lines.join("\n");
}
