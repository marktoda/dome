// patch-parse: shared unified-diff path extraction for the engine's
// capability-broker + closure-commit pipelines.
//
// v1 implements loose parsing — walks the `+++`/`---` header lines, skips
// `/dev/null` sentinels, and strips the `a/` (in `---` headers) or `b/` (in
// `+++` headers) directory prefix git conventionally emits. Sufficient for
// the broker's representative-path check and the closure commit's
// `touchedPaths` argument; a future Phase 2.x will plumb a real diff parser
// (per-hunk attribution, rename detection) where needed.
//
// House-style notes (matches src/engine/compile-range.ts,
// src/engine/capability-broker.ts):
//   - Banner cites the spec section + the v1 limitation.
//   - Imports limited to pure types from `../core/`.
//   - No filesystem, git, or sqlite dependencies.

import type { UnifiedDiff } from "../core/effect";

// ----- parsePatchPaths ------------------------------------------------------

/**
 * Extract every unique vault-relative path a UnifiedDiff touches. Returns
 * paths in first-occurrence order (deterministic across runs against the
 * same patch text); returns an empty array if no `+++` / `---` header
 * parses (e.g., the patch is malformed or empty).
 *
 * Used by the closure-commit's `touchedPaths` argument — the list of files
 * to `git add` before the commit, not for semantic intent.
 */
export function parsePatchPaths(patch: UnifiedDiff): ReadonlyArray<string> {
  const seen = new Set<string>();
  const result: string[] = [];
  const lines = patch.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;
    const isMinus = line.startsWith("--- ");
    const isPlus = line.startsWith("+++ ");
    if (!isMinus && !isPlus) continue;
    const rest = line.slice(4).trim();
    if (rest.length === 0) continue;
    if (rest === "/dev/null") continue;
    // Strip `a/` (in `---` headers) or `b/` (in `+++` headers) prefix git
    // conventionally emits. Don't strip arbitrary single-char prefixes —
    // only the two git uses.
    const stripped =
      (isMinus && rest.startsWith("a/")) || (isPlus && rest.startsWith("b/"))
        ? rest.slice(2)
        : rest;
    if (stripped.length === 0) continue;
    if (seen.has(stripped)) continue;
    seen.add(stripped);
    result.push(stripped);
  }
  return Object.freeze(result);
}

// ----- firstPatchPath -------------------------------------------------------

/**
 * Extract the first vault-relative path a UnifiedDiff touches. Returns
 * `null` if no recognizable header is found. Used by the capability broker's
 * loose v1 representative-path check; the full multi-path enumeration is
 * `parsePatchPaths`.
 */
export function firstPatchPath(patch: UnifiedDiff): string | null {
  const paths = parsePatchPaths(patch);
  return paths[0] ?? null;
}
