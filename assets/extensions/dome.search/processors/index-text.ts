// dome.search.index-text — adopted markdown FTS projection.
//
// This processor emits SearchDocumentEffect values only. The engine-owned
// projection sink performs the SQLite FTS write after search.write capability
// enforcement, so the bundle stays pure and rebuildable.
//
// Rows are heading-section granular (per [[wiki/specs/projection-store]]
// §"fts_documents" and [[wiki/specs/effects]] §SearchDocumentEffect): each
// page is split at H2 headings, the content before the first H2 (including
// the H1) is the `intro` section, sections longer than ~512 tokens are
// sub-split at paragraph boundaries, and every section's indexed body is
// prefixed with a `<page title> › <heading>` breadcrumb so heading terms
// match. For each changed page the processor emits one `delete` effect (so
// removed sections cannot linger) followed by one `upsert` per section;
// effects apply in emission order, and re-running on unchanged content emits
// the same sequence (idempotent re-index).

import { basename } from "node:path/posix";

import matter from "gray-matter";

import {
  searchDocumentEffect,
  type Effect,
  type SearchDocumentEffect,
} from "../../../../src/core/effect";
import { blankGeneratedBlocks } from "../../../../src/core/generated-block";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

// ~512 tokens approximated as chars/4 (per docs/memory.md §M1).
const MAX_SECTION_CHARS = 2_048;

const searchIndexText = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const effects: SearchDocumentEffect[] = [];
    const seen = new Set<string>();

    for (const path of ctx.changedPaths) {
      if (!path.endsWith(".md") || seen.has(path)) continue;
      seen.add(path);

      const content = await ctx.snapshot.readFile(path);
      if (content === null) {
        effects.push(
          searchDocumentEffect({
            operation: "delete",
            path,
            sourceRefs: [ctx.sourceRef(path)],
          }),
        );
        continue;
      }

      const doc = parseMarkdownDocument(path, content);
      // Clear the page's prior section set before inserting the new one —
      // a removed heading must not leave a stale row behind.
      effects.push(
        searchDocumentEffect({
          operation: "delete",
          path,
          sourceRefs: [ctx.sourceRef(path)],
        }),
      );
      for (const section of doc.sections) {
        effects.push(
          searchDocumentEffect({
            operation: "upsert",
            path,
            sectionId: section.id,
            breadcrumb: section.breadcrumb,
            category: doc.category,
            ...(doc.type !== null ? { type: doc.type } : {}),
            title: doc.title,
            body: `${section.breadcrumb}\n\n${section.body}`,
            sourceRefs: [
              ctx.sourceRef(path, {
                startLine: section.startLine,
                endLine: section.endLine,
              }),
            ],
          }),
        );
      }
    }

    return effects;
  },
});

export default searchIndexText;

// ----- Markdown parsing ------------------------------------------------------

type ParsedMarkdownDocument = {
  readonly category: string;
  readonly type: string | null;
  readonly title: string;
  readonly sections: ReadonlyArray<PageSection>;
};

export type PageSection = {
  /** Stable section id: heading slug, `-N` ordinal for duplicate headings,
   * `~N` suffix for sub-split continuation parts; `intro` for pre-first-H2
   * content. */
  readonly id: string;
  /** `<page title> › <heading>`; the page title alone for the intro. */
  readonly breadcrumb: string;
  readonly body: string;
  /** 1-indexed line range of the section within the original file. */
  readonly startLine: number;
  readonly endLine: number;
};

function parseMarkdownDocument(
  path: string,
  content: string,
): ParsedMarkdownDocument {
  let parsed: { readonly data: Record<string, unknown>; readonly content: string };
  try {
    parsed = matter(content);
  } catch {
    parsed = { data: {}, content };
  }

  const title = titleFor(path, parsed);
  // Line offset of the markdown body within the original file: gray-matter
  // strips frontmatter, so section source-ref ranges must be shifted by the
  // stripped line count for evidence anchoring.
  const bodyLineOffset =
    countLines(content) - countLines(parsed.content);

  return Object.freeze({
    category: categoryForPath(path),
    type: frontmatterString(parsed.data["type"]),
    title,
    sections: splitIntoSections({
      title,
      body: stripGeneratedSurfaceBlocks(parsed.content),
      lineOffset: bodyLineOffset,
    }),
  });
}

