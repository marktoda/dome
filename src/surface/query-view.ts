// surface/query-view: the `dome.search.query/v1` View Contract (tier 1).
//
// The single zod schema for the query payload. The producer
// (assets/extensions/dome.search/processors/query.ts) imports the erased
// `QueryResultData` type and constructs its ViewEffect data to it; every
// consumer validates received payloads through `queryPayloadSchema` (bound on
// the catalog entry). The schema reproduces the projection the old hand-rolled
// `parseQueryResult` performed: zod's default strip-mode drops unknown keys
// (facts → `{predicate}`, diagnostics → `{code}`), and `.catch()` supplies the
// same defaults (`stringOrEmpty` → "", `numberValue` → null). Rendering (tier
// 3) stays in the CLI (`cli/commands/query.ts`); query carries no view-model —
// the producer (related.ts `questionItemFromProjection`) already emits
// `resolveCommand`/`automationPolicy`, so the old consumer-side fallback was
// dead code.
//
// No silent cap: the old parser also *dropped* facts/diagnostics/questions
// /sourceRefs with empty keys and collapsed an empty `ranking` object to null.
// Those are defensive paths the producer never exercises (it emits non-empty
// keys and full ranking objects); the schema keeps the entries instead of
// dropping them. No real or tested payload hits the difference.

import { z } from "zod";

const querySourceRefSchema = z.object({
  path: z.string().catch(""),
  commit: z.string().catch(""),
  range: z
    .object({ startLine: z.number(), endLine: z.number() })
    .optional()
    .catch(undefined),
});

const queryRankingSignalSchema = z.object({
  kind: z.string().catch(""),
  label: z.string().catch(""),
  weight: z.number().catch(0),
  count: z.number().optional().catch(undefined),
});

const queryRankingSchema = z
  .object({
    score: z.number().catch(0),
    ftsRank: z.number().catch(0),
    reasons: z.array(z.string()).catch([]),
    signals: z.array(queryRankingSignalSchema).catch([]),
  })
  .nullable()
  .catch(null);

const queryQuestionMetadataSchema = z
  .object({
    risk: z.enum(["low", "medium", "high"]).optional(),
    confidence: z.number().optional(),
    recommendedAnswer: z.string().optional(),
    automationPolicy: z
      .enum(["agent-safe", "model-safe", "owner-needed"])
      .optional(),
    ownerNeededReason: z.string().optional(),
  })
  .nullable()
  .catch(null);

const queryQuestionSchema = z.object({
  id: z.number().catch(0),
  question: z.string().catch(""),
  options: z.array(z.string()).catch([]),
  resolveCommand: z.string().catch(""),
  metadata: queryQuestionMetadataSchema,
  automationPolicy: z.string().catch(""),
  sourceRefs: z.array(querySourceRefSchema).catch([]),
});

const queryMatchSchema = z.object({
  path: z.string().catch(""),
  title: z.string().catch(""),
  breadcrumb: z.string().min(1).nullable().catch(null),
  snippet: z.string().catch(""),
  ranking: queryRankingSchema,
  sourceRefs: z.array(querySourceRefSchema).catch([]),
  facts: z.array(z.object({ predicate: z.string().catch("") })).catch([]),
  diagnostics: z.array(z.object({ code: z.string().catch("") })).catch([]),
  questions: z.array(queryQuestionSchema).catch([]),
});

export const queryPayloadSchema = z.object({
  query: z.string(),
  limit: z.number().nullable().catch(null),
  shown: z.object({ matches: z.number().catch(0) }).catch({ matches: 0 }),
  hasMore: z
    .object({ matches: z.boolean().catch(false) })
    .catch({ matches: false }),
  matches: z.array(queryMatchSchema).catch([]),
});

export type QueryResultData = z.infer<typeof queryPayloadSchema>;
export type QuerySourceRef = z.infer<typeof querySourceRefSchema>;
