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

export function formatSeverity(value: string): string {
  if (value === "block" || value === "error") return color.red(value);
  if (value === "warning") return color.yellow(value);
  if (value === "info") return color.cyan(value);
  return value;
}

export function formatCommand(value: string): string {
  return color.cyan(value);
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 3) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 3)}...`;
}

