// surface/task-backlog: the protocol-neutral TaskBacklog.list read document.
//
// The dome.daily processor supplies individual projection-backed task origins.
// This module groups exact normalized visible text across the complete set,
// classifies review units, and applies revision-bound keyset pagination. It
// never performs fuzzy matching and never decides or mutates task state.

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { z } from "zod";

import { stripWikilinks } from "../core/wikilink";
import type { TodayTaskRow } from "./today-view";

export const TASK_BACKLOG_LIST_SCHEMA = "dome.daily.task-backlog.list/v1";
export const DEFAULT_TASK_BACKLOG_PAGE_SIZE = 25;
export const MAX_TASK_BACKLOG_PAGE_SIZE = 100;

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

export type TaskBacklogOriginRef = {
  readonly path: string;
  readonly commit: string;
  readonly stableId: string;
  readonly range: {
    readonly startLine: number;
    readonly endLine: number;
  };
};

export type TaskBacklogTaskInput = TodayTaskRow & {
  readonly source: "daily" | "backlog";
  readonly followup: boolean;
  readonly dueDate: string | null;
  readonly priority: TodayTaskRow["priority"];
  readonly lastChangedAt: string | null;
  readonly sourceRefs: ReadonlyArray<TaskBacklogOriginRef>;
  readonly sourceTitle: string | null;
};

type CursorPayload = {
  readonly v: 1;
  readonly date: string;
  readonly revision: string;
  readonly snapshot: string;
  readonly after: string;
};

export function buildTaskBacklogList(input: {
  readonly date: string;
  readonly revision: string;
  readonly tasks: ReadonlyArray<TaskBacklogTaskInput>;
  readonly limit?: number;
  readonly cursor?: string | null;
}): TaskBacklogListDocument {
  const units = groupExactTasks(input.tasks, input.date);
  const snapshot = snapshotOf(units);
  const cursor = decodeCursor(input.cursor ?? null);
  if (cursor.kind === "invalid") {
    return problem("invalid-cursor", "The backlog cursor is malformed; restart from the first page.");
  }
  if (
    cursor.value !== null &&
    (cursor.value.date !== input.date ||
      cursor.value.revision !== input.revision ||
      cursor.value.snapshot !== snapshot)
  ) {
    return problem("stale-cursor", "The adopted open-task list changed; restart backlog review from the first page.");
  }
  const start = cursor.value === null
    ? 0
    : units.findIndex((unit) => unit.id === cursor.value?.after) + 1;
  if (cursor.value !== null && start === 0) {
    return problem("invalid-cursor", "The backlog cursor does not name a review unit; restart from the first page.");
  }
  const limit = boundedPageSize(input.limit);
  const items = Object.freeze(units.slice(start, start + limit));
  const hasMore = start + items.length < units.length;
  const last = items.at(-1);

  return Object.freeze({
    schema: TASK_BACKLOG_LIST_SCHEMA,
    status: "ok",
    date: input.date,
    revision: input.revision,
    snapshot,
    groups: Object.freeze({
      overdue: units.filter((unit) => unit.classification.timing === "overdue").length,
      dated: units.filter((unit) => unit.classification.timing === "dated").length,
      exactDuplicateCandidates: units.filter(
        (unit) => unit.classification.exactDuplicateCandidate,
      ).length,
      undated: units.filter((unit) => unit.classification.timing === "undated").length,
    }),
    page: Object.freeze({
      limit,
      returned: items.length,
      total: units.length,
      commitments: input.tasks.length,
      hasMore,
      nextCursor: hasMore && last !== undefined
        ? encodeCursor({
            v: 1,
            date: input.date,
            revision: input.revision,
            snapshot,
            after: last.id,
          })
        : null,
    }),
    items,
  });
}

