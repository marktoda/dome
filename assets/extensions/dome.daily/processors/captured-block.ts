// captured-block.ts — captured tasks block helpers.
// Moved verbatim from daily-shared.ts; no logic changes.

import {
  containsGeneratedBlockMarker,
  containsHtmlCommentDelimiter,
  findGeneratedBlock,
  type GeneratedBlockRange,
} from "../../../../src/core/generated-block";
import {
  fencedCodeBlockLineRanges,
  frontmatterLineRange,
} from "../../../../src/core/markdown-scan";
import { parseBlockAnchor } from "../../../../src/core/block-anchor";

import {
  DAILY_OWNER,
  CAPTURED_BLOCK,
  CAPTURED_START,
  CAPTURED_END,
  CAPTURED_HEADING,
} from "./daily-types";
import {
  escapeRegExp,
} from "./daily-paths";
import {
  SOURCE_BACKED_SUFFIX_RE,
  isObsidianTasksDashboard,
  lineIsInsideRanges,
} from "./action-extraction";

// ----- Captured today (the live capture landing zone) -----------------------
//
// `## Captured today` hosts the `dome.daily:captured` block — the one
// generated block whose body holds task ORIGINS rather than projection
// copies. The skeleton renders it empty; the ingest tool seam splices
// validated task lines inside it; the extractors treat its contents like any
// other daily task line. Spec: [[wiki/specs/daily-surface]] §"Block
// ownership" and §"The `captured` block holds origins, not copies".

const CAPTURED_HEADING_RE = /^#{1,6}\s+captured\s+today\s*$/i;

/**
 * Per-line size cap for captured-task appends (chars). A captured line is a
 * one-line tactical task, not a document — the cap bounds what an agent can
 * pour through the seam in one line (mirroring the calendar parser's
 * MAX_TITLE_CHARS philosophy: untrusted-adjacent input gets bounded fields).
 * Normative at [[wiki/specs/daily-surface]] §"The ingest tool seam".
 */
export const CAPTURED_LINE_MAX_CHARS = 500;

/**
 * Per-append line-count cap for the captured seam. One ingest routing pass
 * lands a handful of tactical tasks, not a bulk import; the cap keeps a
 * runaway model turn from flooding today's daily in one tool call.
 * Normative at [[wiki/specs/daily-surface]] §"The ingest tool seam".
 */
export const CAPTURED_APPEND_MAX_LINES = 10;

/** U+2028 (LS) / U+2029 (PS) — line boundaries to JS `m`-flag regexes. */
const LS_PS_RE = /[\u2028\u2029]/;

/**
 * A line the ingest seam may land in the captured block: an open checkbox
 * task carrying the `#task`/`#followup` tag (the charter's required shape),
 * with no HTML comment delimiter (marker injection — the preferences-signals
 * strictness), no `(from [[…]])` suffix (a captured line is an ORIGIN; a
 * copy-shaped line would let reconcile treat it as a settled copy of some
 * other origin), no U+2028/U+2029 (JS `m`-flag heading-anchor regexes treat
 * LS/PS as line boundaries, so a smuggled `<U+2028>## Done<U+2028>` would become
 * a phantom insertion anchor for later heading-anchored splices), and at
 * most {@link CAPTURED_LINE_MAX_CHARS} chars.
 */
