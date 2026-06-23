// surface/lint-view: the `dome.lint.report/v1` View Contract (tier 1).
//
// The single zod schema for the lint payload. The producer
// (assets/extensions/dome.lint/processors/report.ts) imports the erased
// `LintData` type and constructs its ViewEffect data to it; every consumer
// validates received payloads through `lintPayloadSchema` (bound on the
// catalog entry). Leniency that the old hand-rolled `parseLintData` applied —
// missing counts default to 0, missing `failOn` defaults to "error" — is
// encoded into the schema via `.catch()`. Rendering (tier 3) stays in the CLI
// (`cli/commands/lint.ts`); lint carries no view-model (tier 2).

import { z } from "zod";

const lintSeveritySchema = z.enum(["info", "warning", "error", "block"]);

const lintSourceRefSchema = z.object({
  path: z.string().catch(""),
  commit: z.string().catch(""),
});

const lintIssueSchema = z.object({
  severity: lintSeveritySchema.catch("info"),
  code: z.string().catch(""),
  message: z.string().catch(""),
  sourceRefs: z.array(lintSourceRefSchema).catch([]),
});

export const lintPayloadSchema = z.object({
  status: z.enum(["pass", "fail"]),
  failOn: z.string().catch("error"),
  checked: z
    .object({ markdownFiles: z.number().catch(0) })
    .catch({ markdownFiles: 0 }),
  counts: z
    .object({
      total: z.number().catch(0),
      info: z.number().catch(0),
      warning: z.number().catch(0),
      error: z.number().catch(0),
      block: z.number().catch(0),
    })
    .catch({ total: 0, info: 0, warning: 0, error: 0, block: 0 }),
  // The producer always emits these; `.catch` keeps a malformed value from
  // failing the whole parse (the old parser's `issues.length` fallback was
  // dead code — the producer never omits `shownIssues`).
  shownIssues: z.number().catch(0),
  omittedIssues: z.number().catch(0),
  issues: z.array(lintIssueSchema).catch([]),
});

export type LintSeverity = z.infer<typeof lintSeveritySchema>;
export type LintIssueData = z.infer<typeof lintIssueSchema>;
export type LintData = z.infer<typeof lintPayloadSchema>;
