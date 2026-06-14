// Shared wikilink parsing, resolution, and repair helpers for dome.markdown.
//
// Adoption validation and scheduled maintenance need to agree exactly on what
// counts as a resolved Obsidian wikilink, which close matches are safe to
// suggest, and how a source span is rewritten. Keeping those mechanics here
// lets processors differ only in policy: adoption emits diagnostics/questions,
// while scheduled maintenance only patches already-obvious managed-page drift.

import { compareStrings } from "../../../../src/core/compare";
import {
  reorderFrontmatterKeys,
  stringifyFrontmatter,
} from "./frontmatter-normalization";

// Matches `[[target]]` and `[[target|display]]`. The target is captured in
// group 1; group 2 preserves the optional `|display` suffix for repairs.
const WIKILINK_RE = /\[\[([^\[\]\|]+?)(\|[^\[\]]+)?\]\]/g;

// Common roots a bare wikilink may resolve under, in priority order.
const COMMON_ROOTS: ReadonlyArray<string> = [
  "wiki/",
  "notes/",
  "inbox/",
  "captures/",
];

export type WikilinkMatch = {
  readonly target: string;
  readonly displaySuffix: string;
  readonly line: number; // 1-indexed line number where the match begins
  readonly startChar: number; // 0-indexed column of `[[` within the line
  readonly endChar: number; // 0-indexed column of one past `]]` within the line
  readonly startOffset: number;
  readonly endOffset: number;
};

export type WikilinkReplacement = {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly text: string;
};

export type WikilinkSeverity = "warning" | "info";

export type WikilinkSuggestionResult =
  | { readonly kind: "none" }
  | { readonly kind: "unique"; readonly target: string }
  | { readonly kind: "ambiguous"; readonly targets: ReadonlyArray<string> };

export type WikilinkStubCandidate = {
  readonly path: string;
  readonly type: "concept" | "entity";
  readonly name: string;
};

export type WikilinkStubRequest<TSourceRef> = {
  readonly candidate: WikilinkStubCandidate;
  readonly sourcePaths: ReadonlyArray<string>;
  readonly sourceRefs: ReadonlyArray<TSourceRef>;
};

export type WikilinkResolver = {
  readonly resolve: (rawTarget: string, currentPath: string) => string | null;
  readonly resolveDetailed: (
    rawTarget: string,
    currentPath: string,
  ) => WikilinkResolution | null;
  readonly canonicalReplacementTarget: (
    rawTarget: string,
    currentPath: string,
  ) => string | null;
  readonly suggest: (rawTarget: string) => WikilinkSuggestionResult;
};

export type WikilinkResolution = {
  readonly path: string;
  readonly linkTarget: string;
  readonly kind:
    | "exact-path"
    | "path-suffix"
    | "normalized-path"
    | "path-basename"
    | "normalized-path-basename"
    | "common-root"
    | "basename"
    | "normalized-basename";
};

export function buildWikilinkResolver(
  markdownPaths: ReadonlyArray<string>,
): WikilinkResolver {
  const pathSet = new Set<string>(markdownPaths);
  const basenameIndex = buildBasenameIndex(markdownPaths);
  const normalizedIndex = buildNormalizedResolutionIndex(markdownPaths);
  const suggestionIndex = buildWikilinkSuggestionIndex(markdownPaths);

  return Object.freeze({
    resolve: (rawTarget: string, currentPath: string) =>
      resolveWikilinkTargetDetailed(
        rawTarget,
        currentPath,
        pathSet,
        basenameIndex,
        normalizedIndex,
      )?.path ?? null,
    resolveDetailed: (rawTarget: string, currentPath: string) =>
      resolveWikilinkTargetDetailed(
        rawTarget,
        currentPath,
        pathSet,
        basenameIndex,
        normalizedIndex,
      ),
    canonicalReplacementTarget: (rawTarget: string, currentPath: string) => {
      const resolution = resolveWikilinkTargetDetailed(
        rawTarget,
        currentPath,
        pathSet,
        basenameIndex,
        normalizedIndex,
      );
      return resolution === null
        ? null
        : canonicalReplacementTargetForResolution(rawTarget, resolution);
    },
    suggest: (rawTarget: string) =>
      suggestWikilinkTargets(rawTarget, suggestionIndex),
  });
}

