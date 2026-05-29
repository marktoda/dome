// dome.daily.today — render the source-backed action surface for a day.

import {
  viewEffect,
  type Effect,
  type FactEffect,
  type QuestionEffect,
  type ViewEffect,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";

import {
  dailyPath,
  isValidDailyDate,
  localDateParts,
  type DailyDate,
} from "./daily-shared";

const OPEN_TASK_PREDICATE = "dome.daily.open_task";
const FOLLOWUP_PREDICATE = "dome.daily.followup";
const SCHEMA = "dome.daily.today/v1";

const today: Processor = defineProcessor({
  id: "dome.daily.today",
  version: "0.1.0",
  phase: "view",
  triggers: [{ kind: "command", name: "today" }],
  capabilities: [{ kind: "read", paths: ["wiki/**/*.md"] }],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    if (ctx.projection === undefined) {
      throw new Error(
        "dome.daily.today: ctx.projection is undefined; view-phase processors require a ProjectionQueryView",
      );
    }

    const date = parseInputDate(ctx.input) ?? localDateParts(new Date());
    const dateString = formatDate(date);
    const path = dailyPath(date);
    const dailyContent = await ctx.snapshot.readFile(path);
    const dailySourceRefs =
      dailyContent === null ? [] : [ctx.sourceRef(path)];

    const openFacts = ctx.projection.facts({
      predicate: OPEN_TASK_PREDICATE,
    });
    const followupFacts = ctx.projection.facts({
      predicate: FOLLOWUP_PREDICATE,
    });
    const followupKeys = new Set(followupFacts.map(factKey));
    const openTasks = openFacts
      .map((fact) => taskItemFromFact(fact, followupKeys.has(factKey(fact))))
      .sort(compareTaskItems);
    const followups = followupFacts
      .map((fact) => taskItemFromFact(fact, true))
      .sort(compareTaskItems);
    const questions = ctx.projection
      .questions({ resolved: false })
      .filter((question) => question.idempotencyKey.startsWith("dome.daily."))
      .map(questionItemFromEffect)
      .sort(compareQuestionItems);

    const scope = uniqueSourceRefs([
      ...dailySourceRefs,
      ...openTasks.flatMap((task) => task.sourceRefs),
      ...followups.flatMap((task) => task.sourceRefs),
      ...questions.flatMap((question) => question.sourceRefs),
    ]);
    const data = Object.freeze({
      schema: SCHEMA,
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
      openTasks: Object.freeze(openTasks),
      followups: Object.freeze(followups),
      questions: Object.freeze(questions),
    });

    const effect: ViewEffect = viewEffect({
      name: "dome.daily.today",
      content: {
        kind: "structured",
        schema: SCHEMA,
        data,
      },
      scope,
    });
    return [effect];
  },
});

export default today;

type TodayTaskItem = {
  readonly text: string;
  readonly path: string;
  readonly line: number | null;
  readonly followup: boolean;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

type TodayQuestionItem = {
  readonly question: string;
  readonly options: ReadonlyArray<string>;
  readonly path: string;
  readonly line: number | null;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

function taskItemFromFact(
  fact: FactEffect,
  followup: boolean,
): TodayTaskItem {
  const ref = fact.sourceRefs[0];
  return Object.freeze({
    text: literalToString(fact.object),
    path: ref?.path ?? subjectPath(fact),
    line: ref?.range?.startLine ?? null,
    followup,
    sourceRefs: Object.freeze([...fact.sourceRefs]),
  });
}

function questionItemFromEffect(question: QuestionEffect): TodayQuestionItem {
  const ref = question.sourceRefs[0];
  return Object.freeze({
    question: question.question,
    options: Object.freeze([...(question.options ?? [])]),
    path: ref?.path ?? "",
    line: ref?.range?.startLine ?? null,
    sourceRefs: Object.freeze([...question.sourceRefs]),
  });
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

function literalIdentity(value: FactEffect["object"]): string {
  if (value.kind === "page") return `page:${value.path}`;
  if (value.kind === "task") return `task:${value.stableId}`;
  if (value.kind === "entity") return `entity:${value.name}`;
  if (value.kind === "string") return `string:${value.value}`;
  if (value.kind === "number") return `number:${value.value}`;
  return `date:${value.value}`;
}

function compareTaskItems(a: TodayTaskItem, b: TodayTaskItem): number {
  return comparePathLineText(a.path, a.line, a.text, b.path, b.line, b.text);
}

function compareQuestionItems(
  a: TodayQuestionItem,
  b: TodayQuestionItem,
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

function parseInputDate(input: unknown): DailyDate | null {
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
  return parseDateString(stringValue(record.date) ?? stringValue(flags.date));
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

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function formatDate(date: DailyDate): string {
  return `${date.yyyy}-${date.mm}-${date.dd}`;
}
