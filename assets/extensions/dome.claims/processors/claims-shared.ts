// dome.claims — the pure claim-line grammar, shared by stamp and index.
//
// A claim line is, on any page: optional list bullet, a line-opening
// `**Key:**` bold prefix, then a non-empty value (wikilinks welcome), an
// optional `*(as of YYYY-MM-DD)*` marker, and an optional trailing
// `^c…` block anchor. Lines inside YAML frontmatter, fenced code blocks,
// and blockquotes are never claims, so quoted material can't be
// over-anchored. Pure (string-only, no IO) like daily-shared's extractors.

import {
  appendBlockAnchor,
  contentAnchorId,
  parseBlockAnchor,
} from "../../../../src/core/block-anchor";
import { findAllGeneratedBlocks } from "../../../../src/core/generated-block";
import { fencedCodeBlockLineRanges } from "../../../../src/core/markdown-scan";

export type ClaimLine = {
  /** 1-based line number in the document. */
  readonly line: number;
  /** The key exactly as written (untrimmed of internal spacing). */
  readonly key: string;
  /** The value text with any trailing block anchor removed. */
  readonly value: string;
  /** The `*(as of YYYY-MM-DD)*` date when present. */
  readonly asOf: string | null;
  /** The trailing block-anchor id when present. */
  readonly anchor: string | null;
};

type ClaimAnchorAssignment = {
  readonly claim: ClaimLine;
  readonly anchor: string;
};

/** Optional indent + optional bullet, then a line-opening `**Key:**` + value. */
const CLAIM_LINE_RE = /^(\s*(?:[-*]\s+)?)\*\*([^*\n]+):\*\*\s+(\S.*)$/;
const AS_OF_RE = /\*\(as of (\d{4}-\d{2}-\d{2})\)\*/;

/**
 * Discourse-marker keys that are session framing, not durable entity facts.
 * `**Net:** …`, `**Tension to hold:** …`, and friends are the bold-label shape
 * a `**Key:**` claim uses, but they label a momentary read or synthesis — they
 * belong in prose, not in the durable `## Current facts` digest. Excluding them
 * here (in the single grammar chokepoint) stops both the `^c` stamp and the
 * fact index from promoting them.
 *
 * This is a deliberately conservative denylist: it excludes only this known set
 * of framing labels, so a borderline real claim is let through rather than a
 * real fact dropped. Keys are matched by their normalized form
 * (lowercased, whitespace-collapsed) so case and spacing variants are covered.
 * Add new markers here as dogfooding surfaces them.
 */
const DISCOURSE_MARKER_KEYS: ReadonlySet<string> = new Set([
  "net",
  "net-net",
  "tension",
  "tension to hold",
  "tl;dr",
  "tldr",
  "takeaway",
  "key takeaway",
  "bottom line",
  "my read",
  "read",
  "verdict",
  "caveat",
  "aside",
  "update",
  "note",
  "summary",
  "context",
]);

/** True when a claim key is a discourse/framing marker, not a durable fact. */
function isDiscourseMarkerKey(key: string): boolean {
  return DISCOURSE_MARKER_KEYS.has(normalizeClaimKey(key));
}

/**
 * `**1. Tone feedback delivered (R4 head-on):** …` is a narrative enumeration
 * header, not a durable Key: value attribute — never a claim. Matched against
 * the RAW (pre-normalize, pre-trim) key text so a leading `1. ` or `3) ` list
 * marker is caught before any whitespace collapsing; a year like `2025 Goal`
 * is not `N. `/`N) `-shaped and still parses.
 */
const NUMBERED_KEY_RE = /^\d+[.)]\s/;

/** True when a claim key is a numbered narrative header, not a claim key. */
function isNumberedKey(key: string): boolean {
  return NUMBERED_KEY_RE.test(key);
}

// The single dome generated block whose `**Key:**`-shaped digest lines must
// never feed back into the claim index: the `## Current facts` block that
// `dome.claims.render-facts` writes.
const CURRENT_FACTS_OWNER = "dome.claims";
const CURRENT_FACTS_BLOCK = "current-facts";