export function findWikilinks(content: string): ReadonlyArray<WikilinkMatch> {
  const matches: WikilinkMatch[] = [];
  const ignoredRanges = markdownCodeRanges(content);
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(content)) !== null) {
    if (isOffsetInRanges(m.index, ignoredRanges)) continue;
    const target = m[1];
    if (target === undefined) continue;
    const trimmed = target.trim();
    if (trimmed.length === 0) continue;
    const pos = positionAt(content, m.index);
    matches.push({
      target: trimmed,
      displaySuffix: m[2] ?? "",
      line: pos.line,
      startChar: pos.col,
      endChar: pos.col + m[0].length,
      startOffset: m.index,
      endOffset: m.index + m[0].length,
    });
  }
  return matches;
}

export function isValidatableMarkdownPath(path: string): boolean {
  if (!path.endsWith(".md")) return false;
  if (path.startsWith("wiki/")) return true;
  if (path.startsWith("notes/")) return true;
  if (path.startsWith("captures/")) return true;
  if (path.startsWith("inbox/review/")) return false;
  if (path.startsWith("inbox/processed/")) return false;
  return path.startsWith("inbox/");
}

export function brokenWikilinkSeverity(
  path: string,
  line: number,
  frontmatterEndLineValue: number | null,
): WikilinkSeverity {
  if (path.startsWith("notes/")) return "info";
  if (
    path.startsWith("wiki/sources/") &&
    !isFrontmatterLine(line, frontmatterEndLineValue)
  ) {
    return "info";
  }
  return "warning";
}

export function frontmatterEndLine(content: string): number | null {
  const lines = content.split("\n");
  if (lines[0] !== "---") return null;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === "---") return i + 1;
  }
  return null;
}

export function brokenWikilinkMessage(
  target: string,
  suggestion: string | null,
): string {
  const base =
    `Wikilink [[${target}]] does not resolve to any markdown file in the vault.`;
  if (suggestion === null) return base;
  return `${base} Did you mean [[${suggestion}]]?`;
}

export function wikilinkReplacementText(
  match: WikilinkMatch,
  target: string,
): string {
  return `[[${target}${wikilinkFragmentSuffix(match.target)}${match.displaySuffix}]]`;
}

export function applyWikilinkReplacements(
  content: string,
  replacements: ReadonlyArray<WikilinkReplacement>,
): string {
  let next = content;
  for (const replacement of [...replacements].sort((a, b) =>
    b.startOffset - a.startOffset
  )) {
    next = `${next.slice(0, replacement.startOffset)}${replacement.text}${next.slice(replacement.endOffset)}`;
  }
  return next;
}

export function wikilinkFragmentSuffix(target: string): string {
  const hash = target.indexOf("#");
  return hash === -1 ? "" : target.slice(hash).trim();
}

export function stubCandidateForWikilinkTarget(
  rawTarget: string,
): WikilinkStubCandidate | null {
  if (isSkippedWikilinkTarget(rawTarget)) return null;
  const target = stripWikilinkFragment(rawTarget);
  if (target.length === 0) return null;
  if (!target.includes("/")) return null;
  if (target.startsWith("/") || target.includes("\\")) return null;

  const path = target.endsWith(".md") ? target : `${target}.md`;
  const segments = path.split("/");
  if (
    segments.some((segment) =>
      segment.length === 0 || segment === "." || segment === ".."
    )
  ) {
    return null;
  }

  const type = stubPageTypeForPath(path);
  if (type === null) return null;
  const basename = path.slice(path.lastIndexOf("/") + 1, -3);
  if (basename.trim().length === 0) return null;
  return Object.freeze({
    path,
    type,
    name: displayNameForStubBasename(basename),
  });
}

export function renderWikilinkStubPage(input: {
  readonly candidate: WikilinkStubCandidate;
  readonly sourcePaths: ReadonlyArray<string>;
}): string {
  const sources = uniqueSourcePaths(input.sourcePaths)
    .map((path) => `[[${path.replace(/\.md$/i, "")}]]`);
  const sourceList = sources.map((source) => `- ${source}`).join("\n");
  const body = [
    "",
    `# ${input.candidate.name}`,
    "",
    "This source-backed stub exists because the linked page was referenced from vault sources.",
    "",
    "## Source Mentions",
    "",
    sourceList,
    "",
  ].join("\n");
  return stringifyFrontmatter(
    body,
    reorderFrontmatterKeys({
      type: input.candidate.type,
      sources,
      name: input.candidate.name,
    }),
  );
}

