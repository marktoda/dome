// dome.agent — proposeSplit validation: pure, deterministic checking for the
// consolidate agent's page-split proposals (stock-gardening phase 1, Task 5).
// The tool (consolidate-tools.ts) wraps this with the injected VaultReader
// for existence checks (hub must exist, sub-pages must not); this module
// stays a pure function of its two string/struct inputs — no fs/sqlite
// imports, no reader — per the processor-purity fence.
//
// The load-bearing check is LOSSLESS LINE ACCOUNTING: every non-empty
// trimmed line of the original page's body (frontmatter and known
// regenerated blocks excluded) must appear verbatim in the hub or at least
// one sub-page. The hub/sub-pages may ADD lines (summaries, links, fresh
// frontmatter) but may never LOSE one — a split that silently drops content
// is worse than no split at all.

import { basename, dirname } from "node:path/posix";

import { blankGeneratedBlocks } from "../../../../src/core/generated-block";
import { wikilinkSlugs } from "../../../../src/core/wikilink";

export type SplitProposalInput = {
  readonly hubPath: string;
  readonly hubContent: string;
  readonly subPages: ReadonlyArray<{ readonly path: string; readonly content: string }>;
  readonly reason: string;
};

export const MAX_SPLIT_SUB_PAGES = 6;
export const MIN_SPLIT_SUB_PAGES = 2;

export type SplitValidationError = { readonly code: string; readonly message: string };

/**
 * Generated blocks that can legitimately appear inside a page under split —
 * DERIVED digests regenerated from other adopted state (claim facts, active
 * projects, the markdown index catalog), not content a split could "lose".
 * Excluded from lossless line-accounting via the core grammar primitive's
 * `blankGeneratedBlocks` scan, one call per known `(owner, block)` pair —
 * the same local-list convention `dome.search`'s `index-text.ts` uses for
 * `STRIPPED_SURFACE_BLOCKS` (a curated list, not a cross-bundle import of
 * each owning bundle's private constants).
 */
const KNOWN_GENERATED_BLOCKS: ReadonlyArray<{
  readonly owner: string;
  readonly block: string;
}> = Object.freeze([
  Object.freeze({ owner: "dome.claims", block: "current-facts" }),
  Object.freeze({ owner: "dome.agent", block: "active-projects" }),
  Object.freeze({ owner: "dome.markdown", block: "index-catalog" }),
]);

/**
 * Strip a leading `---`…`---` frontmatter fence, mirroring the parsing
 * posture of `dome.claims.render-facts`'s `insertionOffset` (a leading
 * `---` line closed by the next `---` line). An unterminated fence degrades
 * to "no frontmatter" rather than crashing — the check that follows only
 * gets stricter (more body lines to account for), never silently lax.
 */
function stripFrontmatter(content: string): string {
  const lines = content.split("\n");
  if ((lines[0] ?? "").trim() !== "---") return content;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? "").trim() === "---") {
      return lines.slice(i + 1).join("\n");
    }
  }
  return content;
}

/** The frontmatter block's raw lines (between the fences), or null when absent/unterminated. */
function frontmatterBlock(content: string): string | null {
  const lines = content.split("\n");
  if ((lines[0] ?? "").trim() !== "---") return null;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? "").trim() === "---") {
      return lines.slice(1, i).join("\n");
    }
  }
  return null;
}

/** Blank every KNOWN generated-block region so its regenerated body never
 * counts as original content the split could lose. */
function stripKnownGeneratedBlocks(content: string): string {
  return KNOWN_GENERATED_BLOCKS.reduce(
    (text, { owner, block }) => blankGeneratedBlocks(text, owner, block),
    content,
  );
}

function nonEmptyTrimmedLines(content: string): ReadonlyArray<string> {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Multiset of trimmed lines, so a line repeated N times in the original
 * must be matched N times across the hub + sub-pages, not just once. */
function lineCounts(lines: ReadonlyArray<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

const DESCRIPTION_LINE_RE = /^description:\s*\S/m;

/**
 * null = valid. See the module doc for the lossless-accounting rule. Checks
 * run cheapest-first: shape (extension, count, directory) before the O(n)
 * line-accounting pass, then the wikilink/frontmatter checks. Returns the
 * FIRST failing check.
 */
export function validateSplitProposal(
  input: SplitProposalInput,
  original: string,
): SplitValidationError | null {
  if (!input.hubPath.endsWith(".md")) {
    return {
      code: "hub-not-markdown",
      message: `hubPath must end in .md, got ${input.hubPath}`,
    };
  }

  if (
    input.subPages.length < MIN_SPLIT_SUB_PAGES ||
    input.subPages.length > MAX_SPLIT_SUB_PAGES
  ) {
    return {
      code: "sub-page-count",
      message: `a split needs ${MIN_SPLIT_SUB_PAGES}..${MAX_SPLIT_SUB_PAGES} sub-pages, got ${input.subPages.length}`,
    };
  }

  const hubDir = dirname(input.hubPath);
  for (const sub of input.subPages) {
    if (!sub.path.endsWith(".md")) {
      return {
        code: "sub-page-not-markdown",
        message: `sub-page path must end in .md, got ${sub.path}`,
      };
    }
    if (dirname(sub.path) !== hubDir) {
      return {
        code: "sub-page-wrong-directory",
        message: `sub-page ${sub.path} must live under the hub's directory (${hubDir}/), not ${dirname(sub.path)}/`,
      };
    }
  }

  const originalBody = stripKnownGeneratedBlocks(stripFrontmatter(original));
  const originalLines = nonEmptyTrimmedLines(originalBody);
  const available = lineCounts([
    ...nonEmptyTrimmedLines(input.hubContent),
    ...input.subPages.flatMap((sub) => nonEmptyTrimmedLines(sub.content)),
  ]);
  let missing = 0;
  let firstMissing: string | null = null;
  for (const line of originalLines) {
    const count = available.get(line) ?? 0;
    if (count <= 0) {
      missing += 1;
      if (firstMissing === null) firstMissing = line;
      continue;
    }
    available.set(line, count - 1);
  }
  if (missing > 0) {
    return {
      code: "lossy-split",
      message:
        `split loses ${missing} line(s) from the original page — every original ` +
        `line must land in the hub or a sub-page; first missing: ${JSON.stringify(firstMissing)}`,
    };
  }

  const hubSlugs = new Set(wikilinkSlugs(input.hubContent));
  for (const sub of input.subPages) {
    const slug = basename(sub.path, ".md");
    if (!hubSlugs.has(slug)) {
      return {
        code: "missing-hub-wikilink",
        message: `hubContent must link every sub-page as a [[wikilink]]; missing a link to ${sub.path} (slug ${slug})`,
      };
    }
  }

  for (const sub of input.subPages) {
    const fm = frontmatterBlock(sub.content);
    if (fm === null || !DESCRIPTION_LINE_RE.test(fm)) {
      return {
        code: "sub-page-missing-description",
        message: `sub-page ${sub.path} must carry frontmatter with a description: line`,
      };
    }
  }

  return null;
}
