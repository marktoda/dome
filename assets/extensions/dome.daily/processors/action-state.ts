// Shared source-backed daily action state for dome.daily view processors.

import type {
  FactEffect,
  QuestionMetadata,
  QuestionEffect,
} from "../../../../src/core/effect";
import type { ProcessorContext } from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";
import {
  questionAutomationPolicy,
  resolveQuestionCommand,
} from "../../../../src/question-resolution";

import {
  attentionAdjustedRecencyMs,
  collectAttentionDiscounts,
  type AttentionDiscount,
} from "./attention-shared";
import {
  dailyPathSettings,
  dailyPath,
  formatDate,
  isValidDailyDate,
  localDateParts,
  openLoopIdentity,
  openSourceBackedOpenLoopsFromMarkdown,
  openLoopSurfaceKey,
  parseDailyPath,
  type DailyDate,
  type DailyOpenLoopSource,
  type DailyPathSettings,
} from "./daily-shared";

import { compareStrings } from "../../../../src/core/compare";

export const OPEN_TASK_PREDICATE = "dome.daily.open_task";
export const FOLLOWUP_PREDICATE = "dome.daily.followup";

export type DailyActionState = {
  readonly date: string;
  readonly daily: {
    readonly path: string;
    readonly exists: boolean;
    readonly sourceRefs: ReadonlyArray<SourceRef>;
  };
  readonly counts: {
    readonly openTasks: number;
    readonly followups: number;
    readonly questions: number;
  };
  readonly sourceCounts: DailyActionSourceCounts;
  readonly dueCounts: DailyActionDueCounts;
  readonly openTasks: ReadonlyArray<DailyTaskItem>;
  readonly followups: ReadonlyArray<DailyTaskItem>;
  readonly questions: ReadonlyArray<DailyQuestionItem>;
  readonly scope: ReadonlyArray<SourceRef>;
};

export type DailyActionSource = "daily" | "backlog";

export type DailyActionCounts = {
  readonly openTasks: number;
  readonly followups: number;
  readonly questions: number;
};

export type DailyActionSourceCounts = {
  readonly daily: DailyActionCounts;
  readonly backlog: DailyActionCounts;
};

export type DailyDueCounts = {
  readonly overdue: number;
  readonly today: number;
  readonly upcoming: number;
  readonly undated: number;
};

export type DailyActionDueCounts = {
  readonly openTasks: DailyDueCounts;
  readonly followups: DailyDueCounts;
};

