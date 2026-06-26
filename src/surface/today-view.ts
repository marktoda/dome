// surface/today-view: the dome.daily.today/v1 surface contract + view-model.
//
// Three tiers (docs/wiki/concepts/surface-view-model.md):
//   1. Payload contract — `todayPayloadSchema` / `TodayPayload`: the single
//      declared wire shape. The producer (assets/extensions/dome.daily/
//      processors/today.ts) imports the erased `TodayPayload` type and
//      constructs its ViewEffect data to it; agent tools + MCP validate
//      received payloads against the schema instead of re-deriving the shape
//      by hand (this is what retires the "sourceRefs is a PLURAL ARRAY"
//      footgun). Unknown keys are passed through, so the producer's extra
//      envelope fields (limit, daily, sourceCounts, …) don't break validation
//      — the contract is the consumed subset.
//   2. View-model — `buildTodayViewModel`: urgency classification, hero-dedup,
//      sections, totalOpen. Consumer-derived; adapters paint it.
//   3. Paint — the CLI (src/cli/commands/today.ts) and HTTP
//      (src/http/today-html.ts) adapters.
//
// `parseTodayView` is the CLI/HTTP render path's lenient enrich (strip
// wikilinks, extract entities, count fallbacks, null-safe). It stays total
// (never throws) for render resilience; the strict schema validates the wire
// contract for the producer + agent/MCP consumers.

import { z } from "zod";

import { stripWikilinks, wikilinkSlugs } from "../core/wikilink";

// ── Field types ────────────────────────────────────────────────────────────────

export type TodayTaskRow = {
  readonly text: string;
  readonly path: string;
  readonly line: number | null;
  readonly source?: "daily" | "backlog";
  readonly dueDate: string | null;
  /** Decoded URL/path from an inline `([↗](target))` origin marker, if present. */
  readonly origin?: string;
  readonly evidenceLabel?: string;
  readonly lastChangedAt?: string | null;
  readonly attention?: TodayTaskAttention | null;
  readonly sourceRefs?: ReadonlyArray<TodaySourceRef>;
  /** Slugs of all `[[wikilink]]` targets found in the raw task text (order-preserving, deduped). */
  readonly entities?: readonly string[];
  /** Obsidian task priority parsed by the producer; null/absent when untagged. */
  readonly priority?: "highest" | "high" | "medium" | "low" | "lowest" | null;
};

export type TodayTaskAttention = {
  readonly discount: number;
  readonly impressions: number;
  readonly lastShown: string;
};

export type TodaySourceRef = {
  readonly path: string;
  readonly commit?: string;
  readonly stableId?: string;
  readonly range?: {
    readonly startLine: number;
    readonly endLine: number;
  };
};

export type TodayQuestionRow = {
  readonly id: number;
  readonly question: string;
  readonly resolveCommand: string;
  readonly options: ReadonlyArray<string>;
};

export type TodayCalendarEvent = {
  readonly time: string;
  readonly title: string;
  readonly meta: string;
};

export type TodayCalendar = {
  readonly events: ReadonlyArray<TodayCalendarEvent>;
  readonly sourceRef: { readonly path: string };
};

export type TodayBriefField = {
  readonly text: string;
  readonly sourceRef: { readonly path: string };
};

export type TodayHeroItem =
  | { readonly kind: "task"; readonly item: TodayTaskRow }
  | { readonly kind: "question"; readonly item: TodayQuestionRow };

export type TodayCounts = {
  readonly openTasks: number;
  readonly followups: number;
  readonly questions: number;
};

export type TodayView = {
  readonly date: string;
  readonly openTasks: ReadonlyArray<TodayTaskRow>;
  readonly followups: ReadonlyArray<TodayTaskRow>;
  readonly questions: ReadonlyArray<TodayQuestionRow>;
  readonly brief: TodayBriefField | null;
  readonly calendar: TodayCalendar | null;
  readonly hero: TodayHeroItem | null;
  readonly counts: TodayCounts;
};