export function addWikilinkStubRequest<TSourceRef>(
  requests: Map<string, WikilinkStubRequest<TSourceRef>>,
  input: {
    readonly candidate: WikilinkStubCandidate;
    readonly sourcePath: string;
    readonly sourceRef: TSourceRef;
  },
): void {
  const existing = requests.get(input.candidate.path);
  if (existing === undefined) {
    requests.set(input.candidate.path, {
      candidate: input.candidate,
      sourcePaths: [input.sourcePath],
      sourceRefs: [input.sourceRef],
    });
    return;
  }
  requests.set(input.candidate.path, {
    candidate: existing.candidate,
    sourcePaths: [...existing.sourcePaths, input.sourcePath],
    sourceRefs: [...existing.sourceRefs, input.sourceRef],
  });
}

/**
 * A single stub-page write derived from a {@link WikilinkStubRequest}. Plain
 * `{ kind: "write" }` shape so this module stays decoupled from the engine's
 * `FileChangeInput` type; callers spread it into their PatchEffect changes.
 */
export type WikilinkStubWrite = {
  readonly kind: "write";
  readonly path: string;
  readonly content: string;
};

/**
 * Stub requests sorted into deterministic emission order (by candidate path).
 * Both the adoption validator and the scheduled repairer accumulate stub
 * requests in a Map and must emit them in the same order so PatchEffect
 * content stays byte-stable across runs.
 */
export function orderedWikilinkStubRequests<TSourceRef>(
  requests: ReadonlyMap<string, WikilinkStubRequest<TSourceRef>>,
): ReadonlyArray<WikilinkStubRequest<TSourceRef>> {
  return [...requests.values()].sort((a, b) =>
    compareStrings(a.candidate.path, b.candidate.path)
  );
}

/**
 * The stub-page write for a single request: renders the stub body and pairs it
 * with its target path. Shared so both processors render stubs identically.
 */
export function wikilinkStubWrite<TSourceRef>(
  request: WikilinkStubRequest<TSourceRef>,
): WikilinkStubWrite {
  return {
    kind: "write",
    path: request.candidate.path,
    content: renderWikilinkStubPage({
      candidate: request.candidate,
      sourcePaths: request.sourcePaths,
    }),
  };
}

function isFrontmatterLine(
  line: number,
  frontmatterEndLineValue: number | null,
): boolean {
  return frontmatterEndLineValue !== null && line <= frontmatterEndLineValue;
}

type OffsetRange = {
  readonly start: number;
  readonly end: number;
};

function markdownCodeRanges(content: string): ReadonlyArray<OffsetRange> {
  const ranges: OffsetRange[] = [];
  const fencedLineRanges: OffsetRange[] = [];
  let inFence: { marker: "`" | "~"; length: number; start: number } | null = null;
  let lineStart = 0;

  while (lineStart <= content.length) {
    const newline = content.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? content.length : newline;
    const rangeEnd = newline === -1 ? lineEnd : lineEnd + 1;
    const line = content.slice(lineStart, lineEnd);
    const fence = parseFenceMarker(line);

    if (inFence !== null) {
      if (
        fence !== null &&
        fence.marker === inFence.marker &&
        fence.length >= inFence.length
      ) {
        ranges.push({ start: inFence.start, end: rangeEnd });
        fencedLineRanges.push({ start: inFence.start, end: rangeEnd });
        inFence = null;
      }
    } else if (fence !== null) {
      inFence = { ...fence, start: lineStart };
    }

    if (newline === -1) break;
    lineStart = rangeEnd;
  }

  if (inFence !== null) {
    ranges.push({ start: inFence.start, end: content.length });
    fencedLineRanges.push({ start: inFence.start, end: content.length });
  }

  lineStart = 0;
  while (lineStart <= content.length) {
    const newline = content.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? content.length : newline;
    if (!isOffsetInRanges(lineStart, fencedLineRanges)) {
      ranges.push(...inlineCodeRangesForLine(content, lineStart, lineEnd));
    }
    if (newline === -1) break;
    lineStart = lineEnd + 1;
  }

  return ranges;
}

