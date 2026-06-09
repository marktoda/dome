// Shared supersession-frontmatter parsing for dome.markdown.page-status and
// dome.markdown.lint-supersession.
//
// The convention (per [[wiki/specs/page-schema]] §"Supersession (ADR
// pattern)") is one frontmatter flip + one forward link:
//
//   status: superseded
//   superseded_by: "[[wiki/concepts/replacement]]"
//
// Both consumers need the same three reads: the `status:` value, the
// `superseded_by:` wikilink target (recorded as written, [[..]] stripped),
// and the 1-indexed frontmatter lines those keys sit on (so diagnostics and
// fact SourceRefs anchor to the exact span). Kept in one module so the two
// processors cannot drift on what "superseded" means.

import matter from "gray-matter";

export const SUPERSEDED_STATUS = "superseded";

export type PageStatusInfo = {
  /** Trimmed `status:` string, or null when absent / not a string. */
  readonly status: string | null;
  /** 1-indexed line of the `status:` key (1 when not locatable). */
  readonly statusLine: number;
  /** `superseded_by:` wikilink target as written ([[..]]/alias/fragment stripped). */
  readonly supersededBy: string | null;
  /** 1-indexed line of the `superseded_by:` key (1 when not locatable). */
  readonly supersededByLine: number;
};

export function readPageStatus(content: string): PageStatusInfo {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch {
    return Object.freeze({
      status: null,
      statusLine: 1,
      supersededBy: null,
      supersededByLine: 1,
    });
  }

  const rawStatus = parsed.data["status"];
  const status = typeof rawStatus === "string" && rawStatus.trim().length > 0
    ? rawStatus.trim()
    : null;
  const supersededBy = wikilinkTargetFromFrontmatterValue(
    parsed.data["superseded_by"],
  );

  return Object.freeze({
    status,
    statusLine: frontmatterKeyLine(content, "status") ?? 1,
    supersededBy,
    supersededByLine: frontmatterKeyLine(content, "superseded_by") ?? 1,
  });
}

export function pageIsSuperseded(info: PageStatusInfo): boolean {
  return info.status !== null &&
    info.status.toLowerCase() === SUPERSEDED_STATUS;
}

/**
 * Extract a wikilink target from a frontmatter value. Accepts the quoted
 * convention (`superseded_by: "[[wiki/x]]"` → string), an unquoted wikilink
 * (YAML parses `[[wiki/x]]` as a nested flow sequence → [["wiki/x"]]), or a
 * bare path string. Display aliases (`|…`) and heading fragments (`#…`) are
 * stripped — the target is what resolvers consume.
 */
export function wikilinkTargetFromFrontmatterValue(
  value: unknown,
): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const inner = trimmed.startsWith("[[") && trimmed.endsWith("]]")
      ? trimmed.slice(2, -2)
      : trimmed;
    const target = (inner.split("|")[0] ?? "").split("#")[0]?.trim() ?? "";
    return target.length > 0 ? target : null;
  }
  if (Array.isArray(value)) {
    // YAML flow-sequence form of an unquoted [[wikilink]].
    return wikilinkTargetFromFrontmatterValue(value[0]);
  }
  return null;
}

/**
 * 1-indexed line of a top-level frontmatter key, or null when the content
 * has no frontmatter block or the key is absent. Mirrors the lookup in
 * dome.markdown.stale-dates so diagnostics anchor identically.
 */
export function frontmatterKeyLine(
  content: string,
  key: string,
): number | null {
  if (!content.startsWith("---")) return null;
  const lines = content.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "---" || line.trim() === "...") return null;
    if (new RegExp(`^${escapeRegExp(key)}\\s*:`).test(line)) return i + 1;
  }
  return null;
}

export type LineRange = {
  /** 1-indexed inclusive start (the heading line itself). */
  readonly startLine: number;
  /** 1-indexed inclusive end. */
  readonly endLine: number;
};

/**
 * 1-indexed line ranges of every `## Superseded` section (any ATX level,
 * case-insensitive heading text "Superseded"). A section runs from its
 * heading to the line before the next heading of the same or shallower
 * depth. Wikilinks inside these ranges are history context per
 * [[wiki/specs/page-schema]] §"Supersession (ADR pattern)" and are exempt
 * from the link-to-superseded lint.
 */
export function supersededSectionLineRanges(
  content: string,
): ReadonlyArray<LineRange> {
  const lines = content.split(/\r?\n/);
  const ranges: LineRange[] = [];
  let open: { startLine: number; depth: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i] ?? "");
    if (heading === null) continue;
    const depth = heading[1]?.length ?? 0;
    const text = heading[2] ?? "";
    if (open !== null && depth <= open.depth) {
      ranges.push(Object.freeze({ startLine: open.startLine, endLine: i }));
      open = null;
    }
    if (open === null && text.trim().toLowerCase() === "superseded") {
      open = { startLine: i + 1, depth };
    }
  }
  if (open !== null) {
    ranges.push(
      Object.freeze({ startLine: open.startLine, endLine: lines.length }),
    );
  }
  return Object.freeze(ranges);
}

export function lineInRanges(
  line: number,
  ranges: ReadonlyArray<LineRange>,
): boolean {
  return ranges.some((r) => line >= r.startLine && line <= r.endLine);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