// ----- Section splitting -----------------------------------------------------

/**
 * Split a markdown body at H2 headings into breadcrumbed sections.
 *
 * - Content before the first H2 (including the H1) is the `intro` section.
 *   An empty body still yields the intro section so title-only pages stay
 *   searchable.
 * - `## ` lines inside fenced code blocks do not split.
 * - Sections longer than `MAX_SECTION_CHARS` are sub-split at paragraph
 *   boundaries; continuation parts share the breadcrumb and get a `~N`
 *   section-id suffix.
 * - Duplicate heading slugs get `-2`, `-3`, ... ordinals in document order.
 *
 * Exported for the splitter unit tests; the processor remains the only
 * production caller.
 */
export function splitIntoSections(input: {
  readonly title: string;
  readonly body: string;
  readonly lineOffset?: number;
}): ReadonlyArray<PageSection> {
  const lineOffset = input.lineOffset ?? 0;
  const lines = input.body.split("\n");

  type RawSection = {
    readonly heading: string | null; // null = intro
    readonly startLine: number; // 1-indexed within body
    lines: string[];
  };

  const rawSections: RawSection[] = [
    { heading: null, startLine: 1, lines: [] },
  ];
  let inFence = false;
  for (const [index, line] of lines.entries()) {
    if (isFenceDelimiter(line)) inFence = !inFence;
    const heading = !inFence ? h2HeadingText(line) : null;
    if (heading !== null) {
      rawSections.push({ heading, startLine: index + 1, lines: [line] });
      continue;
    }
    const current = rawSections[rawSections.length - 1];
    if (current !== undefined) current.lines.push(line);
  }

  const usedSlugs = new Map<string, number>();
  const sections: PageSection[] = [];
  for (const raw of rawSections) {
    const body = raw.lines.join("\n").trim();
    const isIntro = raw.heading === null;
    const slug = isIntro ? "intro" : slugify(raw.heading ?? "");
    const id = dedupeSlug(usedSlugs, slug);
    const breadcrumb = isIntro
      ? input.title
      : `${input.title} › ${raw.heading}`;
    const endLine = raw.startLine + Math.max(raw.lines.length - 1, 0);
    if (isIntro && body.length === 0 && rawSections.length > 1) {
      // Nothing before the first H2 — skip the empty intro row.
      continue;
    }
    sections.push(
      ...subSplitSection({
        id,
        breadcrumb,
        body,
        startLine: raw.startLine + lineOffset,
        endLine: endLine + lineOffset,
      }),
    );
  }

  return Object.freeze(sections);
}

/**
 * Sub-split an over-long section at paragraph boundaries (blank lines
 * outside code fences), greedily packing parts up to `MAX_SECTION_CHARS`.
 * Returns the section unchanged when it fits.
 */
function subSplitSection(section: PageSection): ReadonlyArray<PageSection> {
  if (section.body.length <= MAX_SECTION_CHARS) {
    return Object.freeze([Object.freeze(section)]);
  }

  type Paragraph = {
    readonly text: string;
    readonly startLine: number; // 1-indexed within section body
    readonly endLine: number;
  };

  const lines = section.body.split("\n");
  const paragraphs: Paragraph[] = [];
  let buffer: string[] = [];
  let bufferStart = 1;
  let inFence = false;
  const flush = (endLine: number): void => {
    const text = buffer.join("\n");
    if (text.trim().length > 0) {
      paragraphs.push({ text, startLine: bufferStart, endLine });
    }
    buffer = [];
  };
  for (const [index, line] of lines.entries()) {
    if (isFenceDelimiter(line)) inFence = !inFence;
    if (!inFence && line.trim().length === 0) {
      flush(index); // previous line index (0-based) == 1-based line - 1
      bufferStart = index + 2;
      continue;
    }
    buffer.push(line);
  }
  flush(lines.length);

  const parts: PageSection[] = [];
  let partParagraphs: Paragraph[] = [];
  let partChars = 0;
  const emitPart = (): void => {
    const first = partParagraphs[0];
    const last = partParagraphs[partParagraphs.length - 1];
    if (first === undefined || last === undefined) return;
    const ordinal = parts.length + 1;
    parts.push(Object.freeze({
      id: ordinal === 1 ? section.id : `${section.id}~${ordinal}`,
      breadcrumb: section.breadcrumb,
      body: partParagraphs.map((p) => p.text).join("\n\n"),
      startLine: section.startLine + first.startLine - 1,
      endLine: section.startLine + last.endLine - 1,
    }));
    partParagraphs = [];
    partChars = 0;
  };
  for (const paragraph of paragraphs) {
    if (
      partParagraphs.length > 0 &&
      partChars + paragraph.text.length > MAX_SECTION_CHARS
    ) {
      emitPart();
    }
    partParagraphs.push(paragraph);
    partChars += paragraph.text.length + 2;
  }
  emitPart();

  return parts.length === 0
    ? Object.freeze([Object.freeze(section)])
    : Object.freeze(parts);
}

