import { validateRelativeMarkdownPath } from "../../../../src/core/config-path";
import {
  DEFAULT_DAILY_PATH_SETTINGS,
  type DailyDate,
  type DailyPathSettings,
} from "./daily-types";

function validateDailyPathTemplate(template: string): string {
  const parts = template.split("{date}");
  if (parts.length !== 2) {
    throw new Error(
      "dome.daily config daily_path must contain exactly one {date} placeholder",
    );
  }
  if (template.trim() !== template || template.length === 0) {
    throw new Error("dome.daily config daily_path must be a non-empty path");
  }
  const sample = template.replace("{date}", "2026-01-02");
  if (!sample.endsWith(".md")) {
    throw new Error("dome.daily config daily_path must produce a .md file");
  }
  // Delegate the relative-vault-path shape check to the shared validator.
  // validateRelativeMarkdownPath with the substituted sample passes the
  // string/non-empty/.md checks (sample is always a string ending in .md
  // at this point), so only the absolute/traversal check fires when needed.
  // The bare problem "daily_path must be a relative vault markdown path"
  // wrapped by the caller with "dome.daily config " prefix reproduces the
  // historically thrown message byte-for-byte.
  const v = validateRelativeMarkdownPath(sample, "daily_path");
  if (!v.ok) {
    throw new Error(`dome.daily config ${v.problem}`);
  }
  return template;
}

function dailyPathRegex(settings: DailyPathSettings): RegExp {
  const [before, after] = settings.template.split("{date}");
  return new RegExp(
    `^${escapeRegExp(before ?? "")}(\\d{4})-(\\d{2})-(\\d{2})${escapeRegExp(after ?? "")}$`,
  );
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * THE vault-date policy: a clock reading becomes a vault-facing calendar
 * date via the HOST-LOCAL timezone. Daily notes, sweep/consolidation ledger
 * dates, and "today" in agent prompts all mean the owner's calendar day —
 * an evening capture west of UTC belongs to today's daily, not tomorrow's.
 * Every clock→date conversion in bundle code must go through this helper
 * (fed by ctx.now(), per the processor-clock fence). UTC date handling is
 * reserved for TZ-less date *literals* (frontmatter `YYYY-MM-DD` values,
 * date-string arithmetic), which never touch the clock.
 */
export function localDateParts(date: Date): DailyDate {
  return Object.freeze({
    yyyy: String(date.getFullYear()).padStart(4, "0"),
    mm: String(date.getMonth() + 1).padStart(2, "0"),
    dd: String(date.getDate()).padStart(2, "0"),
  });
}

export function previousLocalDate(date: DailyDate): DailyDate {
  const previous = new Date(
    Number(date.yyyy),
    Number(date.mm) - 1,
    Number(date.dd) - 1,
  );
  return localDateParts(previous);
}

export function dailyPathSettings(
  config?: Readonly<Record<string, unknown>>,
): DailyPathSettings {
  const raw = config?.daily_path;
  if (raw === undefined) return DEFAULT_DAILY_PATH_SETTINGS;
  if (typeof raw !== "string") {
    throw new Error("dome.daily config daily_path must be a string");
  }
  return Object.freeze({
    template: validateDailyPathTemplate(raw),
  });
}

export function dailyPath(
  date: DailyDate,
  settings: DailyPathSettings = DEFAULT_DAILY_PATH_SETTINGS,
): string {
  return settings.template.replace("{date}", formatDate(date));
}

export function dailyLink(
  date: DailyDate,
  settings: DailyPathSettings = DEFAULT_DAILY_PATH_SETTINGS,
): string {
  return dailyPath(date, settings).replace(/\.md$/, "");
}

export function parseDailyPath(
  path: string,
  settings: DailyPathSettings = DEFAULT_DAILY_PATH_SETTINGS,
): DailyDate | null {
  const match = dailyPathRegex(settings).exec(path);
  if (match === null) return null;
  const [, yyyy, mm, dd] = match;
  if (yyyy === undefined || mm === undefined || dd === undefined) return null;
  const parsed = Object.freeze({ yyyy, mm, dd });
  if (!isValidDailyDate(parsed)) return null;
  return parsed;
}

export function formatDate(date: DailyDate): string {
  return `${date.yyyy}-${date.mm}-${date.dd}`;
}

export function isValidDailyDate(date: DailyDate): boolean {
  const normalized = localDateParts(
    new Date(Number(date.yyyy), Number(date.mm) - 1, Number(date.dd)),
  );
  return (
    normalized.yyyy === date.yyyy &&
    normalized.mm === date.mm &&
    normalized.dd === date.dd
  );
}

/**
 * The scheduled-fire envelope every dome.daily schedule-only processor
 * (create-daily, carry-forward, close-scaffold) receives. The shape is the
 * engine's scheduler input contract; the parse below is the shared, defensive
 * narrowing — a non-schedule input (or an unparseable `firedAt`) yields null
 * so the caller can no-op, and a valid one is normalized to a frozen ISO
 * `firedAt` before the clock→date conversion through localDateParts.
 */
export type ScheduleInput = {
  readonly kind: "schedule";
  readonly cron: string;
  readonly firedAt: string;
};

export function parseScheduleInput(input: unknown): ScheduleInput | null {
  if (input === null || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  if (record.kind !== "schedule") return null;
  if (typeof record.cron !== "string") return null;
  if (typeof record.firedAt !== "string") return null;
  if (Number.isNaN(new Date(record.firedAt).getTime())) return null;
  return Object.freeze({
    kind: "schedule",
    cron: record.cron,
    firedAt: new Date(record.firedAt).toISOString(),
  });
}
