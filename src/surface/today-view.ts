// surface/today-view: shared parser for dome.daily.today/v1 structured data.
// Both the web cockpit (src/http/today-html.ts) and the terminal briefing
// (src/cli/commands/today.ts) consume this — ending the drift between their
// duplicated local parsers.
//
// Behavior contract:
//   - ALL task/question/hero text is stripWikilinks-cleaned here.
//   - question options are always parsed (ReadonlyArray<string>).
//   - counts are number-coerced with array-length fallbacks.
//   - null-safe throughout: brief/calendar/hero return null if absent/malformed.

import { stripWikilinks } from "../core/wikilink";

// ── Field types ────────────────────────────────────────────────────────────────

export type TodayTaskRow = {
  readonly text: string;
  readonly path: string;
  readonly line: number | null;
  readonly dueDate: string | null;
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

function parseTaskRows(raw: unknown): ReadonlyArray<TodayTaskRow> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const r = isRecord(item) ? item : {};
    const text = typeof r.text === "string" ? stripWikilinks(r.text) : "";
    if (text.length === 0) return [];
    return [{
      text,
      path: typeof r.path === "string" ? r.path : "",
      line: typeof r.line === "number" ? r.line : null,
      dueDate: typeof r.dueDate === "string" ? r.dueDate : null,
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
    const text = typeof item.text === "string" ? stripWikilinks(item.text) : "";
    if (text.length === 0) return null;
    return {
      kind: "task",
      item: {
        text,
        path: typeof item.path === "string" ? item.path : "",
        line: typeof item.line === "number" ? item.line : null,
        dueDate: typeof item.dueDate === "string" ? item.dueDate : null,
      },
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