/** A ``` or ~~~ fence delimiter line (optionally indented / info-stringed). */
function isFenceDelimiter(line: string): boolean {
  return /^\s{0,3}(?:```|~~~)/.test(line);
}

function h2HeadingText(line: string): string | null {
  const match = /^##\s+(.+?)\s*#*\s*$/.exec(line);
  const text = match?.[1]?.trim();
  return text !== undefined && text.length > 0 ? text : null;
}

/**
 * GitHub-flavored heading slug: lowercase, markdown/wikilink syntax reduced
 * to its display text, non-alphanumerics collapsed to single hyphens.
 */
function slugify(heading: string): string {
  const slug = heading
    .toLowerCase()
    // [[target|display]] → display; [[target]] → target
    .replace(/\[\[([^\[\]\|]+?)\|([^\[\]]+?)\]\]/g, "$2")
    .replace(/\[\[([^\[\]]+?)\]\]/g, "$1")
    // [text](url) → text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "section";
}

function dedupeSlug(used: Map<string, number>, slug: string): string {
  const count = used.get(slug) ?? 0;
  used.set(slug, count + 1);
  return count === 0 ? slug : `${slug}-${count + 1}`;
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

// ----- Page metadata ---------------------------------------------------------

/**
 * The daily-note PROJECTION blocks blanked before indexing — copies/digests
 * whose source of truth lives elsewhere, so indexing them would duplicate
 * settles and yesterday's sections in search results. `dome.daily:captured`
 * is deliberately NOT here: captured lines are origins, not copies — real
 * vault content ([[wiki/specs/daily-surface]] §"The `captured` block holds
 * origins, not copies").
 */
const STRIPPED_SURFACE_BLOCKS: ReadonlyArray<{
  readonly owner: string;
  readonly block: string;
}> = Object.freeze([
  Object.freeze({ owner: "dome.daily", block: "open-loops" }),
  Object.freeze({ owner: "dome.daily", block: "carried-forward" }),
  Object.freeze({ owner: "dome.daily", block: "close" }),
  Object.freeze({ owner: "dome.agent.brief", block: "yesterday" }),
]);

function stripGeneratedSurfaceBlocks(content: string): string {
  // Blank (don't remove) every line of each generated region so section
  // line ranges keep pointing at the right lines of the original file. The
  // core grammar primitive's scanner blanks every line-anchored pair —
  // including smuggled duplicate pairs, which must equally not be indexed.
  return STRIPPED_SURFACE_BLOCKS.reduce(
    (text, { owner, block }) => blankGeneratedBlocks(text, owner, block),
    content,
  );
}

function categoryForPath(path: string): string {
  const first = path.split("/")[0] ?? "";
  switch (first) {
    case "wiki":
    case "notes":
    case "inbox":
    case "raw":
      return first;
    default:
      return "other";
  }
}

function titleFor(
  path: string,
  parsed: { readonly data: Record<string, unknown>; readonly content: string },
): string {
  const explicit = frontmatterString(parsed.data["title"]);
  if (explicit !== null) return explicit;

  const heading = /^#\s+(.+)$/m.exec(parsed.content)?.[1]?.trim();
  if (heading !== undefined && heading.length > 0) return heading;

  const base = basename(path, ".md").replace(/[-_]+/g, " ").trim();
  return base.length > 0 ? base : path;
}

function frontmatterString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
