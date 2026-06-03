import pc from "picocolors";

import type { CliNextAction } from "./next-actions";

const color = pc.createColors(shouldUseColor());

export function shouldUseColor(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  const forceColor = process.env.FORCE_COLOR;
  if (
    forceColor !== undefined &&
    forceColor.length > 0 &&
    forceColor !== "0" &&
    forceColor.toLowerCase() !== "false"
  ) {
    return true;
  }
  return process.stdout.isTTY === true;
}

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

export function formatHeadline(command: string, status: string): string {
  return `${color.bold(command)}  ${formatStatusValue(status)}`;
}

export function formatSectionTitle(title: string): string {
  return color.bold(title);
}

export function formatStatusValue(value: string): string {
  if (isGoodStatus(value)) return color.green(value);
  if (isBadStatus(value)) return color.red(value);
  if (isWarningStatus(value)) return color.yellow(value);
  return value;
}

export function formatSeverity(value: string): string {
  if (value === "block" || value === "error") return color.red(value);
  if (value === "warning") return color.yellow(value);
  if (value === "info") return color.cyan(value);
  return value;
}

export function formatCommand(value: string): string {
  return color.cyan(value);
}

export function formatMuted(value: string): string {
  return color.dim(value);
}

export function colorizeHumanOutput(text: string): string {
  return text
    .split("\n")
    .map((line) => colorizeHumanLine(line))
    .join("\n");
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
  lines.push("", formatSectionTitle(title), ...body);
}

export function formatSummaryRows(
  rows: ReadonlyArray<readonly [string, string]>,
): ReadonlyArray<string> {
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  return rows.map(([label, value]) =>
    `  ${color.dim(label.padEnd(width))}  ${formatStatusValue(value)}`
  );
}

export function formatBulletLines(
  items: ReadonlyArray<string>,
  empty = "none",
): ReadonlyArray<string> {
  if (items.length === 0) return [`  ${formatMuted(empty)}`];
  return items.map((item) => `  - ${item}`);
}

export function formatNextActionsBlock(
  actions: ReadonlyArray<CliNextAction>,
): ReadonlyArray<string> {
  if (actions.length === 0) return [];
  const lines = [formatSectionTitle("Next")];
  for (const [index, action] of actions.entries()) {
    const label = action.command === null ? "manual" : action.command;
    lines.push(`  ${index + 1}. ${formatCommand(label)}`);
    lines.push(`     ${action.description}`);
    if (action.reasons.length > 0) {
      lines.push(`     ${color.dim("reasons:")} ${action.reasons.join(", ")}`);
    }
  }
  return lines;
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 3) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 3)}...`;
}

function isGoodStatus(value: string): boolean {
  return value === "ok" ||
    value === "fresh" ||
    value === "pass" ||
    value === "rebuilt" ||
    value === "answered" ||
    value === "clean" ||
    value === "vault ready" ||
    value.startsWith("adopted ") ||
    value.startsWith("already in sync") ||
    value.startsWith("answered question ") ||
    value.startsWith("already answered question ");
}

function isBadStatus(value: string): boolean {
  return value === "fail" ||
    value === "error" ||
    value === "block" ||
    value === "blocked" ||
    value === "diverged" ||
    value.startsWith("blocked ");
}

function isWarningStatus(value: string): boolean {
  return value === "needs attention" ||
    value === "needs sync" ||
    value === "attention" ||
    value === "needed" ||
    value === "stale" ||
    value.startsWith("attention ") ||
    value.startsWith("stale ") ||
    value.includes(" warning") ||
    value.includes(" error") ||
    value.includes(" failed");
}

function colorizeHumanLine(line: string): string {
  const headline = /^(Dome .+?)(?::| {2,})(.+)$/.exec(line);
  if (headline !== null && headline[1] !== undefined && headline[2] !== undefined) {
    return formatHeadline(headline[1].trimEnd(), headline[2].trimStart());
  }
  if (
    line.length > 0 &&
    !line.startsWith(" ") &&
    !line.includes(":") &&
    /^[A-Z][A-Za-z ]+$/.test(line)
  ) {
    return formatSectionTitle(line);
  }
  return line.replace(
    /\[(info|warning|error|block)\]/g,
    (_match, severity: string) => `[${formatSeverity(severity)}]`,
  );
}
