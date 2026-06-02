// dome.markdown.simplify-indexes — maintain small obvious wiki index pages.
//
// This is intentionally conservative. It only updates existing
// `wiki/**/index.md` pages, only lists direct child pages, and only for small
// directories. Human prose stays outside the managed block.

import { posix } from "node:path";

import matter from "gray-matter";

import {
  patchEffect,
  type Effect,
  type FileChangeInput,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";

const INDEX_BLOCK_START = "<!-- dome:index:start -->";
const INDEX_BLOCK_END = "<!-- dome:index:end -->";
const MIN_CHILDREN = 2;
const MAX_CHILDREN = 50;
const MAX_INDEXES_PER_RUN = 50;
const SKIPPED_INDEX_PREFIXES = [
  "wiki/dailies/",
  "wiki/generated/",
  "wiki/sources/",
  "wiki/syntheses/",
] as const;

const simplifyIndexes = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const markdownPaths = await ctx.snapshot.listMarkdownFiles();
    const indexPaths = markdownPaths
      .filter(isSimplifiableIndexPath)
      .sort()
      .slice(0, MAX_INDEXES_PER_RUN);

    const changes: FileChangeInput[] = [];
    const sourceRefs: SourceRef[] = [];
    for (const indexPath of indexPaths) {
      const indexContent = await ctx.snapshot.readFile(indexPath);
      if (indexContent === null) continue;

      const children = await directChildrenForIndex(ctx, markdownPaths, indexPath);
      if (children.length < MIN_CHILDREN || children.length > MAX_CHILDREN) {
        continue;
      }

      const block = renderIndexBlock(children);
      const next = upsertIndexBlock(indexContent, block);
      if (next === null || next === indexContent) continue;

      changes.push({ kind: "write", path: indexPath, content: next });
      sourceRefs.push(
        ctx.sourceRef(indexPath, { startLine: 1, endLine: 1 }),
        ...children.map((child) =>
          ctx.sourceRef(child.path, { startLine: 1, endLine: 1 })
        ),
      );
    }

    if (changes.length === 0) return Object.freeze([]);
    return [
      patchEffect({
        mode: "auto",
        changes,
        reason: "dome.markdown: simplify small wiki index pages",
        sourceRefs,
      }),
    ];
  },
});

export default simplifyIndexes;

type IndexChild = {
  readonly path: string;
  readonly label: string;
};

async function directChildrenForIndex(
  ctx: ProcessorContext,
  markdownPaths: ReadonlyArray<string>,
  indexPath: string,
): Promise<ReadonlyArray<IndexChild>> {
  const dir = posix.dirname(indexPath);
  const prefix = dir === "." ? "" : `${dir}/`;
  const children: IndexChild[] = [];
  for (const path of markdownPaths) {
    if (path === indexPath) continue;
    if (!path.startsWith(prefix)) continue;
    const relative = path.slice(prefix.length);
    if (relative.length === 0 || relative.includes("/")) continue;
    if (!isCanonicalWikiPage(path)) continue;
    const content = await ctx.snapshot.readFile(path);
    if (content === null) continue;
    children.push({
      path,
      label: titleForPage(path, content),
    });
  }
  return Object.freeze(
    children.sort((a, b) => {
      const label = a.label.localeCompare(b.label);
      return label === 0 ? a.path.localeCompare(b.path) : label;
    }),
  );
}

function isSimplifiableIndexPath(path: string): boolean {
  if (!path.endsWith("/index.md") && path !== "wiki/index.md") return false;
  if (!path.startsWith("wiki/")) return false;
  return !SKIPPED_INDEX_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function isCanonicalWikiPage(path: string): boolean {
  if (!path.startsWith("wiki/") || !path.endsWith(".md")) return false;
  if (path.endsWith("/index.md") || path === "wiki/index.md") return false;
  return !SKIPPED_INDEX_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function titleForPage(path: string, content: string): string {
  try {
    const parsed = matter(content);
    const frontmatterTitle = stringField(parsed.data.name) ??
      stringField(parsed.data.title);
    if (frontmatterTitle !== null) return frontmatterTitle;
    const heading = firstH1(parsed.content);
    if (heading !== null) return heading;
  } catch {
    // Fall back to the path stem below; malformed frontmatter should not make
    // index maintenance noisy.
  }
  return titleFromPath(path);
}

function stringField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function firstH1(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match === null) continue;
    const title = match[1]?.trim() ?? "";
    return title.length === 0 ? null : title;
  }
  return null;
}

function titleFromPath(path: string): string {
  return posix
    .basename(path, ".md")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b[a-z]/g, (match) => match.toUpperCase());
}

function renderIndexBlock(children: ReadonlyArray<IndexChild>): string {
  return [
    INDEX_BLOCK_START,
    ...children.map((child) => `- ${wikilink(child)}`),
    INDEX_BLOCK_END,
  ].join("\n");
}

function wikilink(child: IndexChild): string {
  const target = child.path.replace(/\.md$/i, "");
  return `[[${target}|${child.label}]]`;
}

function upsertIndexBlock(content: string, block: string): string | null {
  const existing = existingBlockRange(content);
  if (existing !== null) {
    return `${content.slice(0, existing.start)}${block}${content.slice(existing.end)}`;
  }
  if (content.includes(INDEX_BLOCK_START) || content.includes(INDEX_BLOCK_END)) {
    return null;
  }

  const trimmed = content.trimEnd();
  const lines = trimmed.length === 0 ? [] : trimmed.split(/\r?\n/);
  const section = pagesSectionRange(lines);
  if (section === null) {
    return `${trimmed}\n\n## Pages\n\n${block}\n`;
  }

  const insertionIndex = trimBlankLinesBefore(lines, section.end);
  const inserted = section.end === lines.length ? ["", block] : ["", block, ""];
  lines.splice(insertionIndex, 0, ...inserted);
  return `${lines.join("\n").trimEnd()}\n`;
}

function existingBlockRange(
  content: string,
): { readonly start: number; readonly end: number } | null {
  const start = content.indexOf(INDEX_BLOCK_START);
  if (start === -1) return null;
  const end = content.indexOf(INDEX_BLOCK_END, start);
  if (end === -1) return null;
  return {
    start,
    end: end + INDEX_BLOCK_END.length,
  };
}

function pagesSectionRange(
  lines: ReadonlyArray<string>,
): { readonly heading: number; readonly end: number } | null {
  const heading = lines.findIndex((line) => /^##\s+(Pages|Index)\s*$/i.test(line));
  if (heading === -1) return null;
  const nextHeading = lines.findIndex(
    (line, index) => index > heading && /^##\s+\S/.test(line),
  );
  return {
    heading,
    end: nextHeading === -1 ? lines.length : nextHeading,
  };
}

function trimBlankLinesBefore(
  lines: ReadonlyArray<string>,
  index: number,
): number {
  let cursor = index;
  while (cursor > 0 && lines[cursor - 1]?.trim() === "") cursor -= 1;
  return cursor;
}