export function claimsFromMarkdown(
  content: string,
): ReadonlyArray<ClaimLine> {
  const lines = content.split(/\r?\n/);
  const excluded = excludedLineFlags(lines, content);
  const claims: ClaimLine[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (excluded[i] === true) continue;
    const raw = lines[i] ?? "";
    if (raw.trimStart().startsWith(">")) continue;
    const anchored = parseBlockAnchor(raw);
    const body = anchored === null ? raw : anchored.withoutAnchor;
    const match = CLAIM_LINE_RE.exec(body);
    if (match === null) continue;
    const key = (match[2] ?? "").trim();
    const value = (match[3] ?? "").trim();
    if (key.length === 0 || value.length === 0) continue;
    if (isDiscourseMarkerKey(key)) continue;
    if (isNumberedKey(key)) continue;
    claims.push(
      Object.freeze({
        line: i + 1,
        key,
        value,
        asOf: AS_OF_RE.exec(value)?.[1] ?? null,
        anchor: anchored?.id ?? null,
      }),
    );
  }
  return Object.freeze(claims);
}

/**
 * Per-line exclusion flags for YAML frontmatter and fenced code blocks.
 * Fence open/close lines are themselves excluded. A closer must use the same
 * character (`` ` `` or `~`) as the opener AND its run length must be >= the
 * opener's run length — so a ````md (4-backtick) opener is never closed by an
 * inner ``` (3-backtick) line.
 *
 * Fence detection delegates to the shared core scanner with the dome.claims
 * dialect options (`indent: "up-to-3-spaces"`, `closeRequiresOpenerLength: true`).
 * Frontmatter detection is handled locally: an unterminated `---` block is
 * treated as excluding all remaining lines (claims dialect), whereas the core
 * `frontmatterLineRange` would return `null` in that case (daily dialect).
 *
 * The `dome.claims:current-facts` generated block is excluded via the canonical
 * `findAllGeneratedBlocks` primitive (the only sanctioned marker implementation,
 * per the splice-guard fence). `content` is the original document text the
 * primitive scans; `lines` is its `\r?\n`-split form used for the other dialects.
 */
function excludedLineFlags(
  lines: ReadonlyArray<string>,
  content: string,
): boolean[] {
  const flags = new Array<boolean>(lines.length).fill(false);

  // --- Frontmatter (claims dialect: unterminated block excludes to EOF) ---
  let frontmatterEnd = -1; // 0-based index of the close --- line, or lines.length - 1 if unterminated
  if (lines[0]?.trim() === "---") {
    let closed = false;
    for (let i = 1; i < lines.length; i += 1) {
      if ((lines[i] ?? "").trim() === "---") {
        frontmatterEnd = i;
        closed = true;
        break;
      }
    }
    if (!closed) frontmatterEnd = lines.length - 1;
    for (let i = 0; i <= frontmatterEnd; i += 1) {
      flags[i] = true;
    }
  }

  // --- Fenced code blocks (claims dialect via core scanner) ---
  // Scan only the post-frontmatter content so that fence markers that might
  // appear in YAML frontmatter cannot spuriously open a fence. If frontmatter
  // consumed lines 0..frontmatterEnd (0-based), body starts at frontmatterEnd+1.
  // The core scanner's 1-indexed ranges are offset by the number of skipped lines.
  const bodyStartLine = frontmatterEnd >= 0 ? frontmatterEnd + 1 : 0; // 0-based
  const bodyContent = lines.slice(bodyStartLine).join("\n");
  const fenceRanges = fencedCodeBlockLineRanges(bodyContent, {
    indent: "up-to-3-spaces",
    closeRequiresOpenerLength: true,
  });
  for (const range of fenceRanges) {
    // range.start/end are 1-indexed relative to bodyContent; add bodyStartLine
    // to convert to 0-based indices in the original lines array.
    const startIdx = bodyStartLine + range.start - 1; // 0-based
    const endIdx = bodyStartLine + range.end - 1;     // 0-based
    for (let idx = startIdx; idx <= endIdx; idx += 1) {
      flags[idx] = true;
    }
  }

  // --- Generated block: dome.claims:current-facts (markers inclusive) ---
  // The deterministic `## Current facts` digest that `dome.claims.render-facts`
  // writes must never feed its own `**Key:**`-shaped lines back into the claim
  // index. Scoped to exactly that owner/block via the canonical generated-block
  // primitive (the only sanctioned marker implementation). The primitive is
  // line-anchored, so a prose/fence/mid-line marker mention never bounds a
  // block — and an UNTERMINATED start (no matching `:end`) yields NO range, so
  // a stray start marker excludes nothing. That is intentionally safer than a
  // hand-rolled "exclude to EOF": a stray marker can never silently drop real
  // claims below it.
  const factsBlocks = findAllGeneratedBlocks(
    content,
    CURRENT_FACTS_OWNER,
    CURRENT_FACTS_BLOCK,
  );
  for (const range of factsBlocks) {
    // range.startLine/endLine are 1-based; convert to 0-based indices.
    for (let idx = range.startLine - 1; idx <= range.endLine - 1; idx += 1) {
      flags[idx] = true;
    }
  }

  return flags;
}