// ── Tier 1: the dome.daily.today/v1 wire contract ───────────────────────────
// The single declared shape spanning producer ↔ consumers. zod's default
// key-stripping pins the consumed subset: the producer's richer objects (full
// SourceRefs with ranges, extra envelope fields like limit/sourceCounts) pass
// validation — the extra keys are simply dropped, never rejected. Clean inferred
// types (no index signatures). Text is RAW here (wikilinks intact); stripping is
// the consumer's enrich.

const sourceRefWireSchema = z.object({
  path: z.string(),
  commit: z.string().optional(),
  stableId: z.string().optional(),
  range: z
    .object({
      startLine: z.number(),
      endLine: z.number(),
    })
    .optional(),
});

const attentionWireSchema = z.object({
  discount: z.number(),
  impressions: z.number(),
  lastShown: z.string(),
});

const taskRowWireSchema = z.object({
  text: z.string(),
  path: z.string(),
  line: z.number().nullable().optional(),
  source: z.enum(["daily", "backlog"]).optional(),
  dueDate: z.string().nullable().optional(),
  origin: z.string().optional(),
  evidenceLabel: z.string().optional(),
  lastChangedAt: z.string().nullable().optional(),
  attention: attentionWireSchema.nullable().optional(),
  priority: z.enum(["highest", "high", "medium", "low", "lowest"]).nullable().optional(),
  sourceRefs: z.array(sourceRefWireSchema).readonly().optional(),
});

const questionRowWireSchema = z.object({
  id: z.number(),
  question: z.string(),
  resolveCommand: z.string().optional(),
  options: z.array(z.string()).readonly().optional(),
  sourceRefs: z.array(sourceRefWireSchema).readonly().optional(),
});

const heroWireSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), item: taskRowWireSchema }),
  z.object({ kind: z.literal("question"), item: questionRowWireSchema }),
]);

const todayPayloadSchema = z.object({
  date: z.string(),
  counts: z.object({
    openTasks: z.number(),
    followups: z.number(),
    questions: z.number(),
  }),
  openTasks: z.array(taskRowWireSchema).readonly(),
  followups: z.array(taskRowWireSchema).readonly(),
  questions: z.array(questionRowWireSchema).readonly(),
  brief: z
    .object({ text: z.string(), sourceRef: z.object({ path: z.string() }) })
    .nullable(),
  calendar: z
    .object({
      events: z
        .array(z.object({ time: z.string(), title: z.string(), meta: z.string().optional() }))
        .readonly(),
      sourceRef: z.object({ path: z.string() }),
    })
    .nullable(),
  hero: heroWireSchema.nullable(),
  // The daily note's own locator metadata — consumed by the MCP brief tool to
  // find + read the note. Optional: the CLI/HTTP render path and agent tools
  // don't read it.
  daily: z
    .object({
      path: z.string(),
      exists: z.boolean().optional(),
      sourceRefs: z.array(sourceRefWireSchema).readonly().optional(),
    })
    .optional(),
});

/**
 * The `dome.daily.today/v1` wire contract. The producer imports this *type*
 * (erased — no runtime zod dependency crosses into the bundle) and constructs
 * its ViewEffect data to it; agent tools + MCP validate received payloads with
 * `todayPayloadSchema`.
 */
export type TodayPayload = z.infer<typeof todayPayloadSchema>;
export { todayPayloadSchema };

// ── Public entry point ────────────────────────────────────────────────────────

export function parseTodayView(data: unknown): TodayView {
  const record = isRecord(data) ? data : {};
  const date = typeof record.date === "string" ? record.date : "today";
  const openTasks = parseTaskRows(record.openTasks);
  const followups = parseTaskRows(record.followups);
  const questions = parseQuestionRows(record.questions);
  const brief = parseBrief(record.brief);
  const calendar = parseCalendar(record.calendar);
  const hero = parseHero(record.hero);
  const rawCounts = isRecord(record.counts) ? record.counts : {};
  const counts: TodayCounts = {
    openTasks: numberOr(rawCounts.openTasks, openTasks.length),
    followups: numberOr(rawCounts.followups, followups.length),
    questions: numberOr(rawCounts.questions, questions.length),
  };
  return { date, openTasks, followups, questions, brief, calendar, hero, counts };
}

