// dome.graph.tag-index — Phase 13b adoption-phase processor.
//
// Extracts tag facts from changed markdown pages. Frontmatter parsing uses
// gray-matter, matching the markdown bundle's existing parser boundary; inline
// `#tag` extraction is small Dome-domain logic rather than a generic markdown
// parser. Malformed YAML and invalid `tags:` shapes are lint-frontmatter's
// responsibility, so this processor skips them instead of emitting diagnostics.

import matter from "gray-matter";

import {
  factEffect,
  type Effect,
  type FactEffect,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";

const PREDICATE = "dome.graph.tagged";
const REQUIRED_NAMESPACE_PREFIX = "dome.graph.";

const TAG_VALUE_RE = /^[A-Za-z][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/;
const INLINE_TAG_RE = /(^|[^A-Za-z0-9_/-])#([A-Za-z][A-Za-z0-9_/-]*)(?=$|[^A-Za-z0-9_/-])/g;

const graphTagIndex: Processor = defineProcessor({
  id: "dome.graph.tag-index",
  version: "0.1.0",
  phase: "adoption",
  triggers: [
    { kind: "signal", name: "document.changed" },
    { kind: "signal", name: "file.created" },
  ],
  capabilities: [
    { kind: "read", paths: ["**/*.md"] },
    { kind: "graph.write", namespaces: ["dome.graph.*"] },
  ],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    if (!PREDICATE.startsWith(REQUIRED_NAMESPACE_PREFIX)) {
      throw new Error(
        `dome.graph.tag-index: predicate '${PREDICATE}' does not start with the declared namespace prefix '${REQUIRED_NAMESPACE_PREFIX}'`,
      );
    }

    const facts: FactEffect[] = [];
    const changedMarkdown = ctx.changedPaths.filter((p) => p.endsWith(".md"));

    for (const path of changedMarkdown) {
      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;

      const tags = extractTags(content, (line, startChar, endChar) =>
        ctx.sourceRef(path, { startLine: line, endLine: line, startChar, endChar }),
      );

      for (const tag of tags) {
        facts.push(
          factEffect({
            subject: { kind: "page", path },
            predicate: PREDICATE,
            object: { kind: "string", value: tag.value },
            assertion: "extracted",
            sourceRefs: [tag.sourceRef],
          }),
        );
      }
    }

    return facts;
  },
});

export default graphTagIndex;

type ExtractedTag = {
  readonly value: string;
  readonly sourceRef: SourceRef;
};

function extractTags(
  content: string,
  refForLine: (line: number, startChar?: number, endChar?: number) => SourceRef,
): ReadonlyArray<ExtractedTag> {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch {
    return [];
  }

  const byTag = new Map<string, SourceRef>();
  const tagsLine = frontmatterKeyLine(content, "tags") ?? 1;

  const frontmatterTags = parsed.data["tags"];
  if (Array.isArray(frontmatterTags)) {
    for (const raw of frontmatterTags) {
      const tag = normalizeTag(raw);
      if (tag !== null && !byTag.has(tag)) {
        byTag.set(tag, refForLine(tagsLine));
      }
    }
  }

  const bodyStartLine = markdownBodyStartLine(content);
  for (const tag of extractInlineTags(parsed.content, bodyStartLine, refForLine)) {
    if (!byTag.has(tag.value)) {
      byTag.set(tag.value, tag.sourceRef);
    }
  }

  return Object.freeze(
    [...byTag.entries()].map(([value, sourceRef]) => ({ value, sourceRef })),
  );
}

function normalizeTag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^#/, "");
  if (!TAG_VALUE_RE.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

function extractInlineTags(
  body: string,
  startLine: number,
  refForLine: (line: number, startChar?: number, endChar?: number) => SourceRef,
): ReadonlyArray<ExtractedTag> {
  const out: ExtractedTag[] = [];
  const lines = body.split(/\r?\n/);
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const original = lines[i] ?? "";
    const trimmed = original.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const line = maskHeadingMarker(original);
    INLINE_TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INLINE_TAG_RE.exec(line)) !== null) {
      const raw = match[2];
      const tag = normalizeTag(raw);
      if (tag === null) continue;
      const prefix = match[1] ?? "";
      const startChar = match.index + prefix.length;
      const endChar = startChar + 1 + raw.length;
      out.push({
        value: tag,
        sourceRef: refForLine(startLine + i, startChar, endChar),
      });
    }
  }

  return Object.freeze(out);
}

function maskHeadingMarker(line: string): string {
  const match = /^(#{1,6})\s+/.exec(line);
  if (match === null) return line;
  return " ".repeat(match[0].length) + line.slice(match[0].length);
}

function markdownBodyStartLine(content: string): number {
  if (!content.startsWith("---")) return 1;
  const lines = content.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (line === "---" || line === "...") return i + 2;
  }
  return 1;
}

function frontmatterKeyLine(content: string, key: string): number | null {
  if (!content.startsWith("---")) return null;
  const lines = content.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed === "---" || trimmed === "...") return null;
    if (new RegExp(`^${key}\\s*:`).test(trimmed)) return i + 1;
  }
  return null;
}
