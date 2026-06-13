// cli/commands/lint: first-class wrapper for the dome.lint report view.

import { basename } from "node:path";

import { formatJson } from "../../surface/format";
import { parsePositiveIntegerValue } from "../parse-options";
import {
  bullets,
  dimZeros,
  finding,
  footer,
  headline,
  kv,
  resolveCaps,
  section,
  type Status,
} from "../presenter";
import {
  firstPartyViewNotFoundMessage,
  runStructuredViewCommand,
  structuredViewBrokerMessages,
} from "../../surface/view";
import { FIRST_PARTY_VIEWS } from "../../surface/view-catalog";
import {
  printViewCommandError,
  printViewCommandMessages,
} from "./view-shared";

import { resolveVaultPath } from "../../surface/resolve-vault";
export type LintFailOn = "info" | "warning" | "error" | "block" | "never";

export type LintCommandOptions = {
  readonly failOn?: LintFailOn | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
  readonly limit?: string | number | boolean | undefined;
};

export async function runLint(
  options: LintCommandOptions = {},
): Promise<number> {
  try {
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

    const run = await runStructuredViewCommand({
      commandLabel: "dome lint",
      commandName: "lint",
      expectedViewName: FIRST_PARTY_VIEWS.lint.viewName,
      expectedSchema: FIRST_PARTY_VIEWS.lint.schema,
      commandArgs: Object.freeze({
        ...(options.failOn !== undefined ? { failOn: options.failOn } : {}),
        ...(limit !== null ? { limit } : {}),
      }),
      vault: options.vault,
      bundlesRoot: options.bundlesRoot,
      notFoundMessage: firstPartyViewNotFoundMessage({
        commandLabel: "dome lint",
        bundleId: FIRST_PARTY_VIEWS.lint.bundleId,
        processorName: FIRST_PARTY_VIEWS.lint.processorName,
      }),
      noStructuredResultMessage:
        "dome lint: lint processor returned no structured result.",
    });

    if (run.kind === "error") {
      printViewCommandError({
        commandLabel: "dome lint",
        json: options.json === true,
        messages: run.messages,
      });
      return run.exitCode;
    }
    printViewCommandMessages(
      structuredViewBrokerMessages("dome lint", run.brokerDiagnostics),
    );

    const data = parseLintData(run.data);
    if (options.json === true) {
      console.log(formatJson(run.data));
    } else {
      const vaultPath = resolveVaultPath(options.vault);
      console.log(renderLintText(data, vaultPath));
    }
    return data.status === "fail" ? 1 : 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    printViewCommandError({
      commandLabel: "dome lint",
      json: options.json === true,
      error: "lint-failed",
      messages: [`dome lint: failed: ${msg}`],
    });
    return 1;
  }
}

export type LintSeverity = "info" | "warning" | "error" | "block";

export type LintIssueData = {
  readonly severity: LintSeverity;
  readonly code: string;
  readonly message: string;
  readonly sourceRefs: ReadonlyArray<{ readonly path: string; readonly commit: string }>;
};

export type LintData = {
  readonly status: "pass" | "fail";
  readonly failOn: string;
  readonly checked: { readonly markdownFiles: number };
  readonly counts: {
    readonly total: number;
    readonly info: number;
    readonly warning: number;
    readonly error: number;
    readonly block: number;
  };
  readonly shownIssues: number;
  readonly omittedIssues: number;
  readonly issues: ReadonlyArray<LintIssueData>;
};