// ── Private parsers ───────────────────────────────────────────────────────────

const PRIORITY_LEVELS = ["highest", "high", "medium", "low", "lowest"] as const;
type ParsedPriority = (typeof PRIORITY_LEVELS)[number];

function parsePriority(raw: unknown): ParsedPriority | null {
  return typeof raw === "string" && (PRIORITY_LEVELS as readonly string[]).includes(raw)
    ? (raw as ParsedPriority)
    : null;
}

/**
 * Plain (uncolored) priority marker glyphs, shared by both paint adapters so
 * they can't drift on what a level looks like. The marker gutter is ≤2 cols
 * wide (`▲▲`/`▽▽`); medium/null render no mark. ASCII fallback uses `^`/`v`.
 */
export function priorityMarkerChars(
  priority: TodayTaskRow["priority"] | undefined,
  unicode: boolean,
): string {
  switch (priority) {
    case "highest": return unicode ? "▲▲" : "^^";
    case "high":    return unicode ? "▲" : "^";
    case "low":     return unicode ? "▽" : "v";
    case "lowest":  return unicode ? "▽▽" : "vv";
    default:        return ""; // medium / null / undefined → no mark
  }
}

function parseTaskRows(raw: unknown): ReadonlyArray<TodayTaskRow> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const r = isRecord(item) ? item : {};
    const row = parseTaskRowRecord(r);
    return row === null ? [] : [row];
  });
}

function parseTaskRowRecord(r: Record<string, unknown>): TodayTaskRow | null {
  const rawText = typeof r.text === "string" ? r.text : "";
  const text = rawText.length > 0 ? stripWikilinks(rawText) : "";
  if (text.length === 0) return null;
  const origin = typeof r.origin === "string" ? r.origin : undefined;
  const entities = wikilinkSlugs(rawText);
  const priority = parsePriority(r.priority);
  const source = r.source === "daily" || r.source === "backlog"
    ? r.source
    : undefined;
  const evidenceLabel = typeof r.evidenceLabel === "string"
    ? r.evidenceLabel
    : undefined;
  const lastChangedAt = typeof r.lastChangedAt === "string"
    ? r.lastChangedAt
    : r.lastChangedAt === null
      ? null
      : undefined;
  const attention = parseAttention(r.attention);
  const sourceRefs = parseSourceRefs(r.sourceRefs);
  return {
    text,
    path: typeof r.path === "string" ? r.path : "",
    line: typeof r.line === "number" ? r.line : null,
    ...(source !== undefined ? { source } : {}),
    dueDate: typeof r.dueDate === "string" ? r.dueDate : null,
    ...(origin !== undefined ? { origin } : {}),
    ...(evidenceLabel !== undefined ? { evidenceLabel } : {}),
    ...(lastChangedAt !== undefined ? { lastChangedAt } : {}),
    ...(attention !== undefined ? { attention } : {}),
    ...(sourceRefs.length > 0 ? { sourceRefs } : {}),
    ...(entities.length > 0 ? { entities } : {}),
    ...(priority !== null ? { priority } : {}),
  };
}

function parseAttention(raw: unknown): TodayTaskAttention | null | undefined {
  if (raw === null) return null;
  if (!isRecord(raw)) return undefined;
  const discount = typeof raw.discount === "number" ? raw.discount : null;
  const impressions = typeof raw.impressions === "number" ? raw.impressions : null;
  const lastShown = typeof raw.lastShown === "string" ? raw.lastShown : null;
  if (discount === null || impressions === null || lastShown === null) {
    return undefined;
  }
  return { discount, impressions, lastShown };
}

