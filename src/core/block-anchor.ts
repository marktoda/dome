// core/block-anchor: the Obsidian-style trailing block-anchor grammar.
//
// A block anchor is a `^id` token at the very end of a line, separated from
// the preceding text by whitespace — e.g. `- [ ] ship the thing ^t1a2b3c4`.
// Dome uses it as a path-independent, move-stable identity stamped into the
// markdown itself (markdown is the source of truth), so a task carries the
// same identity no matter which file it lives in. The grammar is a core
// primitive — shared by the task-lifecycle processors and any consumer that
// needs to read or write a stable line identity — and is intentionally pure
// (string-only, no IO) so it is trivially testable and rebuild-safe.

import { createHash } from "node:crypto";

/**
 * Matches a trailing ` ^id` block anchor. The leading `\s` requires whitespace
 * before the caret (so `x^y` and `2^10` are not anchors); `\s*$` anchors it to
 * end-of-line while tolerating trailing whitespace. Anchor ids are
 * alphanumeric with internal dashes, starting alphanumeric.
 */
const BLOCK_ANCHOR_RE = /\s\^([A-Za-z0-9][A-Za-z0-9-]*)\s*$/;

export type ParsedBlockAnchor = {
  /** The anchor id without the leading caret. */
  readonly id: string;
  /** The line with the anchor (and its separating whitespace) removed. */
  readonly withoutAnchor: string;
};

/**
 * Parse a trailing block anchor off a line. Returns `null` when the line has
 * no trailing anchor (a mid-line caret does not count).
 */
export function parseBlockAnchor(line: string): ParsedBlockAnchor | null {
  const match = BLOCK_ANCHOR_RE.exec(line);
  if (match === null || match.index === undefined) return null;
  const id = match[1];
  if (id === undefined) return null;
  return Object.freeze({
    id,
    withoutAnchor: line.slice(0, match.index).trimEnd(),
  });
}

/** True iff the line ends with a block anchor. */
export function hasBlockAnchor(line: string): boolean {
  return BLOCK_ANCHOR_RE.test(line);
}

/**
 * Append ` ^id` to the trimmed end of a line. The caller is responsible for
 * not double-stamping (guard with {@link hasBlockAnchor}); this helper only
 * formats.
 */
export function appendBlockAnchor(line: string, id: string): string {
  return `${line.trimEnd()} ^${id}`;
}

/**
 * Deterministic 8-hex-char content anchor id with a namespace prefix.
 * The hash input is JSON.stringify(parts) — callers own normalization of
 * the parts (path normalization, body/key collapsing); this helper owns
 * only the hash shape. Pinned by tests/core/anchor-id-stability.test.ts:
 * changing this changes every ^t…/^c… anchor in every committed vault.
 */
export function contentAnchorId(
  prefix: string,
  parts: ReadonlyArray<string | number>,
): string {
  return `${prefix}${createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 8)}`;
}