/** Lowercased, whitespace-collapsed key — the identity component. */
export function normalizeClaimKey(key: string): string {
  return key.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Deterministic, collision-resistant block-anchor id for a claim line. The
 * `c` prefix namespaces claim anchors away from task (`t`) and hand-authored
 * anchors. Identity hashes the normalized path, the **normalized key**, and
 * the key's occurrence index within the file — never the value, because
 * supersession edits the value in place under the same anchor.
 */
export function claimAnchorId(input: {
  readonly path: string;
  readonly key: string;
  readonly occurrence: number;
}): string {
  return contentAnchorId("c", [
    input.path.replace(/^\.\//, ""),
    normalizeClaimKey(input.key),
    input.occurrence,
  ]);
}

/**
 * Return the claim parse with every claim carrying the stable anchor it either
 * already has or would receive from {@link stampClaimAnchors}. This lets
 * readers that render references to claim lines (for example Current facts)
 * compute the post-stamp fixed point without waiting for an extra garden
 * cascade. The assignment logic intentionally mirrors stamping, including the
 * used-id collision skip.
 */
export function claimsWithStableAnchors(input: {
  readonly path: string;
  readonly content: string;
}): ReadonlyArray<ClaimLine> {
  return Object.freeze(
    stableClaimAnchorAssignments(input).map(({ claim, anchor }) => {
      if (claim.anchor === anchor) return claim;
      return Object.freeze({
        ...claim,
        anchor,
      });
    }),
  );
}

/**
 * Stamp a stable `^c…` anchor onto every claim line that lacks one,
 * returning the rewritten document — or `null` when nothing needs stamping
 * (the idempotent fixed point). Occurrence counting includes already-anchored
 * claims so a later re-run assigns the same ids it would have on first sight.
 *
 * Deduplication: before the loop, all existing trailing block-anchor ids in
 * the document are collected into a used-id set (ALL anchors, not just `^c…`,
 * since any duplicate breaks Obsidian block refs). For each unanchored claim,
 * the per-key occurrence counter is advanced until a candidate id is not
 * already in the set, preventing collisions when same-key claims are inserted
 * above pre-existing anchored ones or when a hand-authored anchor happens to
 * share a computed id.
 */
export function stampClaimAnchors(input: {
  readonly path: string;
  readonly content: string;
}): string | null {
  const lines = input.content.split(/\r?\n/);
  let changed = false;
  for (const { claim, anchor } of stableClaimAnchorAssignments(input)) {
    if (claim.anchor !== null) continue;
    const idx = claim.line - 1;
    const line = lines[idx];
    if (line === undefined) continue;
    lines[idx] = appendBlockAnchor(line, anchor);
    changed = true;
  }
  return changed ? lines.join("\n") : null;
}

function stableClaimAnchorAssignments(input: {
  readonly path: string;
  readonly content: string;
}): ReadonlyArray<ClaimAnchorAssignment> {
  const lines = input.content.split(/\r?\n/);

  // Collect every existing anchor id in the document into the used set.
  const usedIds = new Set<string>();
  for (const line of lines) {
    const parsed = parseBlockAnchor(line);
    if (parsed !== null) usedIds.add(parsed.id);
  }

  const assignments: ClaimAnchorAssignment[] = [];
  const occurrences = new Map<string, number>();
  for (const claim of claimsFromMarkdown(input.content)) {
    const keyNorm = normalizeClaimKey(claim.key);
    const occurrence = occurrences.get(keyNorm) ?? 0;
    if (claim.anchor !== null) {
      // Already anchored: advance counter and keep the existing identity.
      occurrences.set(keyNorm, occurrence + 1);
      assignments.push(Object.freeze({ claim, anchor: claim.anchor }));
      continue;
    }

    // Find the first unused id for this key, starting at the current counter.
    let occ = occurrence;
    let candidate = claimAnchorId({
      path: input.path,
      key: claim.key,
      occurrence: occ,
    });
    while (usedIds.has(candidate)) {
      occ += 1;
      candidate = claimAnchorId({
        path: input.path,
        key: claim.key,
        occurrence: occ,
      });
    }
    usedIds.add(candidate);
    occurrences.set(keyNorm, occ + 1);
    assignments.push(Object.freeze({ claim, anchor: candidate }));
  }
  return Object.freeze(assignments);
}