function parseSourceRefs(raw: unknown): ReadonlyArray<TodaySourceRef> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!isRecord(item) || typeof item.path !== "string") return [];
    const range = isRecord(item.range) &&
      typeof item.range.startLine === "number" &&
      typeof item.range.endLine === "number"
      ? {
        startLine: item.range.startLine,
        endLine: item.range.endLine,
      }
      : undefined;
    return [{
      path: item.path,
      ...(typeof item.commit === "string" ? { commit: item.commit } : {}),
      ...(typeof item.stableId === "string" ? { stableId: item.stableId } : {}),
      ...(range !== undefined ? { range } : {}),
    }];
  });
}

function parseQuestionRows(raw: unknown): ReadonlyArray<TodayQuestionRow> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const r = isRecord(item) ? item : {};
    const question = typeof r.question === "string" ? stripWikilinks(r.question) : "";
    if (question.length === 0) return [];
    const options: string[] = Array.isArray(r.options)
      ? r.options.filter((o): o is string => typeof o === "string")
      : [];
    return [{
      id: typeof r.id === "number" ? r.id : 0,
      question,
      resolveCommand: typeof r.resolveCommand === "string"
        ? r.resolveCommand
        : "dome resolve <id> <value>",
      options,
    }];
  });
}

function parseBrief(raw: unknown): TodayBriefField | null {
  if (!isRecord(raw)) return null;
  const text = typeof raw.text === "string" ? raw.text : null;
  if (text === null || text.length === 0) return null;
  const sourceRef = isRecord(raw.sourceRef) ? raw.sourceRef : null;
  const path = sourceRef !== null && typeof sourceRef.path === "string"
    ? sourceRef.path
    : "";
  return { text, sourceRef: { path } };
}

function parseCalendar(raw: unknown): TodayCalendar | null {
  if (!isRecord(raw)) return null;
  if (!Array.isArray(raw.events)) return null;
  const events: TodayCalendarEvent[] = raw.events.flatMap((ev) => {
    if (!isRecord(ev)) return [];
    const time = typeof ev.time === "string" ? ev.time : null;
    const title = typeof ev.title === "string" ? ev.title : null;
    if (time === null || title === null) return [];
    const meta = typeof ev.meta === "string" ? ev.meta : "";
    return [{ time, title, meta }];
  });
  if (events.length === 0) return null;
  const sourceRef = isRecord(raw.sourceRef) ? raw.sourceRef : null;
  const path = sourceRef !== null && typeof sourceRef.path === "string"
    ? sourceRef.path
    : "";
  return { events, sourceRef: { path } };
}

function parseHero(raw: unknown): TodayHeroItem | null {
  if (!isRecord(raw)) return null;
  const kind = raw.kind;
  if (kind === "task") {
    const item = isRecord(raw.item) ? raw.item : null;
    if (item === null) return null;
    const parsed = parseTaskRowRecord(item);
    if (parsed === null) return null;
    return {
      kind: "task",
      item: parsed,
    };
  }
  if (kind === "question") {
    const item = isRecord(raw.item) ? raw.item : null;
    if (item === null) return null;
    const question = typeof item.question === "string" ? stripWikilinks(item.question) : "";
    if (question.length === 0) return null;
    const options: string[] = Array.isArray(item.options)
      ? item.options.filter((o): o is string => typeof o === "string")
      : [];
    return {
      kind: "question",
      item: {
        id: typeof item.id === "number" ? item.id : 0,
        question,
        resolveCommand: typeof item.resolveCommand === "string"
          ? item.resolveCommand
          : "dome resolve <id> <value>",
        options,
      },
    };
  }
  return null;
}

// ── Tier 2: the view-model ──────────────────────────────────────────────────
// The semantic decisions both adapters used to recompute independently: per-task
// urgency, hero-dedup, and the five due-date sections. Adapters paint this; they
// no longer derive "is this overdue" or "is this the hero" themselves.

export type TaskUrgency =
  | { readonly kind: "overdue"; readonly days: number }
  | { readonly kind: "due-today" }
  | { readonly kind: "this-week"; readonly date: string }
  | { readonly kind: "later"; readonly date: string }
  | { readonly kind: "someday" };

