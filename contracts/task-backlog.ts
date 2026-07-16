// Browser-safe TaskBacklog.list wire contract. Derivation, grouping, hashing,
// and cursor mechanics remain in src/surface/task-backlog.ts.

import { z } from "zod";

export const TASK_BACKLOG_LIST_SCHEMA = "dome.daily.task-backlog.list/v1";

const sourceRefSchema = z.object({
  path: z.string(),
  commit: z.string().min(1),
  stableId: z.string().min(1),
  range: z.object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  }).refine((range) => range.endLine >= range.startLine, {
    message: "endLine must be greater than or equal to startLine",
    path: ["endLine"],
  }),
});

const memberSchema = z.object({
  id: z.string(),
  path: z.string(),
  line: z.number().int().positive().nullable(),
  source: z.enum(["daily", "backlog"]),
  followup: z.boolean(),
  dueDate: z.string().nullable(),
  priority: z.enum(["highest", "high", "medium", "low", "lowest"]).nullable(),
  lastChangedAt: z.string().nullable(),
  blockId: z.string().optional(),
  origin: z.string().optional(),
  reviewable: z.boolean(),
  sourceContext: z.object({
    path: z.string(),
    title: z.string().nullable(),
    line: z.number().int().positive().nullable(),
    lastChangedAt: z.string().nullable(),
  }),
  sourceRefs: z.array(sourceRefSchema).min(1).readonly(),
});

const unitSchema = z.object({
  id: z.string(),
  text: z.string(),
  normalizedText: z.string(),
  classification: z.object({
    timing: z.enum(["overdue", "dated", "undated"]),
    exactDuplicateCandidate: z.boolean(),
  }),
  reviewable: z.boolean(),
  members: z.array(memberSchema).min(1).readonly(),
});

const okSchema = z.object({
  schema: z.literal(TASK_BACKLOG_LIST_SCHEMA),
  status: z.literal("ok"),
  date: z.string(),
  revision: z.string(),
  snapshot: z.string(),
  groups: z.object({
    overdue: z.number().int().nonnegative(),
    dated: z.number().int().nonnegative(),
    exactDuplicateCandidates: z.number().int().nonnegative(),
    undated: z.number().int().nonnegative(),
  }),
  page: z.object({
    limit: z.number().int().positive(),
    returned: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    commitments: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
  items: z.array(unitSchema).readonly(),
});

const problemSchema = z.object({
  schema: z.literal(TASK_BACKLOG_LIST_SCHEMA),
  status: z.literal("error"),
  error: z.enum(["invalid-cursor", "stale-cursor"]),
  message: z.string(),
});

export const taskBacklogListSchema = z.discriminatedUnion("status", [
  okSchema,
  problemSchema,
]);

export type TaskBacklogListDocument = z.infer<typeof taskBacklogListSchema>;
export type TaskBacklogListOk = z.infer<typeof okSchema>;
export type TaskBacklogUnit = z.infer<typeof unitSchema>;
