// src/core/config-path.ts
//
// The relative-vault-markdown-path validation gauntlet shared by extension
// config readers (core_path, consolidation_ledger_path, daily_path). Returns
// BARE problem reasons of the form "<field> must be ..."; callers own their
// historical wrapping (dome.agent's "dome.agent config <reason>; falling back
// to <default>", dome.daily's thrown "dome.daily config <reason>"). Message
// text is pinned byte-for-byte by tests/core/config-path-messages.test.ts.

export type ConfigPathResolution = {
  readonly path: string | null;
  /** Bare reason ("<field> must be ..."), or null when valid. */
  readonly problem: string | null;
};

/**
 * Validate that `raw` is a non-empty, relative, vault-rooted markdown path
 * (no leading slash, no backslash, no `.`/`..` segments, ends with `.md`).
 *
 * Returns `{ path: raw, problem: null }` on success, or
 * `{ path: null, problem: "<field> must be ..." }` on the first failure.
 *
 * Check order (load-bearing — callers' characterization tests pin this):
 *   1. typeof !== "string" → "<field> must be a string"
 *   2. trim/empty/!.md      → "<field> must be a non-empty .md path"
 *   3. absolute/traversal  → "<field> must be a relative vault markdown path"
 */
export function validateRelativeMarkdownPath(
  raw: unknown,
  field: string,
): ConfigPathResolution {
  if (typeof raw !== "string") {
    return { path: null, problem: `${field} must be a string` };
  }
  if (raw.trim() !== raw || raw.length === 0 || !raw.endsWith(".md")) {
    return { path: null, problem: `${field} must be a non-empty .md path` };
  }
  if (
    raw.startsWith("/") ||
    raw.includes("\\") ||
    raw
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return {
      path: null,
      problem: `${field} must be a relative vault markdown path`,
    };
  }
  return { path: raw, problem: null };
}