/** Open tasks partitioned by urgency. A row's section IS its urgency. */
export type TodaySections = {
  readonly overdue: ReadonlyArray<TodayTaskRow>;
  readonly dueToday: ReadonlyArray<TodayTaskRow>;
  readonly thisWeek: ReadonlyArray<TodayTaskRow>;
  readonly later: ReadonlyArray<TodayTaskRow>;
  readonly someday: ReadonlyArray<TodayTaskRow>;
};

export type TodayViewModel = {
  readonly date: string;
  readonly counts: TodayCounts;
  /** counts.openTasks + followups + questions — the "N open" headline; all-clear is `=== 0`. */
  readonly totalOpen: number;
  readonly stillOpen: TodaySections;
  readonly brief: TodayBriefField | null;
  readonly calendar: TodayCalendar | null;
  readonly questions: ReadonlyArray<TodayQuestionRow>;
};

/** Classify a task's due date relative to `today` (both "YYYY-MM-DD" or null). */
export function classifyUrgency(dueDate: string | null, today: string): TaskUrgency {
  if (dueDate === null) return { kind: "someday" };
  if (dueDate < today) return { kind: "overdue", days: daysBetween(dueDate, today) };
  if (dueDate === today) return { kind: "due-today" };
  if (dueDate <= addDays(today, 7)) return { kind: "this-week", date: dueDate };
  return { kind: "later", date: dueDate };
}

/** Derive the today view-model from a parsed view. Pure; `today` is `view.date`. */
export function buildTodayViewModel(view: TodayView): TodayViewModel {
  const { date, openTasks, followups, questions, brief, calendar, counts } = view;

  const sections: {
    overdue: TodayTaskRow[];
    dueToday: TodayTaskRow[];
    thisWeek: TodayTaskRow[];
    later: TodayTaskRow[];
    someday: TodayTaskRow[];
  } = { overdue: [], dueToday: [], thisWeek: [], later: [], someday: [] };

  for (const t of [...openTasks, ...followups]) {
    const urgency = classifyUrgency(t.dueDate, date);
    if (urgency.kind === "overdue") sections.overdue.push(t);
    else if (urgency.kind === "due-today") sections.dueToday.push(t);
    else if (urgency.kind === "this-week") sections.thisWeek.push(t);
    else if (urgency.kind === "later") sections.later.push(t);
    else sections.someday.push(t);
  }

  return {
    date,
    counts,
    totalOpen: counts.openTasks + counts.followups + counts.questions,
    stillOpen: {
      overdue: sections.overdue,
      dueToday: sections.dueToday,
      thisWeek: sections.thisWeek,
      later: sections.later,
      someday: sections.someday,
    },
    brief,
    calendar,
    questions,
  };
}

// ── Date helpers ────────────────────────────────────────────────────────────
// One cluster of YYYY-MM-DD arithmetic, shared by both surfaces. UTC-based so
// there is no DST / local-timezone off-by-one (2026-06-10 → 2026-06-14 == 4).

/** Add N calendar days to an ISO date string (YYYY-MM-DD). */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (
    y === undefined || m === undefined || d === undefined ||
    [y, m, d].some((n) => Number.isNaN(n))
  ) {
    return isoDate;
  }
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Whole calendar days from `earlier` to `later` (both "YYYY-MM-DD").
 * UTC midnight diff — no off-by-one. Returns 0 if equal/reversed/unparseable.
 */
export function daysBetween(earlier: string, later: string): number {
  const [ay, am, ad] = earlier.split("-").map(Number);
  const [by, bm, bd] = later.split("-").map(Number);
  if (
    ay === undefined || am === undefined || ad === undefined ||
    by === undefined || bm === undefined || bd === undefined ||
    [ay, am, ad, by, bm, bd].some((n) => Number.isNaN(n))
  ) {
    return 0;
  }
  const a = Date.UTC(ay, am - 1, ad);
  const b = Date.UTC(by, bm - 1, bd);
  if (b <= a) return 0;
  return Math.round((b - a) / 86_400_000);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