function groupExactTasks(
  tasks: ReadonlyArray<TaskBacklogTaskInput>,
  date: string,
): ReadonlyArray<TaskBacklogUnit> {
  const duplicateBlockIds = duplicateBlockIdsAcross(tasks);
  const grouped = new Map<string, TaskBacklogTaskInput[]>();
  for (const task of tasks) {
    const key = normalizeTaskText(task.text);
    const existing = grouped.get(key);
    if (existing === undefined) grouped.set(key, [task]);
    else existing.push(task);
  }
  return Object.freeze([...grouped.entries()].map(([normalizedText, members]) => {
    const rows = Object.freeze(members.map((task) =>
      member(task, duplicateBlockIds)
    ));
    const timing = timingOf(members, date);
    return Object.freeze({
      id: `dome.task-backlog.unit:${hash(JSON.stringify([
        normalizedText,
        rows.map((row) => row.id),
      ])).slice(0, 24)}`,
      text: members[0]?.text ?? normalizedText,
      normalizedText,
      classification: Object.freeze({
        timing,
        exactDuplicateCandidate: rows.length > 1,
      }),
      reviewable: rows.every((row) => row.reviewable),
      members: rows,
    });
  }));
}

function member(
  task: TaskBacklogTaskInput,
  duplicateBlockIds: ReadonlySet<string>,
) {
  const blockId = task.blockId;
  const duplicateBlockId = blockId !== undefined && duplicateBlockIds.has(blockId);
  return Object.freeze({
    id: taskIdentity(task, duplicateBlockId),
    path: task.path,
    line: task.line,
    source: task.source,
    followup: task.followup,
    dueDate: task.dueDate,
    priority: task.priority ?? null,
    lastChangedAt: task.lastChangedAt,
    ...(blockId !== undefined ? { blockId } : {}),
    ...(task.origin !== undefined ? { origin: task.origin } : {}),
    reviewable: blockId !== undefined && !duplicateBlockId,
    sourceContext: Object.freeze({
      path: task.path,
      title: task.sourceTitle,
      line: task.line,
      lastChangedAt: task.lastChangedAt,
    }),
    sourceRefs: Object.freeze([...task.sourceRefs]),
  });
}

function taskIdentity(
  task: TaskBacklogTaskInput,
  duplicateBlockId: boolean,
): string {
  if (task.blockId !== undefined && !duplicateBlockId) {
    return `dome.task:${task.blockId}`;
  }
  const ref = task.sourceRefs[0];
  const kind = task.blockId === undefined ? "transient" : "duplicate-anchor";
  return `dome.task.${kind}:${hash(JSON.stringify([
    task.path,
    ref?.range.startLine ?? task.line,
    task.blockId ?? null,
    normalizeTaskText(task.text),
  ])).slice(0, 24)}`;
}

function duplicateBlockIdsAcross(
  tasks: ReadonlyArray<TaskBacklogTaskInput>,
): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (task.blockId === undefined) continue;
    counts.set(task.blockId, (counts.get(task.blockId) ?? 0) + 1);
  }
  return new Set(
    [...counts.entries()].flatMap(([blockId, count]) => count > 1 ? [blockId] : []),
  );
}

function timingOf(
  tasks: ReadonlyArray<TaskBacklogTaskInput>,
  date: string,
): "overdue" | "dated" | "undated" {
  if (tasks.some((task) => task.dueDate !== null && task.dueDate < date)) return "overdue";
  if (tasks.some((task) => task.dueDate !== null)) return "dated";
  return "undated";
}

function normalizeTaskText(text: string): string {
  return stripWikilinks(text).trim().replace(/\s+/g, " ").toLowerCase();
}

function boundedPageSize(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) {
    return DEFAULT_TASK_BACKLOG_PAGE_SIZE;
  }
  return Math.min(value, MAX_TASK_BACKLOG_PAGE_SIZE);
}

function snapshotOf(units: ReadonlyArray<TaskBacklogUnit>): string {
  return hash(JSON.stringify(units));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function encodeCursor(value: CursorPayload): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(raw: string | null):
  | { readonly kind: "ok"; readonly value: CursorPayload | null }
  | { readonly kind: "invalid" } {
  if (raw === null || raw.length === 0) return { kind: "ok", value: null };
  if (raw.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(raw)) return { kind: "invalid" };
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    return isCursorPayload(value)
      ? { kind: "ok", value }
      : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 5 &&
    record.v === 1 &&
    typeof record.date === "string" &&
    typeof record.revision === "string" &&
    typeof record.snapshot === "string" && /^[0-9a-f]{64}$/.test(record.snapshot) &&
    typeof record.after === "string" && record.after.length > 0;
}

function problem(
  error: "invalid-cursor" | "stale-cursor",
  message: string,
): TaskBacklogListDocument {
  return Object.freeze({
    schema: TASK_BACKLOG_LIST_SCHEMA,
    status: "error",
    error,
    message,
  });
}
