// Browser-safe keep/defer/close batch contract shared by Home and the PWA.

import { z } from "zod";

export const TASK_BACKLOG_REVIEW_SCHEMA = "dome.task-backlog.review/v1";

const sourceRefSchema = z.object({
  path: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  stableId: z.string().min(1),
  range: z.object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  }).strict().refine((range) => range.endLine >= range.startLine, {
    path: ["endLine"],
    message: "endLine must be greater than or equal to startLine",
  }),
}).strict();

const decisionBase = {
  blockId: z.string().min(1).max(200),
  sourceRef: sourceRefSchema,
};

export const taskBacklogReviewRequestSchema = z.object({
  schema: z.literal(TASK_BACKLOG_REVIEW_SCHEMA),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  decisions: z.array(z.discriminatedUnion("disposition", [
    z.object({ ...decisionBase, disposition: z.literal("keep") }).strict(),
    z.object({ ...decisionBase, disposition: z.literal("close") }).strict(),
    z.object({
      ...decisionBase,
      disposition: z.literal("defer"),
      deferUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).strict(),
  ])).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const [index, decision] of value.decisions.entries()) {
    if (seen.has(decision.blockId)) {
      ctx.addIssue({
        code: "custom",
        path: ["decisions", index, "blockId"],
        message: `duplicate or conflicting disposition for ^${decision.blockId}`,
      });
    }
    seen.add(decision.blockId);
  }
});

export type TaskBacklogReviewRequest = z.infer<typeof taskBacklogReviewRequestSchema>;

export const taskBacklogReviewResultSchema = z.discriminatedUnion("status", [
  z.object({
    schema: z.literal(TASK_BACKLOG_REVIEW_SCHEMA),
    status: z.literal("settled"),
    revision: z.string().regex(/^[0-9a-f]{40}$/),
    reviewed: z.object({
      keep: z.number().int().nonnegative(),
      close: z.number().int().nonnegative(),
      defer: z.number().int().nonnegative(),
    }).strict(),
    commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
    adoptionStatus: z.enum(["unchanged", "pending"]),
  }).strict(),
  z.object({
    schema: z.literal(TASK_BACKLOG_REVIEW_SCHEMA),
    status: z.literal("error"),
    error: z.enum(["invalid-request", "stale-review", "conflict", "busy", "outcome-unknown"]),
    message: z.string(),
    retryable: z.boolean(),
    recoveryRequired: z.boolean(),
  }).strict(),
]);

export type TaskBacklogReviewResult = z.infer<typeof taskBacklogReviewResultSchema>;
