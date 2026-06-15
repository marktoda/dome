// dome.markdown.broken-images — Phase 13b adoption-phase processor.
//
// Scans changed markdown pages for local image references and emits a warning
// when the target image does not exist in the candidate snapshot. Markdown
// parsing is intentionally narrow: the repo does not ship a markdown AST parser,
// and this processor only needs image references, not a full document model.

import { posix } from "node:path";

import {
  diagnosticEffect,
  type DiagnosticEffect,
  type Effect,
} from "../../../../src/core/effect";
import { canonicalVaultPath } from "../../../../src/core/vault-path";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import { positionAt } from "../lib/position";

const CODE_BROKEN_IMAGE = "dome.markdown.broken-image";

const MARKDOWN_IMAGE_RE = /!\[[^\]\n]*\]\((<[^>\n]+>|[^)\s\n]+)(?:\s+[^)]*)?\)/g;
const OBSIDIAN_IMAGE_RE = /!\[\[([^\]\|\n]+)(?:\|[^\]\n]+)?\]\]/g;
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".avif",
]);

const brokenImages = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const diagnostics: DiagnosticEffect[] = [];
    const changedMarkdown = ctx.changedPaths.filter((p) => p.endsWith(".md"));
    const touchedImage = ctx.changedPaths.some(isImagePath);
    const markdownPaths = touchedImage
      ? await ctx.snapshot.listMarkdownFiles()
      : changedMarkdown;

    for (const path of markdownPaths) {
      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;

      for (const ref of findImageRefs(content)) {
        const resolved = resolveImagePath(path, ref.target);
        if (resolved === null) continue;
        const found = await ctx.snapshot.readFile(resolved);
        if (found !== null) continue;

        diagnostics.push(
          diagnosticEffect({
            severity: "warning",
            code: CODE_BROKEN_IMAGE,
            message: `Image reference ${ref.target} resolves to missing vault path ${resolved}.`,
            sourceRefs: [
              ctx.sourceRef(path, {
                startLine: ref.line,
                endLine: ref.line,
                startChar: ref.startChar,
                endChar: ref.endChar,
              }),
            ],
          }),
        );
      }
    }

    return diagnostics;
  },
});

export default brokenImages;

type ImageRef = {
  readonly target: string;
  readonly line: number;
  readonly startChar: number;
  readonly endChar: number;
};

function findImageRefs(content: string): ReadonlyArray<ImageRef> {
  return Object.freeze([
    ...findRegexImageRefs(content, MARKDOWN_IMAGE_RE),
    ...findRegexImageRefs(content, OBSIDIAN_IMAGE_RE),
  ].sort((a, b) => a.line - b.line || a.startChar - b.startChar));
}

function findRegexImageRefs(
  content: string,
  regex: RegExp,
): ReadonlyArray<ImageRef> {
  const refs: ImageRef[] = [];
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const raw = match[1];
    if (raw === undefined) continue;
    const target = unwrapAngleTarget(raw.trim());
    if (target.length === 0 || isExternalTarget(target)) continue;
    const pos = positionAt(content, match.index);
    refs.push({
      target,
      line: pos.line,
      startChar: pos.col,
      endChar: pos.col + match[0].length,
    });
  }
  return Object.freeze(refs);
}

function unwrapAngleTarget(target: string): string {
  return target.startsWith("<") && target.endsWith(">")
    ? target.slice(1, -1).trim()
    : target;
}

function isExternalTarget(target: string): boolean {
  return (
    target.startsWith("#") ||
    /^[a-z][a-z0-9+.-]*:/i.test(target) ||
    target.startsWith("//")
  );
}

function resolveImagePath(markdownPath: string, target: string): string | null {
  const stripped = stripQueryAndHash(target);
  if (!hasImageExtension(stripped)) return null;
  const base = stripped.startsWith("/")
    ? stripped.slice(1)
    : posix.normalize(posix.join(posix.dirname(markdownPath), stripped));
  return canonicalVaultPath(base);
}

function stripQueryAndHash(target: string): string {
  const query = target.indexOf("?");
  const hash = target.indexOf("#");
  const stops = [query, hash].filter((i) => i >= 0);
  return stops.length === 0 ? target : target.slice(0, Math.min(...stops));
}

function hasImageExtension(path: string): boolean {
  return IMAGE_EXTENSIONS.has(posix.extname(path).toLowerCase());
}

function isImagePath(path: string): boolean {
  return hasImageExtension(path);
}