export type DailyTaskItem = {
  readonly text: string;
  readonly path: string;
  readonly line: number | null;
  readonly source: DailyActionSource;
  readonly followup: boolean;
  readonly dueDate: string | null;
  readonly priority: DailyTaskPriority | null;
  readonly lastChangedAt: string | null;
  /**
   * Explainable attention-discount note (task-lifecycle §"Attention
   * discounting"): present when the item carries a dome.attention.discount
   * derivation, `null` otherwise. Ranking demotes by `(1 − discount)`
   * multiplicatively; it never drops the item.
   */
  readonly attention: DailyTaskAttention | null;
  readonly evidenceLabel: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

export type DailyTaskAttention = {
  readonly discount: number;
  readonly impressions: number;
  readonly lastShown: string;
};

export type DailyTaskPriority =
  | "highest"
  | "high"
  | "medium"
  | "low"
  | "lowest";

export type DailyQuestionItem = {
  readonly id: number;
  readonly question: string;
  readonly options: ReadonlyArray<string>;
  readonly resolveCommand: string;
  readonly metadata: QuestionMetadata | null;
  readonly automationPolicy: string;
  readonly path: string;
  readonly line: number | null;
  readonly source: DailyActionSource;
  readonly lastChangedAt: string | null;
  readonly evidenceLabel: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

export async function collectDailyActionState(
  ctx: ProcessorContext,
  date: DailyDate,
): Promise<DailyActionState> {
  if (ctx.projection === undefined) {
    throw new Error(
      "dome.daily: ctx.projection is undefined; view-phase processors require a ProjectionQueryView",
    );
  }

  const dateString = formatDate(date);
  const settings = dailyPathSettings(ctx.extensionConfig);
  const path = dailyPath(date, settings);
  const dailyContent = await ctx.snapshot.readFile(path);
  const dailySourceRefs =
    dailyContent === null ? [] : [ctx.sourceRef(path)];
  const dailyOpenLoopItems = dailyContent === null
    ? []
    : openSourceBackedOpenLoopsFromMarkdown({
      path,
      content: dailyContent,
    });

  // Attention discounting: derived from the snapshot (same deterministic
  // inputs the dome.daily.attention-discount facts record), so the view
  // agrees with the markdown it reads regardless of projection freshness.
  const attentionDiscounts = await collectAttentionDiscounts({
    snapshot: ctx.snapshot,
    settings,
  });

  const openFacts = uniqueFactsByKey(ctx.projection.facts({
    predicate: OPEN_TASK_PREDICATE,
  }));
  const followupFacts = uniqueFactsByKey(ctx.projection.facts({
    predicate: FOLLOWUP_PREDICATE,
  }));
  const questionEffects = ctx.projection
    .questions({ resolved: false })
    .filter((question) => question.idempotencyKey.startsWith("dome.daily."));
  const sourceLastChangedAt = await sourceLastChangedAtIndex(ctx, [
    ...(dailyContent === null ? [] : [path]),
    ...openFacts.map(factSourcePath),
    ...followupFacts.map(factSourcePath),
    ...questionEffects.map(questionSourcePath),
  ]);
  const followupKeys = new Set(followupFacts.map(factKey));
  const dailyOpenTaskItems = dailyOpenLoopItems.map((item) =>
    taskItemFromDailySurface({
      ctx,
      dailyPath: path,
      item,
      sourceLastChangedAt,
      attentionDiscounts,
    })
  );
  const openTasks = [
    ...dailyOpenTaskItems,
    ...openFacts.map((fact) =>
      taskItemFromFact({
        fact,
        followup: followupKeys.has(factKey(fact)),
        dailyPath: path,
        sourceLastChangedAt,
        attentionDiscounts,
      })
    ),
  ].sort(compareTaskItemsForDaily(path, settings));
  const followups = [
    ...dailyOpenTaskItems.filter((item) => item.followup),
    ...followupFacts.map((fact) =>
      taskItemFromFact({
        fact,
        followup: true,
        dailyPath: path,
        sourceLastChangedAt,
        attentionDiscounts,
      })
    ),
  ].sort(compareTaskItemsForDaily(path, settings));
  const dedupedOpenTasks = dedupeDailyTaskItems(openTasks);
  const dedupedFollowups = dedupeDailyTaskItems(followups);
  const questions = questionEffects
    .map((question) =>
      questionItemFromEffect({
        question,
        dailyPath: path,
        sourceLastChangedAt,
      })
    )
    .sort(compareQuestionItemsForDaily(path));
  const sourceCounts = countDailyActionSources({
    openTasks: dedupedOpenTasks,
    followups: dedupedFollowups,
    questions,
  });
  const dueCounts = countDailyActionDue({
    date: dateString,
    openTasks: dedupedOpenTasks,
    followups: dedupedFollowups,
  });

  const scope = uniqueSourceRefs([
    ...dailySourceRefs,
    ...dedupedOpenTasks.flatMap((task) => task.sourceRefs),
    ...dedupedFollowups.flatMap((task) => task.sourceRefs),
    ...questions.flatMap((question) => question.sourceRefs),
  ]);

  return Object.freeze({
    date: dateString,
    daily: Object.freeze({
      path,
      exists: dailyContent !== null,
      sourceRefs: Object.freeze(dailySourceRefs),
    }),
    counts: Object.freeze({
      openTasks: dedupedOpenTasks.length,
      followups: dedupedFollowups.length,
      questions: questions.length,
    }),
    sourceCounts,
    dueCounts,
    openTasks: dedupedOpenTasks,
    followups: dedupedFollowups,
    questions: Object.freeze(questions),
    scope,
  });
}

export function parseInputDate(input: unknown): DailyDate | null {
  const { record, flags } = commandArgsRecord(input);
  return parseDateString(stringValue(record.date) ?? stringValue(flags.date));
}

export function inputDateOrLocalToday(input: unknown): DailyDate {
  return parseInputDate(input) ?? localDateParts(new Date());
}

export function parseInputLimit(input: unknown, fallback: number): number {
  const { record, flags } = commandArgsRecord(input);
  const value = record.limit ?? flags.limit;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    return Number(value);
  }
  return fallback;
}

export function parseInputString(
  input: unknown,
  keys: ReadonlyArray<string>,
): string | null {
  const { record, flags } = commandArgsRecord(input);
  for (const key of keys) {
    const value = stringValue(record[key]) ?? stringValue(flags[key]);
    if (value !== null) return value;
  }
  return null;
}

function commandArgsRecord(input: unknown): {
  readonly record: Record<string, unknown>;
  readonly flags: Record<string, unknown>;
} {
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
  return Object.freeze({ record, flags });
}

export function uniqueSourceRefs(
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

export function selectDailyActionRows<T extends { readonly source: DailyActionSource }>(
  items: ReadonlyArray<T>,
  limit: number,
): ReadonlyArray<T> {
  const boundedLimit = Number.isInteger(limit) && limit > 0 ? limit : 0;
  if (boundedLimit === 0) return Object.freeze([]);
  const daily = items
    .filter((item) => item.source === "daily")
    .slice(0, boundedLimit);
  const backlog = items
    .filter((item) => item.source === "backlog")
    .slice(0, boundedLimit);
  return Object.freeze([...daily, ...backlog]);
}

function parseDateString(value: string | null): DailyDate | null {
  if (value === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const [, yyyy, mm, dd] = match;
  if (yyyy === undefined || mm === undefined || dd === undefined) return null;
  const parsed = Object.freeze({ yyyy, mm, dd });
  return isValidDailyDate(parsed) ? parsed : null;
}

function taskItemFromFact(input: {
  readonly fact: FactEffect;
  readonly followup: boolean;
  readonly dailyPath: string;
  readonly sourceLastChangedAt: ReadonlyMap<string, string>;
  readonly attentionDiscounts: ReadonlyMap<string, AttentionDiscount>;
}): DailyTaskItem {
  const { fact } = input;
  const ref = fact.sourceRefs[0];
  const path = factSourcePath(fact);
  const rawText = literalToString(fact.object);
  const metadata = taskMetadata(rawText);
  const line = ref?.range?.startLine ?? null;
  const sourceRefs = Object.freeze([...fact.sourceRefs]);
  return Object.freeze({
    text: taskDisplayText(rawText),
    path,
    line,
    source: sourceForPath(path, input.dailyPath),
    followup: input.followup,
    dueDate: metadata.dueDate,
    priority: metadata.priority,
    lastChangedAt: input.sourceLastChangedAt.get(path) ?? null,
    attention: taskAttention(input.attentionDiscounts, {
      sourcePath: path,
      body: rawText,
    }),
    evidenceLabel: actionEvidenceLabel({ path, line, sourceRefs }),
    sourceRefs,
  });
}

function taskItemFromDailySurface(input: {
  readonly ctx: ProcessorContext;
  readonly dailyPath: string;
  readonly item: DailyOpenLoopSource;
  readonly sourceLastChangedAt: ReadonlyMap<string, string>;
  readonly attentionDiscounts: ReadonlyMap<string, AttentionDiscount>;
}): DailyTaskItem {
  const metadata = taskMetadata(input.item.body);
  const surfaceRef = input.ctx.sourceRef(
    input.dailyPath,
    { startLine: input.item.line, endLine: input.item.line },
    input.item.stableId,
  );
  const sourceRefs = uniqueSourceRefs([
    surfaceRef,
    ...(input.item.sourcePath === input.dailyPath ? [] : [
      input.ctx.sourceRef(input.item.sourcePath, undefined, input.item.stableId),
    ]),
  ]);
  return Object.freeze({
    text: taskDisplayText(input.item.body),
    path: input.dailyPath,
    line: input.item.line,
    source: "daily",
    followup: input.item.followup,
    dueDate: metadata.dueDate,
    priority: metadata.priority,
    lastChangedAt: input.sourceLastChangedAt.get(input.dailyPath) ?? null,
    attention: taskAttention(input.attentionDiscounts, {
      sourcePath: input.item.sourcePath,
      body: input.item.body,
    }),
    evidenceLabel: actionEvidenceLabel({
      path: input.dailyPath,
      line: input.item.line,
      sourceRefs,
    }),
    sourceRefs,
  });
}

function taskAttention(
  discounts: ReadonlyMap<string, AttentionDiscount>,
  item: { readonly sourcePath: string; readonly body: string },
): DailyTaskAttention | null {
  const entry = discounts.get(openLoopIdentity(item));
  if (entry === undefined) return null;
  return Object.freeze({
    discount: entry.discount,
    impressions: entry.impressions,
    lastShown: entry.lastShown,
  });
}

function questionItemFromEffect(input: {
  readonly question: QuestionEffect & { readonly id?: number };
  readonly dailyPath: string;
  readonly sourceLastChangedAt: ReadonlyMap<string, string>;
}): DailyQuestionItem {
  const { question } = input;
  const ref = question.sourceRefs[0];
  const id = typeof question.id === "number" && Number.isFinite(question.id)
    ? question.id
    : 0;
  const options = Object.freeze([...(question.options ?? [])]);
  const path = questionSourcePath(question);
  const line = ref?.range?.startLine ?? null;
  const sourceRefs = Object.freeze([...question.sourceRefs]);
  return Object.freeze({
    id,
    question: question.question,
    options,
    resolveCommand: resolveQuestionCommand({ id, options }),
    metadata: question.metadata ?? null,
    automationPolicy: questionAutomationPolicy(question.metadata),
    path,
    line,
    source: sourceForPath(path, input.dailyPath),
    lastChangedAt: input.sourceLastChangedAt.get(path) ?? null,
    evidenceLabel: actionEvidenceLabel({ path, line, sourceRefs }),
    sourceRefs,
  });
}

async function sourceLastChangedAtIndex(
  ctx: ProcessorContext,
  paths: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, string>> {
  const uniquePaths = [...new Set(paths.filter((path) => path.length > 0))];
  const entries = await Promise.all(
    uniquePaths.map(async (path) => {
      const info = await ctx.snapshot.getFileInfo(path);
      // Prefer the human-authored timestamp so an engine rewrite (e.g.
      // ^block-anchor stamping) cannot reset open-loop recency ranking.
      return [path, info?.lastHumanChangedAt ?? info?.lastChangedAt ?? null] as const;
    }),
  );
  return new Map(
    entries.filter(
      (entry): entry is readonly [string, string] => entry[1] !== null,
    ),
  );
}

function countDailyActionSources(input: {
  readonly openTasks: ReadonlyArray<DailyTaskItem>;
  readonly followups: ReadonlyArray<DailyTaskItem>;
  readonly questions: ReadonlyArray<DailyQuestionItem>;
}): DailyActionSourceCounts {
  const daily = countSource(input, "daily");
  const backlog = countSource(input, "backlog");
  return Object.freeze({ daily, backlog });
}

function countSource(
  input: {
    readonly openTasks: ReadonlyArray<DailyTaskItem>;
    readonly followups: ReadonlyArray<DailyTaskItem>;
    readonly questions: ReadonlyArray<DailyQuestionItem>;
  },
  source: DailyActionSource,
): DailyActionCounts {
  return Object.freeze({
    openTasks: input.openTasks.filter((item) => item.source === source).length,
    followups: input.followups.filter((item) => item.source === source).length,
    questions: input.questions.filter((item) => item.source === source).length,
  });
}

function countDailyActionDue(input: {
  readonly date: string;
  readonly openTasks: ReadonlyArray<DailyTaskItem>;
  readonly followups: ReadonlyArray<DailyTaskItem>;
}): DailyActionDueCounts {
  return Object.freeze({
    openTasks: countDue(input.openTasks, input.date),
    followups: countDue(input.followups, input.date),
  });
}

function countDue(
  tasks: ReadonlyArray<DailyTaskItem>,
  date: string,
): DailyDueCounts {
  const counts = {
    overdue: 0,
    today: 0,
    upcoming: 0,
    undated: 0,
  };
  for (const task of tasks) {
    if (task.dueDate === null) {
      counts.undated += 1;
    } else if (task.dueDate < date) {
      counts.overdue += 1;
    } else if (task.dueDate === date) {
      counts.today += 1;
    } else {
      counts.upcoming += 1;
    }
  }
  return Object.freeze(counts);
}

function sourceForPath(path: string, dailyPath: string): DailyActionSource {
  return path === dailyPath ? "daily" : "backlog";
}

function literalToString(value: FactEffect["object"]): string {
  if (value.kind === "string") return value.value;
  if (value.kind === "number") return String(value.value);
  if (value.kind === "date") return value.value;
  if (value.kind === "page") return value.path;
  if (value.kind === "task") return value.stableId;
  return value.name;
}

function subjectPath(fact: FactEffect): string {
  return fact.subject.kind === "page" ? fact.subject.path : "";
}

function factSourcePath(fact: FactEffect): string {
  return fact.sourceRefs[0]?.path ?? subjectPath(fact);
}

function questionSourcePath(
  question: QuestionEffect,
): string {
  return question.sourceRefs[0]?.path ?? "";
}

function factKey(fact: FactEffect): string {
  const ref = fact.sourceRefs[0];
  const object = literalIdentity(fact.object);
  return [
    ref?.path ?? subjectPath(fact),
    ref?.stableId ?? ref?.range?.startLine ?? "",
    object,
  ].join("\u0000");
}

function uniqueFactsByKey(
  facts: ReadonlyArray<FactEffect>,
): ReadonlyArray<FactEffect> {
  const seen = new Set<string>();
  const out: FactEffect[] = [];
  for (const fact of facts) {
    const key = factKey(fact);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
  }
  return Object.freeze(out);
}

function dedupeDailyTaskItems(
  items: ReadonlyArray<DailyTaskItem>,
): ReadonlyArray<DailyTaskItem> {
  const out: DailyTaskItem[] = [];
  const bySurfaceKey = new Map<string, number>();
  for (const item of items) {
    const key = taskSurfaceKey(item);
    const exactIndex = bySurfaceKey.get(key);
    if (exactIndex !== undefined) {
      out[exactIndex] = mergeDailyTaskItems(out[exactIndex]!, item);
      continue;
    }

    const nearIndex = out.findIndex((existing) =>
      taskItemsAreNearDuplicates(existing, item)
    );
    if (nearIndex === -1) {
      bySurfaceKey.set(key, out.length);
      out.push(item);
      continue;
    }
    out[nearIndex] = mergeDailyTaskItems(out[nearIndex]!, item);
    bySurfaceKey.set(key, nearIndex);
  }
  return Object.freeze(out);
}

function mergeDailyTaskItems(
  first: DailyTaskItem,
  second: DailyTaskItem,
): DailyTaskItem {
  const primary = preferredTaskDisplayItem(first, second);
  const duplicate = primary === first ? second : first;
  const sourceRefs = compactSourceRefsByPath([
    ...primary.sourceRefs,
    ...duplicate.sourceRefs,
  ]);
  return Object.freeze({
    ...primary,
    followup: primary.followup || duplicate.followup,
    evidenceLabel: actionEvidenceLabel({
      path: primary.path,
      line: primary.line,
      sourceRefs,
    }),
    sourceRefs,
  });
}

function preferredTaskDisplayItem(
  a: DailyTaskItem,
  b: DailyTaskItem,
): DailyTaskItem {
  const sourceCmp = taskSourceRank(a) - taskSourceRank(b);
  if (sourceCmp !== 0) return sourceCmp < 0 ? a : b;

  const directCmp = taskDirectnessRank(a) - taskDirectnessRank(b);
  if (directCmp !== 0) return directCmp < 0 ? a : b;

  const changedCmp = compareOptionalDateDesc(a.lastChangedAt, b.lastChangedAt);
  if (changedCmp !== 0) return changedCmp < 0 ? a : b;

  return a;
}

function taskSourceRank(item: DailyTaskItem): number {
  return item.source === "daily" ? 0 : 1;
}

function taskDirectnessRank(item: DailyTaskItem): number {
  return item.sourceRefs.some((ref) => ref.path !== item.path) ? 1 : 0;
}

function compactSourceRefsByPath(
  refs: ReadonlyArray<SourceRef>,
): ReadonlyArray<SourceRef> {
  const byPath = new Map<string, SourceRef>();
  for (const ref of uniqueSourceRefs(refs)) {
    const key = ref.path;
    const existing = byPath.get(key);
    if (
      existing === undefined ||
      sourceRefSpecificity(ref) > sourceRefSpecificity(existing)
    ) {
      byPath.set(key, ref);
    }
  }
  return Object.freeze([...byPath.values()]);
}

function sourceRefSpecificity(ref: SourceRef): number {
  return (ref.range === undefined ? 0 : 2) +
    (ref.stableId === undefined ? 0 : 1);
}

function taskSurfaceKey(item: DailyTaskItem): string {
  return [
    openLoopSurfaceKey({ body: item.text }),
    item.dueDate ?? "",
    item.priority ?? "",
  ].join("\u0000");
}

function taskItemsAreNearDuplicates(
  a: DailyTaskItem,
  b: DailyTaskItem,
): boolean {
  const aTokens = significantTaskTokens(a.text);
  const bTokens = significantTaskTokens(b.text);
  if (aTokens.size < 4 || bTokens.size < 4) return false;

  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1;
  }
  if (intersection < 4) return false;

  const smaller = Math.min(aTokens.size, bTokens.size);
  const union = aTokens.size + bTokens.size - intersection;
  return intersection / smaller >= 0.65 && intersection / union >= 0.4;
}

const TASK_TOKEN_STOPWORDS: ReadonlySet<string> = new Set([
  "about",
  "after",
  "and",
  "before",
  "from",
  "into",
  "note",
  "notes",
  "the",
  "this",
  "that",
  "with",
  "wiki",
]);

function significantTaskTokens(text: string): ReadonlySet<string> {
  const visibleText = text
    .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, " $1 ")
    .replace(/\[\[([^\]]+)\]\]/g, (_match, target: string) =>
      ` ${target.split(/[\/#]/).at(-1) ?? target} `
    )
    .replace(
      /(?:^|\s)(?:📅\s*\d{4}-\d{2}-\d{2}|🔺|⏫|🔼|🔽|⏬)(?=\s|$)/gu,
      " ",
    );
  return new Set(
    visibleText
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter((token) =>
        token.length >= 3 && !TASK_TOKEN_STOPWORDS.has(token)
      ),
  );
}

function literalIdentity(value: FactEffect["object"]): string {
  if (value.kind === "page") return `page:${value.path}`;
  if (value.kind === "task") return `task:${value.stableId}`;
  if (value.kind === "entity") return `entity:${value.name}`;
  if (value.kind === "string") return `string:${value.value}`;
  if (value.kind === "number") return `number:${value.value}`;
  return `date:${value.value}`;
}

function compareTaskItems(a: DailyTaskItem, b: DailyTaskItem): number {
  return comparePathLineText(a.path, a.line, a.text, b.path, b.line, b.text);
}

function compareTaskItemsForDaily(
  dailyPath: string,
  settings: DailyPathSettings,
): (a: DailyTaskItem, b: DailyTaskItem) => number {
  const date = dateFromDailyPath(dailyPath, settings);
  return (a, b) => {
    const sourceCmp = pathDailyPriority(a.path, dailyPath) -
      pathDailyPriority(b.path, dailyPath);
    if (sourceCmp !== 0) return sourceCmp;
    if (a.path === dailyPath && b.path === dailyPath) {
      return compareTaskItems(a, b);
    }
    const actionCmp = compareTaskActionPriority(a, b, date);
    return actionCmp === 0 ? compareTaskItems(a, b) : actionCmp;
  };
}

function compareQuestionItems(
  a: DailyQuestionItem,
  b: DailyQuestionItem,
): number {
  return comparePathLineText(
    a.path,
    a.line,
    a.question,
    b.path,
    b.line,
    b.question,
  );
}

function compareQuestionItemsForDaily(
  dailyPath: string,
): (a: DailyQuestionItem, b: DailyQuestionItem) => number {
  return (a, b) => {
    const sourceCmp = pathDailyPriority(a.path, dailyPath) -
      pathDailyPriority(b.path, dailyPath);
    if (sourceCmp !== 0) return sourceCmp;
    const changedCmp = compareOptionalDateDesc(a.lastChangedAt, b.lastChangedAt);
    return changedCmp === 0 ? compareQuestionItems(a, b) : changedCmp;
  };
}

function pathDailyPriority(path: string, dailyPath: string): number {
  return path === dailyPath ? 0 : 1;
}

function compareTaskActionPriority(
  a: DailyTaskItem,
  b: DailyTaskItem,
  date: string | null,
): number {
  const bucketA = taskActionBucket(a, date);
  const bucketB = taskActionBucket(b, date);
  const bucketCmp = bucketA - bucketB;
  if (bucketCmp !== 0) return bucketCmp;

  const priorityCmp = taskPriorityRank(a.priority) - taskPriorityRank(b.priority);
  const changedCmp = compareDiscountedRecencyDesc(a, b);

  if (bucketA === 0) {
    const dueCmp = compareOptionalDateDesc(a.dueDate, b.dueDate);
    if (dueCmp !== 0) return dueCmp;
    if (priorityCmp !== 0) return priorityCmp;
    return changedCmp;
  }

  if (bucketA === 2) {
    const dueCmp = compareOptionalDate(a.dueDate, b.dueDate);
    if (dueCmp !== 0) return dueCmp;
    if (priorityCmp !== 0) return priorityCmp;
    return changedCmp;
  }

  if (priorityCmp !== 0) return priorityCmp;
  return changedCmp;
}

function taskActionBucket(task: DailyTaskItem, date: string | null): number {
  if (
    task.dueDate !== null &&
    (date === null || task.dueDate <= date)
  ) {
    return 0;
  }
  if (task.priority !== null) return 1;
  if (task.dueDate !== null) return 2;
  return 3;
}

/**
 * Recency comparison with attention demotion (task-lifecycle §"Attention
 * discounting"): a discounted item compares as if its last human change were
 * `log(1 − discount)/log(0.995)` hours older — the order-equivalent of
 * multiplying the recency score by `(1 − discount)`. With discount 0 this is
 * exactly the plain `lastChangedAt` descending comparison. Demotion reorders;
 * it never removes an item from the list.
 */
function compareDiscountedRecencyDesc(
  a: DailyTaskItem,
  b: DailyTaskItem,
): number {
  if (a.lastChangedAt === null || b.lastChangedAt === null) {
    return compareOptionalDateDesc(a.lastChangedAt, b.lastChangedAt);
  }
  const aMs = attentionAdjustedRecencyMs({
    lastChangedAt: a.lastChangedAt,
    discount: a.attention?.discount ?? 0,
  });
  const bMs = attentionAdjustedRecencyMs({
    lastChangedAt: b.lastChangedAt,
    discount: b.attention?.discount ?? 0,
  });
  if (aMs === bMs) return 0;
  return bMs > aMs ? 1 : -1;
}

function compareOptionalDate(a: string | null, b: string | null): number {
  if (a !== null && b !== null) return compareStrings(a, b);
  if (a !== null) return -1;
  if (b !== null) return 1;
  return 0;
}

function compareOptionalDateDesc(a: string | null, b: string | null): number {
  if (a !== null && b !== null) return compareStrings(b, a);
  if (a !== null) return -1;
  if (b !== null) return 1;
  return 0;
}

function taskMetadata(text: string): {
  readonly dueDate: string | null;
  readonly priority: DailyTaskPriority | null;
} {
  return Object.freeze({
    dueDate: taskDueDate(text),
    priority: taskPriority(text),
  });
}

function taskDueDate(text: string): string | null {
  return /(?:^|\s)📅\s*(\d{4}-\d{2}-\d{2})(?=\s|$)/u.exec(text)?.[1] ??
    null;
}

function taskPriority(text: string): DailyTaskPriority | null {
  if (text.includes("🔺")) return "highest";
  if (text.includes("⏫")) return "high";
  if (text.includes("🔼")) return "medium";
  if (text.includes("🔽")) return "low";
  if (text.includes("⏬")) return "lowest";
  return null;
}

function taskDisplayText(text: string): string {
  const stripped = text
    .replace(
      /(?:^|\s)(?:📅\s*\d{4}-\d{2}-\d{2}|🔺|⏫|🔼|🔽|⏬)(?=\s|$)/gu,
      " ",
    )
    .replace(/\s{2,}/g, " ")
    .trim();
  return stripped.length > 0 ? stripped : text;
}

function taskPriorityRank(priority: DailyTaskPriority | null): number {
  switch (priority) {
    case "highest":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 4;
    case "lowest":
      return 5;
    case null:
      return 3;
  }
}

function dateFromDailyPath(
  path: string,
  settings: DailyPathSettings,
): string | null {
  const date = parseDailyPath(path, settings);
  return date === null ? null : formatDate(date);
}

function comparePathLineText(
  aPath: string,
  aLine: number | null,
  aText: string,
  bPath: string,
  bLine: number | null,
  bText: string,
): number {
  const pathCmp = compareStrings(aPath, bPath);
  if (pathCmp !== 0) return pathCmp;
  const lineCmp = (aLine ?? Number.MAX_SAFE_INTEGER) -
    (bLine ?? Number.MAX_SAFE_INTEGER);
  if (lineCmp !== 0) return lineCmp;
  return compareStrings(aText, bText);
}

function actionEvidenceLabel(input: {
  readonly path: string;
  readonly line: number | null;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
}): string {
  const surface = locationLabel({
    path: input.path,
    line: input.line,
  });
  const source = input.sourceRefs.find((ref) => ref.path !== input.path);
  if (source === undefined) return surface;
  return `${surface}; source ${sourceRefLocationLabel(source)}`;
}

function sourceRefLocationLabel(ref: SourceRef): string {
  return locationLabel({
    path: ref.path,
    line: ref.range?.startLine ?? null,
  });
}

function locationLabel(input: {
  readonly path: string;
  readonly line: number | null;
}): string {
  return input.line === null ? input.path : `${input.path}:${input.line}`;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
