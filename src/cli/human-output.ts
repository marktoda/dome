import type { CliNextAction } from "./next-actions";

export function plural(
  count: number,
  singular: string,
  pluralForm = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function statusWord(attention: boolean): "ok" | "needs attention" {
  return attention ? "needs attention" : "ok";
}

export function formatMaybe(value: string | null | undefined): string {
  return value === null || value === undefined || value.length === 0
    ? "none"
    : value;
}

export function formatShortOid(
  oid: string | null | undefined,
  fallback = "none",
): string {
  return oid === null || oid === undefined ? fallback : oid.slice(0, 7);
}

export function pushSection(
  lines: string[],
  title: string,
  body: ReadonlyArray<string>,
): void {
  if (body.length === 0) return;
  lines.push("", title, ...body);
}

export function formatSummaryRows(
  rows: ReadonlyArray<readonly [string, string]>,
): ReadonlyArray<string> {
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  return rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`);
}

export function formatNextActionsBlock(
  actions: ReadonlyArray<CliNextAction>,
): ReadonlyArray<string> {
  if (actions.length === 0) return [];
  const lines = ["Next"];
  for (const [index, action] of actions.entries()) {
    const label = action.command === null ? "manual" : action.command;
    lines.push(`  ${index + 1}. ${label}`);
    lines.push(`     ${action.description}`);
    if (action.reasons.length > 0) {
      lines.push(`     reasons: ${action.reasons.join(", ")}`);
    }
  }
  return lines;
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 3) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 3)}...`;
}