export function parseLintData(data: unknown): LintData {
  if (data === null || typeof data !== "object") {
    throw new Error("lint structured data must be an object.");
  }
  const record = data as Record<string, unknown>;
  if (record.status !== "pass" && record.status !== "fail") {
    throw new Error("lint structured data status must be 'pass' or 'fail'.");
  }
  const checkedRec = record.checked !== null && typeof record.checked === "object"
    ? record.checked as Record<string, unknown>
    : {};
  const countsRec = record.counts !== null && typeof record.counts === "object"
    ? record.counts as Record<string, unknown>
    : {};
  const issueArr = Array.isArray(record.issues) ? record.issues : [];
  const issues: LintIssueData[] = issueArr.map((issue: unknown) => {
    const i = (issue !== null && typeof issue === "object" ? issue : {}) as Record<string, unknown>;
    const refs = Array.isArray(i.sourceRefs) ? i.sourceRefs : [];
    return Object.freeze({
      severity: (i.severity as LintSeverity) ?? "info",
      code: typeof i.code === "string" ? i.code : "",
      message: typeof i.message === "string" ? i.message : "",
      sourceRefs: Object.freeze(refs.map((r: unknown) => {
        const ref = (r !== null && typeof r === "object" ? r : {}) as Record<string, unknown>;
        return Object.freeze({
          path: typeof ref.path === "string" ? ref.path : "",
          commit: typeof ref.commit === "string" ? ref.commit : "",
        });
      })),
    });
  });
  return Object.freeze({
    status: record.status,
    failOn: typeof record.failOn === "string" ? record.failOn : "error",
    checked: Object.freeze({ markdownFiles: Number(checkedRec.markdownFiles ?? 0) }),
    counts: Object.freeze({
      total: Number(countsRec.total ?? 0),
      info: Number(countsRec.info ?? 0),
      warning: Number(countsRec.warning ?? 0),
      error: Number(countsRec.error ?? 0),
      block: Number(countsRec.block ?? 0),
    }),
    shownIssues: typeof record.shownIssues === "number" ? record.shownIssues : issues.length,
    omittedIssues: typeof record.omittedIssues === "number" ? record.omittedIssues : 0,
    issues: Object.freeze(issues),
  });
}

export function renderLintText(data: LintData, vaultPath: string): string {
  const caps = resolveCaps();

  const headStatus: Status = data.status === "pass"
    ? { tone: "ok", label: "pass" }
    : { tone: "err", label: "fail" };

  const lines: string[] = [
    headline({ cmd: "lint", context: basename(vaultPath) }, headStatus, caps),
  ];

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

  // Local copy — not imported from health-finding-view — because lint treats
  // `block` and `error` as distinct severities (0 vs 1), whereas the health
  // bridge collapses both to 0 so check/doctor sort them as peers.
  const SEVERITY_ORDER: Record<LintSeverity, number> = {
    block: 0,
    error: 1,
    warning: 2,
    info: 3,
  };
  const sortedIssues = data.issues.slice().sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const issueLines: string[] = [];
  for (let i = 0; i < sortedIssues.length; i++) {
    const issue = sortedIssues[i]!;
    if (i > 0) issueLines.push("");
    const subject = issue.sourceRefs.length > 0 ? issue.sourceRefs[0]!.path : issue.code;
    issueLines.push(
      ...finding(
        {
          severity: issue.severity,
          code: issue.code,
          subject,
          what: issue.message,
        },
        caps,
      ),
    );
  }
  if (data.omittedIssues > 0) {
    const noun = data.omittedIssues === 1 ? "issue" : "issues";
    // Leading 2 spaces: section() will add another 2, landing the line at column 4
    // alongside the rest of the finding body.
    issueLines.push(
      `  ... ${data.omittedIssues} more ${noun} (use --limit ${data.counts.total} to show all)`,
    );
  }
  // When there are no issues, use bullets() for the dim "none" empty state.
  // When issues exist, pass finding lines directly to section() (they already carry their own indent).
  if (issueLines.length === 0) {
    lines.push(...section("Issues", bullets([], caps), caps));
  } else {
    lines.push(...section("Issues", issueLines, caps));
  }

  const footerStatus: Status = data.status === "pass"
    ? { tone: "ok", label: "pass" }
    : { tone: "err", label: "fail" };
  lines.push(...footer(footerStatus, caps));

  return lines.join("\n");
}
