// Shared option helpers for first-party daily view commands.

export function defaultLocalDateString(): string {
  return localDateString(new Date());
}

export function validateDateOption(
  commandLabel: string,
  date: string,
): boolean {
  if (isDateString(date)) return true;
  console.error(
    `${commandLabel}: invalid --date. Expected YYYY-MM-DD, for example 2026-01-05.`,
  );
  return false;
}

function localDateString(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function isDateString(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [, yyyy, mm, dd] = match;
  if (yyyy === undefined || mm === undefined || dd === undefined) return false;
  const date = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  return date.getFullYear() === Number(yyyy) &&
    date.getMonth() === Number(mm) - 1 &&
    date.getDate() === Number(dd);
}
