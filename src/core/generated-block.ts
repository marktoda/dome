// core/generated-block: the generated-block marker grammar.
//
// A generated block is a marker-delimited region of a markdown page that a
// processor owns and regenerates:
//
//   <!-- <owner>:<block>:start -->
//   ...body...
//   <!-- <owner>:<block>:end -->
//
// where `owner` is a dome namespace (`dome`, `dome.daily`, `dome.agent.brief`,
// ...) and `block` is a slug (`open-loops`, `promoted-preferences`, ...).
// Everything outside the markers is human prose. Like its sibling
// `src/core/block-anchor.ts`, this is a pure zero-IO string primitive — and it
// is the ONLY sanctioned implementation of the grammar (enforced by
// tests/integration/generated-block-splice-guard.test.ts per
// [[wiki/linters/generated-block-splice-guard]]).
//
// The grammar carries two hard-won defenses (the same bug class shipped three
// times before this module existed — see the linter doc):
//
//  1. LINE-ANCHORED SCANNING. A marker is a marker only when the entire
//     trimmed line is the marker. Prose/fence mentions of marker text and
//     mid-line smuggles never bound a block; a raw `indexOf` would mis-bound
//     the block and leak generated text outside it (the double-promote
//     rule-text escape).
//
//  2. BODY SANITIZATION. Model-derived block bodies drop every line carrying
//     a `<!-- dome…` marker comment and strip stray bare `<!--`/`-->`
//     fragments that could recombine. Dome's HTML comments are exclusively
//     generated-block markers, so no legitimate body line ever carries one —
//     without the strip, a body could smuggle a second copy of another
//     block's marker pair (first-occurrence replacement leaves the smuggled
//     copy verbatim) or inject another bundle's markers and corrupt its
//     regions.

export type GeneratedBlockMarkers = {
  /** `<!-- <owner>:<block>:start -->` */
  readonly start: string;
  /** `<!-- <owner>:<block>:end -->` */
  readonly end: string;
};

/** Owners are dome namespaces: `dome`, `dome.daily`, `dome.agent.brief`, ... */
const OWNER_RE = /^dome(\.\w+)*$/;
/** Block names are slugs: `open-loops`, `promoted-preferences`, `index`, ... */
const BLOCK_NAME_RE = /^[A-Za-z0-9][\w-]*$/;

/**
 * A dome marker comment anywhere in a line — the sanitization trigger. Both
 * dotted owners (`<!-- dome.daily:` …) and the bare owner (`<!-- dome:index:`
 * …) count; whitespace after `<!--` is tolerated the way the historical brief
 * guard tolerated it.
 */
const DOME_MARKER_COMMENT_RE = /<!--\s*dome[.:]/;

/** A bare HTML comment delimiter (`<!--` or `-->`). */
const HTML_COMMENT_DELIMITER_RE = /<!--|-->/;

/**
 * Build the marker pair for `(owner, block)`. The only sanctioned way to
 * construct marker text; throws on grammar-violating names (programmer
 * error, not data).
 */
export function generatedBlockMarkers(
  owner: string,
  block: string,
): GeneratedBlockMarkers {
  if (!OWNER_RE.test(owner)) {
    throw new Error(
      `generated-block owner must match dome(\\.\\w+)*, got ${JSON.stringify(owner)}`,
    );
  }
  if (!BLOCK_NAME_RE.test(block)) {
    throw new Error(
      `generated-block name must be a slug, got ${JSON.stringify(block)}`,
    );
  }
  return Object.freeze({
    start: `<!-- ${owner}:${block}:start -->`,
    end: `<!-- ${owner}:${block}:end -->`,
  });
}

export type GeneratedBlockRange = {
  /** Char offset of the start-marker line's first character. */
  readonly start: number;
  /** Char offset just past the end-marker line's content (its newline excluded). */
  readonly end: number;
  /**
   * Char offsets of the body between the marker lines. The body includes the
   * newline after the start-marker line and the newline before the end-marker
   * line, so `start-marker + body + end-marker` reassembles the block byte-
   * identically.
   */
  readonly bodyStart: number;
  readonly bodyEnd: number;
  /** 1-based line numbers of the two marker lines. */
  readonly startLine: number;
  readonly endLine: number;
};

export type GeneratedBlockAnomalyKind =
  /** A second line-anchored start marker beyond the winning pair. */
  | "extra-start"
  /** A second line-anchored end marker beyond the winning pair. */
  | "extra-end"
  /** A line-anchored end marker with no open start before it. */
  | "orphan-end"
  /** A line-anchored start marker with no end marker after it. */
  | "unterminated";

