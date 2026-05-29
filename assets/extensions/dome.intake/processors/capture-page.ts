import { createHash } from "node:crypto";

import matter from "gray-matter";
import { z } from "zod";

import type { CaptureLowConfidenceKind } from "./low-confidence-shared";

export type CapturePageItemKind = CaptureLowConfidenceKind | "source_quote";

export type CapturePageItem = {
  readonly kind: CapturePageItemKind;
  readonly text: string;
  readonly confidence: number;
};

const CapturePageItemSchema = z
  .object({
    kind: z.enum(["task", "followup", "decision", "entity", "source_quote"]),
    text: z
      .string()
      .transform((value) => value.trim())
      .refine((value) => value.length > 0),
    confidence: z.number().min(0).max(1),
  })
  .strict();
const CapturePageItemsSchema = z.array(CapturePageItemSchema);

export function captureOutputPaths(path: string): {
  readonly generated: string;
  readonly archive: string;
} {
  const basename = path.split("/").at(-1) ?? "capture.md";
  const stem = basename.replace(/\.md$/i, "");
  const slug = slugify(stem) || "capture";
  const digest = createHash("sha256").update(path).digest("hex").slice(0, 12);
  const name = `${slug}-${digest}.md`;
  return Object.freeze({
    generated: `wiki/generated/intake/${name}`,
    archive: `inbox/processed/${name}`,
  });
}

export function renderTrackedCaptureItem(input: {
  readonly kind: CapturePageItemKind;
  readonly text: string;
}): string {
  switch (input.kind) {
    case "task":
      return `- [ ] ${input.text}`;
    case "followup":
      return `- [ ] #followup ${input.text}`;
    case "decision":
      return `- ${input.text}`;
    case "entity":
      return `- ${input.text}`;
    case "source_quote":
      return `> ${input.text}`;
  }
}

export function insertTrackedCaptureItem(input: {
  readonly content: string;
  readonly kind: CaptureLowConfidenceKind;
  readonly text: string;
  readonly confidence: number;
}): string {
  const body = insertTrackedCaptureBodyItem(input);
  return upsertCapturePageItem(body, {
    kind: input.kind,
    text: input.text,
    confidence: input.confidence,
  });
}

export function capturePageItemsFromFrontmatter(
  value: unknown,
): ReadonlyArray<CapturePageItem> | null {
  if (value === undefined) return Object.freeze([]);
  const parsed = CapturePageItemsSchema.safeParse(value);
  if (!parsed.success) return null;
  return Object.freeze(
    parsed.data.map((item) =>
      Object.freeze({
        kind: item.kind,
        text: item.text,
        confidence: item.confidence,
      }),
    ),
  );
}

export function renderIntakeItemsFrontmatter(
  items: ReadonlyArray<CapturePageItem>,
): ReadonlyArray<string> {
  if (items.length === 0) return Object.freeze([]);
  return Object.freeze([
    "intake_items:",
    ...items.flatMap((item) => [
      `  - kind: ${item.kind}`,
      `    text: ${yamlString(item.text)}`,
      `    confidence: ${formatConfidence(item.confidence)}`,
    ]),
  ]);
}

export function capturePageItemLine(input: CapturePageItem): string {
  return renderTrackedCaptureItem(input);
}

export function lineForCapturePageItem(
  content: string,
  item: CapturePageItem,
): number {
  const expected = capturePageItemLine(item);
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim() === expected);
  return index === -1 ? 1 : index + 1;
}