function parseFenceMarker(
  line: string,
): { marker: "`" | "~"; length: number } | null {
  const match = /^(?: {0,3})(`{3,}|~{3,})/.exec(line);
  if (match === null) return null;
  const raw = match[1];
  if (raw === undefined) return null;
  return { marker: raw[0] as "`" | "~", length: raw.length };
}

function inlineCodeRangesForLine(
  content: string,
  lineStart: number,
  lineEnd: number,
): ReadonlyArray<OffsetRange> {
  const ranges: OffsetRange[] = [];
  let cursor = lineStart;
  while (cursor < lineEnd) {
    if (content.charCodeAt(cursor) !== 96 /* ` */) {
      cursor += 1;
      continue;
    }
    const start = cursor;
    while (cursor < lineEnd && content.charCodeAt(cursor) === 96) {
      cursor += 1;
    }
    const length = cursor - start;
    const close = findBacktickRun(content, cursor, lineEnd, length);
    if (close === -1) continue;
    ranges.push({ start, end: close + length });
    cursor = close + length;
  }
  return ranges;
}

function findBacktickRun(
  content: string,
  from: number,
  to: number,
  length: number,
): number {
  for (let cursor = from; cursor < to; cursor += 1) {
    if (content.charCodeAt(cursor) !== 96 /* ` */) continue;
    let end = cursor;
    while (end < to && content.charCodeAt(end) === 96) end += 1;
    if (end - cursor === length) return cursor;
    cursor = end;
  }
  return -1;
}

function isOffsetInRanges(
  offset: number,
  ranges: ReadonlyArray<OffsetRange>,
): boolean {
  return ranges.some((range) => offset >= range.start && offset < range.end);
}

function positionAt(
  content: string,
  offset: number,
): { line: number; col: number } {
  let line = 1;
  let col = 0;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) {
      line += 1;
      col = 0;
    } else {
      col += 1;
    }
  }
  return { line, col };
}

function buildBasenameIndex(
  paths: ReadonlyArray<string>,
): ReadonlyMap<string, ReadonlyArray<string>> {
  const index = new Map<string, string[]>();
  for (const p of paths) {
    const slash = p.lastIndexOf("/");
    const base = slash >= 0 ? p.slice(slash + 1) : p;
    const bucket = index.get(base);
    if (bucket === undefined) {
      index.set(base, [p]);
    } else {
      bucket.push(p);
    }
  }
  return index;
}

type UniqueResolutionIndex = ReadonlyMap<string, string | null>;

type NormalizedResolutionIndex = {
  readonly paths: UniqueResolutionIndex;
  readonly basenames: UniqueResolutionIndex;
};

type WikilinkSuggestionCandidate = {
  readonly linkTarget: string;
  readonly pathKey: string;
  readonly basenameKey: string;
};

type WikilinkSuggestionIndex = ReadonlyArray<WikilinkSuggestionCandidate>;

function buildNormalizedResolutionIndex(
  paths: ReadonlyArray<string>,
): NormalizedResolutionIndex {
  const pathIndex = new Map<string, string | null>();
  const basenameIndex = new Map<string, string | null>();
  for (const path of [...paths].sort()) {
    addUniqueNormalized(pathIndex, normalizeWikilinkKey(path), path);
    const slash = path.lastIndexOf("/");
    const base = slash >= 0 ? path.slice(slash + 1) : path;
    addUniqueNormalized(basenameIndex, normalizeWikilinkKey(base), path);
  }
  return Object.freeze({
    paths: pathIndex,
    basenames: basenameIndex,
  });
}

function buildWikilinkSuggestionIndex(
  paths: ReadonlyArray<string>,
): WikilinkSuggestionIndex {
  return Object.freeze(
    [...paths]
      .filter((path) => path.endsWith(".md"))
      .sort()
      .map((path) => {
        const linkTarget = path.replace(/\.md$/i, "");
        const slash = linkTarget.lastIndexOf("/");
        const basename = slash >= 0 ? linkTarget.slice(slash + 1) : linkTarget;
        return Object.freeze({
          linkTarget,
          pathKey: normalizeWikilinkKey(linkTarget),
          basenameKey: normalizeWikilinkKey(basename),
        });
      }),
  );
}

function addUniqueNormalized(
  index: Map<string, string | null>,
  key: string,
  path: string,
): void {
  if (key.length === 0) return;
  if (!index.has(key)) {
    index.set(key, path);
    return;
  }
  if (index.get(key) !== path) index.set(key, null);
}