export type GeneratedBlockAnomaly = {
  readonly kind: GeneratedBlockAnomalyKind;
  /** 1-based line number of the anomalous marker line. */
  readonly line: number;
};

export type GeneratedBlockScan = {
  /** The first line-anchored pair, or null when the block is absent. */
  readonly range: GeneratedBlockRange | null;
  /**
   * Marker lines beyond (or instead of) the winning pair — smuggled duplicate
   * pairs, unterminated starts, orphan ends. Callers that splice should treat
   * a non-empty list as a diagnosable smell, never as a second bound.
   */
  readonly anomalies: ReadonlyArray<GeneratedBlockAnomaly>;
};

type ScannedLine = {
  /** Char offset of the line's first character. */
  readonly offset: number;
  /** The line content (no terminator). */
  readonly text: string;
};

function scanLines(content: string): ReadonlyArray<ScannedLine> {
  const out: ScannedLine[] = [];
  let offset = 0;
  for (const text of content.split("\n")) {
    out.push({ offset, text });
    offset += text.length + 1;
  }
  return out;
}

/** `\r`-tolerant trimmed-line equality: the whole line is the marker. */
function isMarkerLine(text: string, marker: string): boolean {
  return text.trim() === marker;
}

type RawPair = {
  readonly startIndex: number;
  readonly endIndex: number;
};

type RawScan = {
  readonly pairs: ReadonlyArray<RawPair>;
  readonly anomalies: ReadonlyArray<GeneratedBlockAnomaly>;
};

/**
 * Pair every line-anchored start with the next line-anchored end. The first
 * pair is the block; later pairs are anomalies (a smuggled duplicate pair is
 * a pair, not a block). A start inside an open pair is `extra-start`, an end
 * with no open start is `orphan-end`, an open start at EOF is `unterminated`.
 */
function rawScan(
  lines: ReadonlyArray<ScannedLine>,
  markers: GeneratedBlockMarkers,
): RawScan {
  const pairs: RawPair[] = [];
  const anomalies: GeneratedBlockAnomaly[] = [];
  let openStart: number | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i]?.text ?? "";
    if (isMarkerLine(text, markers.start)) {
      if (openStart === null) {
        openStart = i;
      } else {
        anomalies.push(Object.freeze({ kind: "extra-start", line: i + 1 }));
      }
      continue;
    }
    if (isMarkerLine(text, markers.end)) {
      if (openStart === null) {
        anomalies.push(Object.freeze({ kind: "orphan-end", line: i + 1 }));
        continue;
      }
      pairs.push(Object.freeze({ startIndex: openStart, endIndex: i }));
      openStart = null;
    }
  }
  if (openStart !== null) {
    anomalies.push(
      Object.freeze({ kind: "unterminated", line: openStart + 1 }),
    );
  }
  // Pairs beyond the first are anomalies on both marker lines.
  for (const pair of pairs.slice(1)) {
    anomalies.push(
      Object.freeze({ kind: "extra-start", line: pair.startIndex + 1 }),
      Object.freeze({ kind: "extra-end", line: pair.endIndex + 1 }),
    );
  }
  return Object.freeze({
    pairs: Object.freeze(pairs),
    anomalies: Object.freeze(
      anomalies.sort((a, b) => a.line - b.line),
    ),
  });
}

function rangeFromPair(
  lines: ReadonlyArray<ScannedLine>,
  pair: RawPair,
): GeneratedBlockRange {
  const startLine = lines[pair.startIndex] as ScannedLine;
  const endLine = lines[pair.endIndex] as ScannedLine;
  return Object.freeze({
    start: startLine.offset,
    end: endLine.offset + endLine.text.length,
    bodyStart: startLine.offset + startLine.text.length,
    bodyEnd: endLine.offset,
    startLine: pair.startIndex + 1,
    endLine: pair.endIndex + 1,
  });
}

/**
 * Locate the `(owner, block)` generated block by a line-anchored marker scan.
 * The first line-anchored pair wins; every further marker line is reported as
 * an anomaly. Returns `range: null` (plus anomalies, if any) when no pair
 * exists — including the unterminated-start case.
 */
export function findGeneratedBlock(
  content: string,
  owner: string,
  block: string,
): GeneratedBlockScan {
  const markers = generatedBlockMarkers(owner, block);
  const lines = scanLines(content);
  const scan = rawScan(lines, markers);
  const first = scan.pairs[0];
  return Object.freeze({
    range: first === undefined ? null : rangeFromPair(lines, first),
    anomalies: scan.anomalies,
  });
}