function insertTrackedCaptureBodyItem(input: {
  readonly content: string;
  readonly kind: CaptureLowConfidenceKind;
  readonly text: string;
}): string {
  const itemLine = renderTrackedCaptureItem(input);
  const trimmed = input.content.trimEnd();
  const lines = trimmed.length === 0 ? [] : trimmed.split(/\r?\n/);
  if (lines.some((line) => line.trim() === itemLine)) {
    return `${trimmed}\n`;
  }

  const heading = headingForKind(input.kind);
  const headingIndex = lines.findIndex((line) => line.trim() === heading);
  if (headingIndex === -1) {
    insertMissingSection(lines, input.kind, heading, itemLine);
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const nextHeadingIndex = lines.findIndex(
    (line, index) => index > headingIndex && /^##\s+/.test(line),
  );
  const sectionEnd =
    nextHeadingIndex === -1 ? lines.length : nextHeadingIndex;
  let insertionIndex = sectionEnd;
  while (
    insertionIndex > headingIndex + 1 &&
    lines[insertionIndex - 1]?.trim() === ""
  ) {
    insertionIndex -= 1;
  }

  const inserted =
    insertionIndex === headingIndex + 1 ? ["", itemLine] : [itemLine];
  if (nextHeadingIndex !== -1) inserted.push("");
  lines.splice(insertionIndex, 0, ...inserted);
  return `${lines.join("\n").trimEnd()}\n`;
}

function upsertCapturePageItem(
  content: string,
  item: CapturePageItem,
): string {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch {
    return content;
  }
  const existing =
    capturePageItemsFromFrontmatter(parsed.data.intake_items) ??
    Object.freeze([]);
  if (
    existing.some(
      (existingItem) =>
        existingItem.kind === item.kind && existingItem.text === item.text,
    )
  ) {
    return content;
  }

  const data = reorderCaptureFrontmatter({
    ...parsed.data,
    intake_items: [...existing, item],
  });
  return `${matter.stringify(parsed.content, data).trimEnd()}\n`;
}

function reorderCaptureFrontmatter(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const order = [
    "type",
    "id",
    "aliases",
    "tags",
    "created",
    "updated",
    "sources",
  ];
  const remaining = new Set(Object.keys(data));
  for (const key of order) {
    if (!remaining.has(key)) continue;
    out[key] = data[key];
    remaining.delete(key);
  }
  for (const key of [...remaining].sort()) {
    out[key] = data[key];
  }
  return out;
}

function headingForKind(kind: CaptureLowConfidenceKind): string {
  switch (kind) {
    case "task":
      return "## Tasks";
    case "followup":
      return "## Follow-ups";
    case "decision":
      return "## Decisions";
    case "entity":
      return "## Entities";
  }
}

function insertMissingSection(
  lines: string[],
  kind: CaptureLowConfidenceKind,
  heading: string,
  itemLine: string,
): void {
  const nextKnownSection = lines.findIndex((line) => {
    const nextOrder = orderForHeading(line.trim());
    return nextOrder !== null && nextOrder > kindOrder(kind);
  });
  if (nextKnownSection === -1) {
    if (lines.length > 0 && lines.at(-1)?.trim() !== "") lines.push("");
    lines.push(heading, "", itemLine);
    return;
  }

  let insertionIndex = nextKnownSection;
  while (
    insertionIndex > 0 &&
    lines[insertionIndex - 1]?.trim() === ""
  ) {
    insertionIndex -= 1;
  }
  const inserted =
    insertionIndex === 0 ? [heading, "", itemLine, ""] : ["", heading, "", itemLine, ""];
  lines.splice(insertionIndex, 0, ...inserted);
}

function orderForHeading(heading: string): number | null {
  switch (heading) {
    case "## Tasks":
      return 0;
    case "## Follow-ups":
      return 1;
    case "## Decisions":
      return 2;
    case "## Entities":
      return 3;
    case "## Source Quotes":
      return 4;
    default:
      return null;
  }
}

function kindOrder(kind: CaptureLowConfidenceKind): number {
  switch (kind) {
    case "task":
      return 0;
    case "followup":
      return 1;
    case "decision":
      return 2;
    case "entity":
      return 3;
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function formatConfidence(confidence: number): string {
  return Number.isInteger(confidence) ? String(confidence) : String(confidence);
}