function normalizeWikilinkKey(value: string): string {
  return decodeWikilinkComponent(value)
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function decodeWikilinkComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveWikilinkTargetDetailed(
  rawTarget: string,
  currentPath: string,
  pathSet: ReadonlySet<string>,
  basenameIndex: ReadonlyMap<string, ReadonlyArray<string>>,
  normalizedIndex: NormalizedResolutionIndex,
): WikilinkResolution | null {
  if (isSkippedWikilinkTarget(rawTarget)) {
    return resolution(currentPath, "exact-path");
  }

  const target = stripWikilinkFragment(rawTarget);
  if (target.length === 0) return resolution(currentPath, "exact-path");

  if (target.includes("/")) {
    const withMd = target.endsWith(".md") ? target : `${target}.md`;
    if (pathSet.has(withMd)) return resolution(withMd, "exact-path");
    if (pathSet.has(target)) return resolution(target, "exact-path");

    const basename = withMd.slice(withMd.lastIndexOf("/") + 1);
    const candidates = basenameIndex.get(basename);
    if (candidates !== undefined) {
      const needle = `/${withMd}`;
      for (const candidate of candidates) {
        if (candidate.endsWith(needle)) {
          return resolution(candidate, "path-suffix");
        }
      }
    }

    const normalized = normalizedIndex.paths.get(normalizeWikilinkKey(withMd));
    if (normalized !== undefined) {
      return normalized === null
        ? null
        : resolution(normalized, "normalized-path");
    }

    if (candidates !== undefined && candidates.length === 1) {
      const candidate = candidates[0];
      if (candidate !== undefined) {
        return resolution(candidate, "path-basename");
      }
    }

    const normalizedBasename = normalizedIndex.basenames.get(
      normalizeWikilinkKey(basename),
    );
    if (normalizedBasename !== undefined) {
      return normalizedBasename === null
        ? null
        : resolution(normalizedBasename, "normalized-path-basename");
    }

    return null;
  }

  const filename = target.endsWith(".md") ? target : `${target}.md`;

  for (const root of COMMON_ROOTS) {
    const candidate = `${root}${filename}`;
    if (pathSet.has(candidate)) return resolution(candidate, "common-root");
  }

  // Resolve by bare basename only when the match is UNIQUE — mirroring the
  // pathful-alias branch above and the normalized index (which maps
  // ambiguous keys to null). Taking the first of several same-named pages
  // silently validated (and repaired to) whichever sorted first; an
  // ambiguous link must stay unresolved so the validator's
  // multiple-candidates question machinery owns the decision.
  const basenameMatches = basenameIndex.get(filename);
  if (basenameMatches !== undefined && basenameMatches.length === 1) {
    const candidate = basenameMatches[0];
    return candidate === undefined ? null : resolution(candidate, "basename");
  }
  if (basenameMatches !== undefined && basenameMatches.length > 1) {
    return null;
  }

  const normalized = normalizedIndex.basenames.get(
    normalizeWikilinkKey(filename),
  );
  if (normalized !== undefined) {
    return normalized === null
      ? null
      : resolution(normalized, "normalized-basename");
  }

  return null;
}

function resolution(
  path: string,
  kind: WikilinkResolution["kind"],
): WikilinkResolution {
  return Object.freeze({
    path,
    linkTarget: path.replace(/\.md$/i, ""),
    kind,
  });
}

function canonicalReplacementTargetForResolution(
  rawTarget: string,
  resolution: WikilinkResolution,
): string | null {
  const target = stripWikilinkFragment(rawTarget);
  if (!target.includes("/")) return null;
  if (resolution.kind === "exact-path") return null;

  const rawWithoutMd = target.replace(/\.md$/i, "");
  if (rawWithoutMd === resolution.linkTarget) return null;
  return resolution.linkTarget;
}

function suggestWikilinkTargets(
  rawTarget: string,
  index: WikilinkSuggestionIndex,
): WikilinkSuggestionResult {
  if (isSkippedWikilinkTarget(rawTarget)) return { kind: "none" };

  const target = stripWikilinkFragment(rawTarget);
  if (target.length === 0) return { kind: "none" };

  const targetKey = normalizeWikilinkKey(
    target.endsWith(".md") ? target.slice(0, -3) : target,
  );
  if (targetKey.length === 0) return { kind: "none" };

  const targetHasPath = target.includes("/");
  let bestDistance: number | null = null;
  let bestComparedLength: number | null = null;
  let bestTargets: string[] = [];

  for (const candidate of index) {
    const candidateKey = targetHasPath
      ? candidate.pathKey
      : candidate.basenameKey;
    if (candidateKey.length === 0 || candidateKey === targetKey) continue;

    const distance = boundedLevenshteinDistance(
      targetKey,
      candidateKey,
      suggestionDistanceLimit(targetKey, candidateKey),
    );
    if (distance === null) continue;
    if (!isPlausibleSuggestionDistance(targetKey, candidateKey, distance)) {
      continue;
    }

    const comparedLength = Math.max(targetKey.length, candidateKey.length);
    if (
      bestDistance === null ||
      bestComparedLength === null ||
      distance < bestDistance ||
      (distance === bestDistance && comparedLength < bestComparedLength)
    ) {
      bestDistance = distance;
      bestComparedLength = comparedLength;
      bestTargets = [candidate.linkTarget];
    } else if (
      distance === bestDistance &&
      comparedLength === bestComparedLength
    ) {
      bestTargets.push(candidate.linkTarget);
    }
  }

  const uniqueTargets = [...new Set(bestTargets)].sort();
  if (uniqueTargets.length === 0) return { kind: "none" };
  if (uniqueTargets.length === 1) {
    const target = uniqueTargets[0];
    if (target === undefined) return { kind: "none" };
    return { kind: "unique", target };
  }
  return {
    kind: "ambiguous",
    targets: Object.freeze(uniqueTargets.slice(0, 5)),
  };
}

function suggestionDistanceLimit(left: string, right: string): number {
  return Math.max(2, Math.floor(Math.max(left.length, right.length) * 0.18));
}

function isPlausibleSuggestionDistance(
  left: string,
  right: string,
  distance: number,
): boolean {
  const limit = suggestionDistanceLimit(left, right);
  if (distance > limit) return false;
  const shorter = Math.min(left.length, right.length);
  if (shorter <= 4) return distance <= 1;
  if (shorter <= 8) return distance <= 2;
  return true;
}

function isSkippedWikilinkTarget(target: string): boolean {
  if (isExternalUrlTarget(target)) return true;
  if (target.includes("<%") || target.includes("%>")) return true;
  return hasExplicitNonMarkdownExtension(target);
}

function boundedLevenshteinDistance(
  left: string,
  right: string,
  maxDistance: number,
): number | null {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > maxDistance) return null;
  if (left.length === 0) {
    return right.length <= maxDistance ? right.length : null;
  }
  if (right.length === 0) {
    return left.length <= maxDistance ? left.length : null;
  }

  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  let current = new Array<number>(right.length + 1);

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left.charCodeAt(i - 1) === right.charCodeAt(j - 1) ? 0 : 1;
      const deletion = arrayNumberAt(previous, j) + 1;
      const insertion = arrayNumberAt(current, j - 1) + 1;
      const substitution = arrayNumberAt(previous, j - 1) + cost;
      const value = Math.min(deletion, insertion, substitution);
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > maxDistance) return null;
    [previous, current] = [current, previous];
  }

  const distance = arrayNumberAt(previous, right.length);
  return distance <= maxDistance ? distance : null;
}

function arrayNumberAt(values: ReadonlyArray<number>, index: number): number {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`internal distance matrix index ${index} was not initialized`);
  }
  return value;
}

function isExternalUrlTarget(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
}

function stripWikilinkFragment(target: string): string {
  const hash = target.indexOf("#");
  return hash === -1 ? target : target.slice(0, hash).trim();
}

function hasExplicitNonMarkdownExtension(target: string): boolean {
  const pathPart = stripWikilinkFragment(target);
  if (pathPart.length === 0) return false;
  const basename = pathPart.slice(pathPart.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || dot === basename.length - 1) return false;
  return basename.slice(dot + 1).toLowerCase() !== "md";
}

function stubPageTypeForPath(path: string): "concept" | "entity" | null {
  if (path.startsWith("wiki/concepts/")) return "concept";
  if (path.startsWith("wiki/entities/")) return "entity";
  return null;
}

function displayNameForStubBasename(basename: string): string {
  return decodeWikilinkComponent(basename)
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function uniqueSourcePaths(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  return Object.freeze([...new Set(paths)].sort());
}