/**
 * All line-anchored `(owner, block)` pairs in document order — for consumers
 * that must neutralize every copy (e.g. the search indexer stripping
 * generated regions, where a smuggled second pair must ALSO not be indexed).
 */
export function findAllGeneratedBlocks(
  content: string,
  owner: string,
  block: string,
): ReadonlyArray<GeneratedBlockRange> {
  const markers = generatedBlockMarkers(owner, block);
  const lines = scanLines(content);
  return Object.freeze(
    rawScan(lines, markers).pairs.map((pair) => rangeFromPair(lines, pair)),
  );
}

/**
 * The text between the marker lines (the newline after the start marker and
 * the newline before the end marker included), or null when the block is
 * absent.
 */
export function extractGeneratedBlockBody(
  content: string,
  owner: string,
  block: string,
): string | null {
  const { range } = findGeneratedBlock(content, owner, block);
  if (range === null) return null;
  return content.slice(range.bodyStart, range.bodyEnd);
}

/**
 * Replace the existing `(owner, block)` block — markers included — with
 * `section` (a full replacement block, or `""`/null-like removal handled by
 * the caller passing the empty string). Returns null when the block is
 * absent so the caller can run its own placement-aware insertion logic; the
 * primitive deliberately owns bounding, not placement.
 */
export function replaceGeneratedBlock(
  content: string,
  owner: string,
  block: string,
  section: string,
): string | null {
  const { range } = findGeneratedBlock(content, owner, block);
  if (range === null) return null;
  return `${content.slice(0, range.start)}${section}${content.slice(range.end)}`;
}

/**
 * Blank every line covered by a line-anchored `(owner, block)` pair —
 * markers and body — preserving the file's line count so line-based
 * source refs into the surrounding prose stay valid. Non-pair marker
 * mentions (prose, fences, mid-line smuggles) are left alone: they are
 * content, not blocks.
 */
export function blankGeneratedBlocks(
  content: string,
  owner: string,
  block: string,
): string {
  const ranges = findAllGeneratedBlocks(content, owner, block);
  if (ranges.length === 0) return content;
  const lines = content.split("\n");
  for (const range of ranges) {
    for (let line = range.startLine; line <= range.endLine; line += 1) {
      lines[line - 1] = "";
    }
  }
  return lines.join("\n");
}

export type SanitizedGeneratedBlockBody = {
  /** The body with marker-bearing lines dropped and bare delimiters stripped. */
  readonly body: string;
  /** Whole lines dropped because they carried a dome marker comment (trimmed). */
  readonly droppedLines: ReadonlyArray<string>;
  /** Bare `<!--` / `-->` fragments stripped from kept lines, in order. */
  readonly strippedDelimiters: ReadonlyArray<string>;
};

/**
 * The injection guard for model-derived block bodies. Drops every line
 * carrying a dome marker comment (`<!-- dome…`, dotted or bare owner) and
 * strips stray bare `<!--`/`-->` fragments from the kept lines so split
 * delimiters can never recombine into a marker downstream. Returns what was
 * dropped so callers can diagnose the attempt.
 */
export function sanitizeGeneratedBlockBody(
  body: string,
): SanitizedGeneratedBlockBody {
  const kept: string[] = [];
  const droppedLines: string[] = [];
  const strippedDelimiters: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (DOME_MARKER_COMMENT_RE.test(line)) {
      droppedLines.push(line.trim());
      continue;
    }
    if (HTML_COMMENT_DELIMITER_RE.test(line)) {
      kept.push(
        line.replace(/<!--|-->/g, (delimiter) => {
          strippedDelimiters.push(delimiter);
          return "";
        }),
      );
      continue;
    }
    kept.push(line);
  }
  return Object.freeze({
    body: kept.join("\n"),
    droppedLines: Object.freeze(droppedLines),
    strippedDelimiters: Object.freeze(strippedDelimiters),
  });
}

/**
 * True when `text` carries a dome generated-block marker comment anywhere
 * (not just line-anchored) — the parse-time rejection predicate for content
 * that is never allowed to mention markers at all.
 */
export function containsGeneratedBlockMarker(text: string): boolean {
  return DOME_MARKER_COMMENT_RE.test(text);
}

/**
 * True when `text` carries a bare HTML comment opener/closer. The stricter
 * parse-time rejection (the preferences-signals rule): where free-form text
 * could flow into a marker-spliced page, ANY comment delimiter is malformed,
 * not just fully-formed dome markers — fragments could recombine.
 */
export function containsHtmlCommentDelimiter(text: string): boolean {
  return HTML_COMMENT_DELIMITER_RE.test(text);
}
