// dome.markdown.duplicate-detection — Phase 13b adoption-phase processor.
//
// Emits a QuestionEffect when a changed markdown page appears to duplicate an
// existing page. The heuristic is intentionally conservative for v1: normalized
// title AND normalized first paragraph must match. Fuzzy similarity can come
// later behind an explicit library/substrate choice; this processor's job is to
// make the question channel useful without adding a probabilistic dependency.

import { createHash } from "node:crypto";
import { posix } from "node:path";

import matter from "gray-matter";

import {
  questionEffect,
  type Effect,
  type QuestionEffect,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";

const duplicateDetection: Processor = defineProcessor({
  id: "dome.markdown.duplicate-detection",
  version: "0.1.0",
  phase: "adoption",
  triggers: [
    { kind: "signal", name: "document.changed" },
    { kind: "signal", name: "file.created" },
  ],
  capabilities: [
    { kind: "read", paths: ["**/*.md"] },
    { kind: "question.ask" },
  ],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const allMarkdown = await ctx.snapshot.listMarkdownFiles();
    const allPages = await readComparablePages(ctx, allMarkdown);
    const byPath = new Map(allPages.map((page) => [page.path, page]));
    const byTitle = groupByTitle(allPages);
    const changedMarkdown = ctx.changedPaths.filter((p) => p.endsWith(".md"));
    const emittedPairs = new Set<string>();
    const questions: QuestionEffect[] = [];

    for (const changedPath of changedMarkdown) {
      const changed = byPath.get(changedPath);
      if (changed === undefined) continue;

      for (const other of byTitle.get(changed.title) ?? []) {
        if (other.path === changed.path) continue;
        if (!sameSignature(changed, other)) continue;

        const pairKey = orderedPairKey(changed.path, other.path);
        if (emittedPairs.has(pairKey)) continue;
        emittedPairs.add(pairKey);

        questions.push(
          questionEffect({
            question:
              `Possible duplicate pages: ${changed.path} and ${other.path}. ` +
              "They have the same normalized title and first paragraph.",
            options: ["merge", "keep separate"],
            sourceRefs: [changed.sourceRef, other.sourceRef],
            idempotencyKey:
              `dome.markdown.duplicate-detection:${sha256(pairKey + ":" + changed.signature)}`,
          }),
        );
      }
    }

    return questions;
  },
});

export default duplicateDetection;

type ComparablePage = {
  readonly path: string;
  readonly title: string;
  readonly firstParagraph: string;
  readonly signature: string;
  readonly sourceRef: SourceRef;
};

async function readComparablePages(
  ctx: ProcessorContext,
  paths: ReadonlyArray<string>,
): Promise<ReadonlyArray<ComparablePage>> {
  const pages: ComparablePage[] = [];
  for (const path of paths) {
    const content = await ctx.snapshot.readFile(path);
    if (content === null) continue;
    const extracted = extractComparableText(path, content);
    if (extracted === null) continue;
    pages.push({
      path,
      title: extracted.title,
      firstParagraph: extracted.firstParagraph,
      signature: `${extracted.title}\n${extracted.firstParagraph}`,
      sourceRef: ctx.sourceRef(path, {
        startLine: extracted.sourceLine,
        endLine: extracted.sourceLine,
      }),
    });
  }
  return Object.freeze(pages);
}

function sameSignature(a: ComparablePage, b: ComparablePage): boolean {
  return a.title === b.title && a.firstParagraph === b.firstParagraph;
}

function groupByTitle(
  pages: ReadonlyArray<ComparablePage>,
): ReadonlyMap<string, ReadonlyArray<ComparablePage>> {
  const groups = new Map<string, ComparablePage[]>();
  for (const page of pages) {
    const group = groups.get(page.title);
    if (group === undefined) {
      groups.set(page.title, [page]);
    } else {
      group.push(page);
    }
  }
  return groups;
}

type ExtractedComparableText = {
  readonly title: string;
  readonly firstParagraph: string;
  readonly sourceLine: number;
};

function extractComparableText(
  path: string,
  content: string,
): ExtractedComparableText | null {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch {
    return null;
  }

  const bodyStartLine = markdownBodyStartLine(content);
  const lines = parsed.content.split(/\r?\n/);
  let title = normalizeFrontmatterTitle(parsed.data["title"]);
  let titleLine = 1;
  for (let i = 0; i < lines.length; i++) {
    const match = /^#\s+(.+?)\s*$/.exec(lines[i] ?? "");
    if (match === null) continue;
    if (title === null) {
      title = normalizeText(match[1] ?? "");
      titleLine = bodyStartLine + i;
    }
    break;
  }
  if (title === null) {
    title = normalizeText(posix.basename(path, ".md"));
  }
  if (title.length < 3) return null;

  const paragraph = firstParagraph(lines);
  if (paragraph === null) return null;
  const normalizedParagraph = normalizeText(paragraph.text);
  if (normalizedParagraph.length < 20) return null;

  return {
    title,
    firstParagraph: normalizedParagraph,
    sourceLine: Math.min(titleLine, bodyStartLine + paragraph.startIndex),
  };
}

function normalizeFrontmatterTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeText(value);
  return normalized.length === 0 ? null : normalized;
}

function markdownBodyStartLine(content: string): number {
  if (!content.startsWith("---")) return 1;
  const lines = content.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (line === "---" || line === "...") {
      return i + 2;
    }
  }
  return 1;
}

function firstParagraph(
  lines: ReadonlyArray<string>,
): { readonly text: string; readonly startIndex: number } | null {
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (
      inFence ||
      trimmed.length === 0 ||
      trimmed.startsWith("#") ||
      isListOrTableLine(trimmed)
    ) {
      continue;
    }

    const paragraphLines = [trimmed];
    for (let j = i + 1; j < lines.length; j++) {
      const next = (lines[j] ?? "").trim();
      if (next.length === 0 || next.startsWith("#") || isListOrTableLine(next)) break;
      paragraphLines.push(next);
    }
    return { text: paragraphLines.join(" "), startIndex: i };
  }
  return null;
}

function isListOrTableLine(line: string): boolean {
  return /^([-*+]\s+|\d+\.\s+|>\s*|\|)/.test(line);
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~>#]/g, " ")
    .replace(/[^\p{L}\p{N}/-]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function orderedPairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
