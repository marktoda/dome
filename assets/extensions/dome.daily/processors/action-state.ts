// Shared source-backed daily action state for dome.daily view processors.

import type {
  FactEffect,
  QuestionEffect,
} from "../../../../src/core/effect";
import type { ProcessorContext } from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";
import { resolveQuestionCommand } from "../../../../src/question-resolution";

import {
  dailyPath,
  formatDate,
  isValidDailyDate,
  localDateParts,
  type DailyDate,
} from "./daily-shared";

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

export type DailyTaskItem = {
  readonly text: string;
  readonly path: string;
  readonly line: number | null;
  readonly source: DailyActionSource;
  readonly followup: boolean;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

export type DailyQuestionItem = {
  readonly id: number;
  readonly question: string;
  readonly options: ReadonlyArray<string>;
  readonly resolveCommand: string;
  readonly path: string;
  readonly line: number | null;
  readonly source: DailyActionSource;
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
  const path = dailyPath(date);
  const dailyContent = await ctx.snapshot.readFile(path);
  const dailySourceRefs =
    dailyContent === null ? [] : [ctx.sourceRef(path)];

  const openFacts = uniqueFactsByKey(ctx.projection.facts({
    predicate: OPEN_TASK_PREDICATE,
  }));
  const followupFacts = uniqueFactsByKey(ctx.projection.facts({
    predicate: FOLLOWUP_PREDICATE,
  }));
  const followupKeys = new Set(followupFacts.map(factKey));
  const openTasks = openFacts
    .map((fact) =>
      taskItemFromFact(fact, followupKeys.has(factKey(fact)), path)
    )
    .sort(compareTaskItemsForDaily(path));
  const followups = followupFacts
    .map((fact) => taskItemFromFact(fact, true, path))
    .sort(compareTaskItemsForDaily(path));
  const questions = ctx.projection
    .questions({ resolved: false })
    .filter((question) => question.idempotencyKey.startsWith("dome.daily."))
    .map((question) => questionItemFromEffect(question, path))
    .sort(compareQuestionItemsForDaily(path));
  const sourceCounts = countDailyActionSources({
    openTasks,
    followups,
    questions,
  });

  const scope = uniqueSourceRefs([
    ...dailySourceRefs,
    ...openTasks.flatMap((task) => task.sourceRefs),
    ...followups.flatMap((task) => task.sourceRefs),
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
      openTasks: openTasks.length,
      followups: followups.length,
      questions: questions.length,
    }),
    sourceCounts,
    openTasks: Object.freeze(openTasks),
    followups: Object.freeze(followups),
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

function parseDateString(value: string | null): DailyDate | null {
  if (value === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const [, yyyy, mm, dd] = match;
  if (yyyy === undefined || mm === undefined || dd === undefined) return null;
  const parsed = Object.freeze({ yyyy, mm, dd });
  return isValidDailyDate(parsed) ? parsed : null;
}

function taskItemFromFact(
  fact: FactEffect,
  followup: boolean,
  dailyPath: string,
): DailyTaskItem {
  const ref = fact.sourceRefs[0];
  const path = ref?.path ?? subjectPath(fact);
  return Object.freeze({
    text: literalToString(fact.object),
    path,
    line: ref?.range?.startLine ?? null,
    source: sourceForPath(path, dailyPath),
    followup,
    sourceRefs: Object.freeze([...fact.sourceRefs]),
  });
}

function questionItemFromEffect(
  question: QuestionEffect & { readonly id?: number },
  dailyPath: string,
): DailyQuestionItem {
  const ref = question.sourceRefs[0];
  const id = typeof question.id === "number" && Number.isFinite(question.id)
    ? question.id
    : 0;
  const options = Object.freeze([...(question.options ?? [])]);
  const path = ref?.path ?? "";
  return Object.freeze({
    id,
    question: question.question,
    options,
    resolveCommand: resolveQuestionCommand({ id, options }),
    path,
    line: ref?.range?.startLine ?? null,
    source: sourceForPath(path, dailyPath),
    sourceRefs: Object.freeze([...question.sourceRefs]),
  });
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

function factKey(fact: FactEffect): string {
  const ref = fact.sourceRefs[0];
  const object = literalIdentity(fact.object);
  return [
    ref?.path ?? subjectPath(fact),
    ref?.range?.startLine ?? "",
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
): (a: DailyTaskItem, b: DailyTaskItem) => number {
  return (a, b) => {
    const priorityCmp = pathDailyPriority(a.path, dailyPath) -
      pathDailyPriority(b.path, dailyPath);
    return priorityCmp === 0 ? compareTaskItems(a, b) : priorityCmp;
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
    const priorityCmp = pathDailyPriority(a.path, dailyPath) -
      pathDailyPriority(b.path, dailyPath);
    return priorityCmp === 0 ? compareQuestionItems(a, b) : priorityCmp;
  };
}

function pathDailyPriority(path: string, dailyPath: string): number {
  return path === dailyPath ? 0 : 1;
}

function comparePathLineText(
  aPath: string,
  aLine: number | null,
  aText: string,
  bPath: string,
  bLine: number | null,
  bText: string,
): number {
  const pathCmp = aPath.localeCompare(bPath);
  if (pathCmp !== 0) return pathCmp;
  const lineCmp = (aLine ?? Number.MAX_SAFE_INTEGER) -
    (bLine ?? Number.MAX_SAFE_INTEGER);
  if (lineCmp !== 0) return lineCmp;
  return aText.localeCompare(bText);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
