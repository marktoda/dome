import matter from "gray-matter";
import YAML from "yaml";

import { dateOnly, daysBetween } from "./frontmatter-dates";

// Canonical frontmatter key order for managed markdown pages. Keys not listed
// here are preserved and sorted after the fixed identity/provenance keys.
export const CANONICAL_FRONTMATTER_ORDER: ReadonlyArray<string> = Object.freeze([
  "type",
  "id",
  "aliases",
  "tags",
  "created",
  "updated",
  "sources",
]);

export const MAX_UPDATED_DRIFT_DAYS = 1;

export type ParsedFrontmatter = {
  readonly body: string;
  readonly data: Record<string, unknown>;
  readonly currentUpdatedDate: string | null;
};

export function parseFrontmatter(content: string): ParsedFrontmatter | null {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch {
    return null;
  }

  if (matterFileIsEmpty(parsed) || Object.keys(parsed.data).length === 0) {
    return null;
  }

  const normalizedScalars = normalizeYamlScalars(parsed.data);
  return Object.freeze({
    body: parsed.content,
    data: Object.freeze(normalizedScalars),
    currentUpdatedDate: dateOnly(normalizedScalars["updated"]),
  });
}

export function reorderFrontmatterKeys(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const remaining = new Set<string>(Object.keys(data));

  for (const key of CANONICAL_FRONTMATTER_ORDER) {
    if (remaining.has(key)) {
      out[key] = data[key];
      remaining.delete(key);
    }
  }

  for (const key of [...remaining].sort()) {
    out[key] = data[key];
  }

  return out;
}

export function stringifyFrontmatter(
  body: string,
  data: Record<string, unknown>,
): string {
  // Keep source wikilinks and long identifiers byte-contiguous for downstream
  // text processors.
  const yaml = YAML.stringify(data, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${body}`;
}

export function refreshUpdatedDate(
  data: Record<string, unknown>,
  updatedDate: string | null,
): Record<string, unknown> {
  if (updatedDate === null) return data;

  const current = dateOnly(data["updated"]);
  if (current === null) return data;
  if (daysBetween(current, updatedDate) <= MAX_UPDATED_DRIFT_DAYS) return data;

  return { ...data, updated: updatedDate };
}

export function updatedDateDriftsFrom(
  data: Record<string, unknown>,
  expectedDate: string | null,
): boolean {
  if (expectedDate === null) return false;
  const current = dateOnly(data["updated"]);
  if (current === null) return false;
  return daysBetween(current, expectedDate) > MAX_UPDATED_DRIFT_DAYS;
}

export function frontmatterKeyLine(content: string, key: string): number | null {
  if (!content.startsWith("---")) return null;
  const lines = content.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "---" || line.trim() === "...") return null;
    if (new RegExp(`^\\s*${escapeRegExp(key)}\\s*:`).test(line)) return i + 1;
  }
  return null;
}

function matterFileIsEmpty(file: matter.GrayMatterFile<string>): boolean {
  return (file as matter.GrayMatterFile<string> & { readonly isEmpty?: boolean })
    .isEmpty === true;
}

function normalizeYamlScalars(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = normalizeYamlScalar(value);
  }
  return out;
}

function normalizeYamlScalar(value: unknown): unknown {
  if (value instanceof Date) return formatYamlDate(value);
  if (Array.isArray(value)) return value.map((item) => normalizeYamlScalar(item));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = normalizeYamlScalar(nested);
    }
    return out;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function formatYamlDate(value: Date): string {
  if (
    value.getUTCHours() === 0 &&
    value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 &&
    value.getUTCMilliseconds() === 0
  ) {
    return value.toISOString().slice(0, 10);
  }
  return value.toISOString();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