export function isCapturedTaskLine(line: string): boolean {
  if (line.length > CAPTURED_LINE_MAX_CHARS) return false;
  if (LS_PS_RE.test(line)) return false;
  if (!/^\s*[-*]\s+\[ \]\s+\S/.test(line)) return false;
  if (!/(^|\s)#(?:task|follow-?up)(?=\s|$)/i.test(line)) return false;
  if (containsHtmlCommentDelimiter(line)) return false;
  if (SOURCE_BACKED_SUFFIX_RE.test(line)) return false;
  return true;
}

/**
 * Detects an already-present inline origin marker by its opening syntax
 * `([↗](` — independent of the target's content, so idempotency holds even
 * when the target is an external URL that may contain `)`. Keyed on the `↗`
 * (U+2197) marker shape, never on the target.
 */
export const ORIGIN_MARKER_RE = /\(\[↗\]\(/;

/**
 * Stamp the inline task-origin marker ` ([↗](target))` onto a captured task
 * line, placed after the description and before any trailing block anchor (so
 * `dome.daily.stamp-block-id` / `normalize-task-syntax` keep the anchor as the
 * trailing token). Idempotent: a line already carrying a marker, or an empty
 * target, is returned unchanged. `target` is any string — a vault-relative
 * path (Phase 1) or an external URL (Phase 2) — so the seam serves both
 * origins with one grammar. Spec: [[wiki/specs/daily-surface]] §"The ingest
 * tool seam".
 * Callers passing a target that may contain `)` (a future external URL)
 * should percent-encode it first; vault paths never contain `)`.
 */
export function appendOriginMarker(line: string, target: string): string {
  if (target === "" || ORIGIN_MARKER_RE.test(line)) return line;
  const parsed = parseBlockAnchor(line);
  if (parsed !== null) {
    return `${parsed.withoutAnchor} ([↗](${target})) ^${parsed.id}`;
  }
  return `${line.trimEnd()} ([↗](${target}))`;
}

/**
 * Splice `lines` (caller-validated, e.g. via {@link isCapturedTaskLine})
 * inside the `dome.daily:captured` block, appending after any existing body.
 * Placement is insertion-anchored, never positional:
 *
 *  1. block present → insert immediately before the end marker;
 *  2. `## Captured today` heading present without a block → create the block
 *     directly under the heading;
 *  3. neither → create heading + block as the first content section (before
 *     `## Start Here`, falling back down the section ladder, then EOF).
 */
export function appendCapturedTaskLines(input: {
  readonly content: string;
  readonly lines: ReadonlyArray<string>;
}): string {
  if (input.lines.length === 0) return input.content;
  const block = capturedBlockRange(input.content);
  if (block !== null) {
    const body = `${input.lines.join("\n")}\n`;
    return `${input.content.slice(0, block.bodyEnd)}${body}${input.content.slice(block.bodyEnd)}`;
  }
  const section = [
    CAPTURED_START,
    ...input.lines,
    CAPTURED_END,
  ].join("\n");
  return insertCapturedSection({ content: input.content, section });
}

/**
 * The write-tool admission rule for today's daily (the `writePage` mirror of
 * the append seam): a rewrite is valid only when it is byte-identical
 * outside the captured block's body and appends task-shaped lines inside it.
 * `before` lacking the block fails — pre-block dailies are served by the
 * append seam, which knows how to create the section.
 */
export function isValidCapturedTasksWrite(input: {
  readonly before: string;
  readonly after: string;
}): boolean {
  const beforeBlock = capturedBlockRange(input.before);
  const afterBlock = capturedBlockRange(input.after);
  if (beforeBlock === null || afterBlock === null) return false;
  const outsideBefore =
    input.before.slice(0, beforeBlock.bodyStart) +
    input.before.slice(beforeBlock.bodyEnd);
  const outsideAfter =
    input.after.slice(0, afterBlock.bodyStart) +
    input.after.slice(afterBlock.bodyEnd);
  if (outsideBefore !== outsideAfter) return false;
  const bodyBefore = input.before.slice(
    beforeBlock.bodyStart,
    beforeBlock.bodyEnd,
  );
  const bodyAfter = input.after.slice(afterBlock.bodyStart, afterBlock.bodyEnd);
  if (!bodyAfter.startsWith(bodyBefore)) return false;
  const appended = bodyAfter.slice(bodyBefore.length);
  const lines = appended.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return false;
  // The writePage mirror enforces the same per-append cap as the append
  // seam — otherwise a rewrite would be the bulk-import bypass.
  if (lines.length > CAPTURED_APPEND_MAX_LINES) return false;
  return lines.every(isCapturedTaskLine);
}

/**
 * Repair the real-vault pre-D3 wart of duplicate `# Captured today` /
 * `## Captured today` headings (mismatched levels): merge every captured
 * section into THE single owned section — the one already holding the
 * `dome.daily:captured` block wins, else the first — normalizing the kept
 * heading to `## Captured today`, preserving every merged body line (task
 * lines + anchors verbatim, dome marker-comment lines dropped so a smuggled
 * pair cannot survive the merge) by splicing them inside the block.
 *
 * Returns the repaired document, or `null` when nothing needs repairing
 * (the idempotent fixed point: one `## Captured today` heading). Callers
 * apply this to TODAY's daily only — historical dailies stay append-only.
 */
export function repairCapturedTodayHeadings(content: string): string | null {
  if (isObsidianTasksDashboard(content)) return null;
  const lines = content.split(/\r?\n/);
  const frontmatter = frontmatterLineRange(content);
  const ignored = [
    ...fencedCodeBlockLineRanges(content),
    ...(frontmatter === null ? [] : [frontmatter]),
  ];
  const blockScan = findGeneratedBlock(content, DAILY_OWNER, CAPTURED_BLOCK);
  const headingIndexes: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lineIsInsideRanges(i + 1, ignored)) continue;
    // A captured-heading LINE inside the block body is block content, not a
    // section heading — treating it as one could drag the end marker into a
    // merged-and-dropped extent.
    if (
      blockScan.range !== null &&
      i + 1 >= blockScan.range.startLine &&
      i + 1 <= blockScan.range.endLine
    ) {
      continue;
    }
    if (CAPTURED_HEADING_RE.test(lines[i] ?? "")) headingIndexes.push(i);
  }
  if (headingIndexes.length === 0) return null;
  if (
    headingIndexes.length === 1 &&
    (lines[headingIndexes[0] ?? 0] ?? "").trim() === CAPTURED_HEADING
  ) {
    return null;
  }

  // Section extents: heading line through the line before the next heading
  // (any level) outside fences, or EOF.
  const sections = headingIndexes.map((headingIndex) => {
    let end = lines.length;
    for (let i = headingIndex + 1; i < lines.length; i += 1) {
      if (lineIsInsideRanges(i + 1, ignored)) continue;
      if (/^#{1,6}\s+\S/.test(lines[i] ?? "")) {
        end = i;
        break;
      }
    }
    return { headingIndex, end };
  });

  // The canonical section: the one carrying the captured block's start
  // marker, else the first.
  const canonical =
    sections.find(
      (section) =>
        blockScan.range !== null &&
        blockScan.range.startLine - 1 > section.headingIndex &&
        blockScan.range.startLine - 1 < section.end,
    ) ?? sections[0];
  if (canonical === undefined) return null;

  // Collect the duplicate sections' body lines (skipping blanks and dome
  // marker-comment lines) and drop those sections from the document.
  const merged: string[] = [];
  const dropLine = new Set<number>();
  for (const section of sections) {
    if (section === canonical) continue;
    dropLine.add(section.headingIndex);
    for (let i = section.headingIndex + 1; i < section.end; i += 1) {
      dropLine.add(i);
      const line = lines[i] ?? "";
      if (line.trim() === "") continue;
      if (containsGeneratedBlockMarker(line)) continue;
      merged.push(line);
    }
  }

  const keptLines = lines
    .map((line, i) =>
      i === canonical.headingIndex ? CAPTURED_HEADING : line,
    )
    .filter((_line, i) => !dropLine.has(i));
  const compacted = keptLines.join("\n");
  const repaired =
    merged.length === 0
      ? compacted
      : appendCapturedTaskLines({ content: compacted, lines: merged });
  return repaired === content ? null : repaired;
}

function insertCapturedSection(input: {
  readonly content: string;
  readonly section: string;
}): string {
  const heading = new RegExp(
    `^${escapeRegExp(CAPTURED_HEADING)}[ \\t]*$`,
    "m",
  ).exec(input.content);
  if (heading !== null && heading.index !== undefined) {
    const insertAt = heading.index + heading[0].length;
    const rest = input.content.slice(insertAt).replace(/^(?:\r?\n)*/, "\n\n");
    return `${input.content.slice(0, insertAt)}\n\n${input.section}${rest}`;
  }
  for (const anchor of [/^## Start Here[ \t]*$/m, /^## Meetings[ \t]*$/m, /^## Open Loops[ \t]*$/m, /^## Notes[ \t]*$/m]) {
    const match = anchor.exec(input.content);
    if (match !== null && match.index !== undefined) {
      return (
        `${input.content.slice(0, match.index)}` +
        `${CAPTURED_HEADING}\n\n${input.section}\n\n` +
        input.content.slice(match.index)
      );
    }
  }
  const suffix = input.content.endsWith("\n") ? "" : "\n";
  return `${input.content}${suffix}\n${CAPTURED_HEADING}\n\n${input.section}\n`;
}

function capturedBlockRange(content: string): GeneratedBlockRange | null {
  return findGeneratedBlock(content, DAILY_OWNER, CAPTURED_BLOCK).range;
}
