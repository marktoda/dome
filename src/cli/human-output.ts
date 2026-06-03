import pc from "picocolors";

const color = pc.createColors(shouldUseColor());

function shouldUseColor(): boolean {
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

export function formatHeadline(command: string, status: string): string {
  return `${color.bold(command)}  ${formatStatusValue(status)}`;
}

function formatSectionTitle(title: string): string {
  return color.bold(title);
}

function formatStatusValue(value: string): string {
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
