import { InvalidArgumentError } from "commander";

export function parsePositiveIntegerOption(raw: string): number {
  return parseIntegerOption(raw, "positive", (value) => value > 0);
}

export function parseNonNegativeIntegerOption(raw: string): number {
  return parseIntegerOption(raw, "non-negative", (value) => value >= 0);
}

export function parsePositiveIntegerValue(
  raw: string | number | boolean | undefined,
  fallback: number | null,
): number | null {
  return parseIntegerValue(raw, fallback, (value) => value > 0);
}

export function parseNonNegativeIntegerValue(
  raw: string | number | boolean | undefined,
  fallback: number | null,
): number | null {
  return parseIntegerValue(raw, fallback, (value) => value >= 0);
}

function parseIntegerOption(
  raw: string,
  label: "positive" | "non-negative",
  valid: (value: number) => boolean,
): number {
  const value = parseIntegerValue(raw, null, valid);
  if (value === null) {
    throw new InvalidArgumentError(`Must be a ${label} integer.`);
  }
  return value;
}

function parseIntegerValue(
  raw: string | number | boolean | undefined,
  fallback: number | null,
  valid: (value: number) => boolean,
): number | null {
  if (raw === undefined || raw === true) return fallback;
  if (raw === false) return null;
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && valid(raw) ? raw : null;
  }
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && valid(value) ? value : null;
}
