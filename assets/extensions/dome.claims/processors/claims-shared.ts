// dome.claims — the pure claim-line grammar, shared by stamp and index.
//
// A claim line is, on any page: optional list bullet, a line-opening
// `**Key:**` bold prefix, then a non-empty value (wikilinks welcome), an
// optional `*(as of YYYY-MM-DD)*` marker, and an optional trailing
// `^c…` block anchor. Lines inside YAML frontmatter, fenced code blocks,
// and blockquotes are never claims, so quoted material can't be
// over-anchored. Pure (string-only, no IO) like daily-shared's extractors.

import { createHash } from "node:crypto";

import {
  appendBlockAnchor,
  parseBlockAnchor,
} from "../../../../src/core/block-anchor";

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

/** Optional indent + optional bullet, then a line-opening `**Key:**` + value. */
const CLAIM_LINE_RE = /^(\s*(?:[-*]\s+)?)\*\*([^*\n]+):\*\*\s+(\S.*)$/;
const AS_OF_RE = /\*\(as of (\d{4}-\d{2}-\d{2})\)\*/;

export function claimsFromMarkdown(
  content: string,
): ReadonlyArray<ClaimLine> {
  const lines = content.split(/\r?\n/);
  const excluded = excludedLineFlags(lines);
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
 * Fence open/close lines are themselves excluded; ``` and ~~~ fences must
 * close with their own marker.
 */
function excludedLineFlags(lines: ReadonlyArray<string>): boolean[] {
  const flags = new Array<boolean>(lines.length).fill(false);
  let inFrontmatter = lines[0]?.trim() === "---";
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (inFrontmatter) {
      flags[i] = true;
      if (i > 0 && line.trim() === "---") inFrontmatter = false;
      continue;
    }
    const fenceMatch = /^[ ]{0,3}(```|~~~)/.exec(line);
    if (fence !== null) {
      flags[i] = true;
      if (fenceMatch !== null && fenceMatch[1] === fence) fence = null;
      continue;
    }
    if (fenceMatch !== null) {
      flags[i] = true;
      fence = fenceMatch[1] ?? null;
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
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        input.path.replace(/^\.\//, ""),
        normalizeClaimKey(input.key),
        input.occurrence,
      ]),
    )
    .digest("hex")
    .slice(0, 8);
  return `c${hash}`;
}

/**
 * Stamp a stable `^c…` anchor onto every claim line that lacks one,
 * returning the rewritten document — or `null` when nothing needs stamping
 * (the idempotent fixed point). Occurrence counting includes already-anchored
 * claims so a later re-run assigns the same ids it would have on first sight.
 */
export function stampClaimAnchors(input: {
  readonly path: string;
  readonly content: string;
}): string | null {
  const lines = input.content.split(/\r?\n/);
  const occurrences = new Map<string, number>();
  let changed = false;
  for (const claim of claimsFromMarkdown(input.content)) {
    const keyNorm = normalizeClaimKey(claim.key);
    const occurrence = occurrences.get(keyNorm) ?? 0;
    occurrences.set(keyNorm, occurrence + 1);
    if (claim.anchor !== null) continue;
    const idx = claim.line - 1;
    const line = lines[idx];
    if (line === undefined) continue;
    lines[idx] = appendBlockAnchor(
      line,
      claimAnchorId({ path: input.path, key: claim.key, occurrence }),
    );
    changed = true;
  }
  return changed ? lines.join("\n") : null;
}
