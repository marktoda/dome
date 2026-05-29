// dome.lint.report — adopted-state lint report.

import {
  viewEffect,
  type DiagnosticEffect,
  type Effect,
  type ViewEffect,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";

const SCHEMA = "dome.lint.report/v1";
const DEFAULT_FAIL_ON: LintSeverityThreshold = "error";

const SEVERITY_ORDER = Object.freeze({
  info: 0,
  warning: 1,
  error: 2,
  block: 3,
} satisfies Record<LintSeverity, number>);

const report: Processor = defineProcessor({
  id: "dome.lint.report",
  version: "0.1.0",
  phase: "view",
  triggers: [{ kind: "command", name: "lint" }],
  capabilities: [{ kind: "read", paths: ["**/*.md"] }],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    if (ctx.projection === undefined) {
      throw new Error(
        "dome.lint.report: ctx.projection is undefined; view-phase processors require a ProjectionQueryView",
      );
    }

    const input = parseInput(ctx.input);
    const markdownFiles = await ctx.snapshot.listMarkdownFiles();
    const diagnostics = ctx.projection.diagnostics();
    const emptyFiles = await emptyMarkdownFiles(ctx, markdownFiles);
    const issues = Object.freeze([
      ...diagnostics.map(issueFromDiagnostic),
      ...emptyFiles,
    ].sort(compareIssues));
    const counts = severityCounts(issues);
    const failed = failsThreshold(counts, input.failOn);
    const data = Object.freeze({
      schema: SCHEMA,
      status: failed ? "fail" as const : "pass" as const,
      failOn: input.failOn,
      checked: Object.freeze({
        markdownFiles: markdownFiles.length,
      }),
      counts,
      issues,
      markdown: renderMarkdown({
        status: failed ? "fail" : "pass",
        failOn: input.failOn,
        markdownFiles: markdownFiles.length,
        counts,
        issues,
      }),
    });

    const effect: ViewEffect = viewEffect({
      name: "dome.lint.report",
      content: {
        kind: "structured",
        schema: SCHEMA,
        data,
      },
      scope: uniqueSourceRefs(issues.flatMap((issue) => issue.sourceRefs)),
    });
    return [effect];
  },
});

export default report;

type LintInput = {
  readonly failOn: LintSeverityThreshold;
};

type LintSeverity = DiagnosticEffect["severity"];

type LintSeverityThreshold = LintSeverity | "never";

type LintIssue = {
  readonly severity: LintSeverity;
  readonly code: string;
  readonly message: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

type LintCounts = {
  readonly total: number;
  readonly info: number;
  readonly warning: number;
  readonly error: number;
  readonly block: number;
};

function parseInput(input: unknown): LintInput {
  const envelope = input !== null && typeof input === "object"
    ? input as Record<string, unknown>
    : {};
  const record = envelope.commandArgs !== null &&
    typeof envelope.commandArgs === "object"
    ? envelope.commandArgs as Record<string, unknown>
    : envelope;
  const flags = record.flags !== null && typeof record.flags === "object"
    ? record.flags as Record<string, unknown>
    : {};
  const raw = stringValue(record.failOn) ?? stringValue(flags.failOn);
  const failOn = parseThreshold(raw) ?? DEFAULT_FAIL_ON;
  return Object.freeze({ failOn });
}

async function emptyMarkdownFiles(
  ctx: ProcessorContext,
  markdownFiles: ReadonlyArray<string>,
): Promise<ReadonlyArray<LintIssue>> {
  const issues: LintIssue[] = [];
  for (const path of markdownFiles) {
    const content = await ctx.snapshot.readFile(path);
    if (content === null || content.trim().length > 0) continue;
    issues.push(Object.freeze({
      severity: "warning" as const,
      code: "dome.lint.empty-markdown-file",
      message: "Markdown file is empty.",
      sourceRefs: Object.freeze([ctx.sourceRef(path)]),
    }));
  }
  return Object.freeze(issues);
}

function issueFromDiagnostic(diagnostic: DiagnosticEffect): LintIssue {
  return Object.freeze({
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message,
    sourceRefs: Object.freeze([...diagnostic.sourceRefs]),
  });
}

function severityCounts(issues: ReadonlyArray<LintIssue>): LintCounts {
  const counts = {
    total: issues.length,
    info: 0,
    warning: 0,
    error: 0,
    block: 0,
  };
  for (const issue of issues) counts[issue.severity] += 1;
  return Object.freeze(counts);
}

function failsThreshold(
  counts: LintCounts,
  failOn: LintSeverityThreshold,
): boolean {
  if (failOn === "never") return false;
  const threshold = SEVERITY_ORDER[failOn];
  return (Object.keys(SEVERITY_ORDER) as LintSeverity[]).some(
    (severity) => SEVERITY_ORDER[severity] >= threshold && counts[severity] > 0,
  );
}

function renderMarkdown(input: {
  readonly status: "pass" | "fail";
  readonly failOn: LintSeverityThreshold;
  readonly markdownFiles: number;
  readonly counts: LintCounts;
  readonly issues: ReadonlyArray<LintIssue>;
}): string {
  const lines = [
    "DOME lint",
    `status   ${input.status} | fail-on ${input.failOn}`,
    `checked  ${input.markdownFiles} markdown files`,
    `issues   ${input.counts.total} total | ${input.counts.block} block | ${input.counts.error} error | ${input.counts.warning} warning | ${input.counts.info} info`,
  ];

  lines.push("");
  lines.push("Issues");
  if (input.issues.length === 0) {
    lines.push("  none");
    return lines.join("\n");
  }

  for (const issue of input.issues) {
    lines.push(`  - [${issue.severity}] ${issue.code}: ${issue.message}`);
    for (const ref of issue.sourceRefs) {
      lines.push(`    ${formatSourceRef(ref)}`);
    }
  }

  return lines.join("\n");
}

function compareIssues(a: LintIssue, b: LintIssue): number {
  const severity = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
  if (severity !== 0) return severity;
  const code = a.code.localeCompare(b.code);
  if (code !== 0) return code;
  return sourceLabel(a).localeCompare(sourceLabel(b));
}

function sourceLabel(issue: LintIssue): string {
  return issue.sourceRefs[0]?.path ?? "";
}

function formatSourceRef(ref: SourceRef): string {
  const suffix = ref.range === undefined
    ? ""
    : `:${ref.range.startLine}-${ref.range.endLine}`;
  return `${ref.path}${suffix} @ ${ref.commit.slice(0, 7)}`;
}

function uniqueSourceRefs(
  refs: ReadonlyArray<SourceRef>,
): ReadonlyArray<SourceRef> {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const ref of refs) {
    const key = [
      ref.commit,
      ref.path,
      ref.range?.startLine ?? "",
      ref.range?.endLine ?? "",
      ref.stableId ?? "",
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return Object.freeze(out);
}

function parseThreshold(value: string | null): LintSeverityThreshold | null {
  if (
    value === "info" ||
    value === "warning" ||
    value === "error" ||
    value === "block" ||
    value === "never"
  ) {
    return value;
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
