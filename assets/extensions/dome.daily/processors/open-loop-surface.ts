import { createHash } from "node:crypto";
import { findGeneratedBlock } from "../../../../src/core/generated-block";
import { compareStrings } from "../../../../src/core/compare";
import {
  DAILY_OWNER,
  OPEN_LOOPS_BLOCK,
  OPEN_LOOPS_START,
  OPEN_LOOPS_END,
  CARRIED_FORWARD_BLOCK,
  DEFAULT_DAILY_PATH_SETTINGS,
  type DailyPathSettings,
  type DailyOpenLoopSource,
  type DailyOpenLoopCandidate,
  type DailySettledOpenLoopSource,
  type DailyOpenLoopSettlementStatus,
} from "./daily-types";
import {
  parseDailyPath,
  formatDate,
} from "./daily-paths";
import {
  actionItemsFromMarkdown,
  duplicateTaskAnchorsFromMarkdown,
  isObsidianTasksDashboard,
  normalizeSourcePath,
  normalizeOpenLoopBody,
  lineIsInsideRanges,
  lineNumberAtOffset,
  isSurfaceEligibleNonDailyAction,
  sourceBackedCheckboxFromLine,
  isOpenCheckboxLine,
  dailyGeneratedBlockLineRanges,
} from "./action-extraction";

export function openLoopSurfaceSources(input: {
  readonly path: string;
  readonly content: string;
  readonly settings?: DailyPathSettings;
}): ReadonlyArray<DailyOpenLoopSource> {
  const generatedRanges = dailyGeneratedBlockLineRanges(input.content);
  const isDailySource =
    parseDailyPath(input.path, input.settings ?? DEFAULT_DAILY_PATH_SETTINGS) !==
    null;
  const collidedAnchors = new Set(
    duplicateTaskAnchorsFromMarkdown(input.content).map(
      (collision) => collision.anchor,
    ),
  );
  const items: DailyOpenLoopSource[] = [];
  for (const item of actionItemsFromMarkdown(input.content)) {
    if (lineIsInsideRanges(item.line, generatedRanges)) continue;
    if (!isDailySource && !isSurfaceEligibleNonDailyAction(item)) {
      continue;
    }
    const anchor = item.anchor === undefined || collidedAnchors.has(item.anchor)
      ? undefined
      : item.anchor;
    items.push(
      Object.freeze({
        line: item.line,
        stableId: taskStableId({
          sourcePath: input.path,
          body: item.body,
          ...(anchor !== undefined ? { anchor } : {}),
        }),
        body: item.body,
        followup: item.followup,
        sourcePath: input.path,
        ...(anchor !== undefined ? { anchor } : {}),
      }),
    );
  }
  return Object.freeze(items);
}

export function openLoopSurfaceSection(input: {
  readonly items: ReadonlyArray<DailyOpenLoopSource>;
  readonly settledItems?: ReadonlyArray<DailySettledOpenLoopSource>;
}): string | null {
  const settledItems = input.settledItems ?? [];
  if (input.items.length === 0 && settledItems.length === 0) return null;
  const lines = [OPEN_LOOPS_START];
  if (input.items.length > 0) {
    lines.push(
      "### Source-backed Open Loops",
      ...input.items.map(renderOpenLoopSource),
    );
  }
  if (settledItems.length > 0) {
    if (input.items.length > 0) lines.push("");
    const resolved = settledItems.filter((item) => item.status === "resolved");
    const dismissed = settledItems.filter((item) =>
      item.status === "dismissed"
    );
    if (resolved.length > 0) {
      lines.push(
        "### Resolved Today",
        ...resolved.map(renderSettledOpenLoopSource),
      );
    }
    if (dismissed.length > 0) {
      if (resolved.length > 0) lines.push("");
      lines.push(
        "### Dismissed Today",
        ...dismissed.map(renderSettledOpenLoopSource),
      );
    }
  }
  lines.push(OPEN_LOOPS_END);
  return lines.join("\n");
}

export function settledSourceBackedOpenLoopsFromMarkdown(input: {
  readonly path: string;
  readonly content: string;
}): ReadonlyArray<DailySettledOpenLoopSource> {
  const items: DailySettledOpenLoopSource[] = [];
  const lines = input.content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const item = sourceBackedCheckboxFromLine(lines[i] ?? "", i + 1);
    if (item === null || item.status === "open") continue;
    items.push(
      Object.freeze({
        line: item.line,
        stableId: taskStableId({
          sourcePath: item.sourcePath,
          body: item.body,
          ...(item.anchor !== undefined ? { anchor: item.anchor } : {}),
        }),
        path: input.path,
        body: item.body,
        followup: item.followup,
        sourcePath: item.sourcePath,
        status: item.status,
        ...(item.anchor !== undefined ? { anchor: item.anchor } : {}),
      }),
    );
  }
  return Object.freeze(items);
}

export function openSourceBackedOpenLoopsFromMarkdown(input: {
  readonly path: string;
  readonly content: string;
}): ReadonlyArray<DailyOpenLoopSource> {
  const items: DailyOpenLoopSource[] = [];
  const lines = input.content.split(/\r?\n/);
  const range = openLoopsBlockLineRange(input.content);
  if (range === null) return Object.freeze(items);
  for (let i = 0; i < lines.length; i += 1) {
    const line = i + 1;
    if (line < range.start || line > range.end) continue;
    const item = sourceBackedCheckboxFromLine(lines[i] ?? "", i + 1);
    if (item === null || item.status !== "open") continue;
    items.push(
      Object.freeze({
        line: item.line,
        stableId: taskStableId({
          sourcePath: item.sourcePath,
          body: item.body,
          ...(item.anchor !== undefined ? { anchor: item.anchor } : {}),
        }),
        body: item.body,
        followup: item.followup,
        sourcePath: item.sourcePath,
        ...(item.anchor !== undefined ? { anchor: item.anchor } : {}),
      }),
    );
  }
  return Object.freeze(items);
}

/**
 * Propagate a *settled* (resolved/dismissed) state from generated source-backed
 * open-loop copies in daily notes BACK to the origin task line in its source
 * file — "close it in one place, close it everywhere."
 *
 * Across all `files`, every settled
 * `- [x]/[-] body (from [[origin]]) ^anchor` copy yields a target
 * `{ sourcePath, body, status, anchor? }`. For each target, the file at
 * `sourcePath` (matched within the same `files` list, path-normalized with
 * `.md`) is scanned for the matching OPEN action-item line. Matching prefers
 * the projected `^anchor`, so resolution notes or other body edits on the
 * daily copy still close the origin. Legacy unanchored copies fall back to
 * normalized body matching; ambiguous matches are skipped rather than guessed.
 * Only the checkbox marker is rewritten (`[ ]` → `[x]` for resolved,
 * `[ ]` → `[-]` for dismissed). The rest of the origin line — trailing
 * `^anchor`, tags, origin marker — is preserved verbatim, and no line is ever
 * deleted. The daily's own generated copy is never modified.
 *
 * Only files whose content changed are returned. The transform is idempotent:
 * an already-settled origin line yields no change, so a re-run over the output
 * returns `[]`.
 */
export function reconcileSettledOpenLoops(input: {
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
}): ReadonlyArray<{ readonly path: string; readonly content: string }> {
  const contentByPath = new Map<string, string>();
  for (const file of input.files) {
    contentByPath.set(normalizeSourcePath(file.path), file.content);
  }

  const targets: DailySettledOpenLoopSource[] = [];
  for (const file of input.files) {
    targets.push(
      ...settledSourceBackedOpenLoopsFromMarkdown({
        path: file.path,
        content: file.content,
      }),
    );
  }

  // Track which origin lines have already been consumed so two settled copies
  // of the same body don't both claim the same open line.
  const consumedLines = new Map<string, Set<number>>();
  const rewrites = new Map<string, string>();

  for (const target of targets) {
    const originPath = normalizeSourcePath(target.sourcePath);
    const current = rewrites.get(originPath) ?? contentByPath.get(originPath);
    if (current === undefined) continue;
    // Never rewrite an Obsidian Tasks plugin dashboard back-propagating a close.
    if (isObsidianTasksDashboard(current)) continue;

    const consumed = consumedLines.get(originPath) ?? new Set<number>();
    const openItems = actionItemsFromMarkdown(current).filter(
      (item) =>
        item.kind === "checkbox" &&
        !consumed.has(item.line),
    );
    const anchorMatches =
      target.anchor === undefined
        ? []
        : openItems.filter((item) => item.anchor === target.anchor);
    const wantBody = reconcileBodyKey(target.body);
    const matches =
      anchorMatches.length > 0
        ? anchorMatches
        : openItems.filter((item) => reconcileBodyKey(item.body) === wantBody);
    // Prefer the projected `^anchor` when present: it survives body edits on
    // the daily copy, including resolution notes. Legacy unanchored copies
    // still fall back to the historical body match; ambiguous matches are
    // skipped rather than guessed.
    if (matches.length !== 1) continue;
    const match = matches[0];
    if (match === undefined) continue;

    const next = settleCheckboxLine(current, match.line, target.status);
    if (next === null) continue;

    consumed.add(match.line);
    consumedLines.set(originPath, consumed);
    rewrites.set(originPath, next);
  }

  const out: { readonly path: string; readonly content: string }[] = [];
  for (const file of input.files) {
    const originPath = normalizeSourcePath(file.path);
    const next = rewrites.get(originPath);
    if (next === undefined || next === file.content) continue;
    out.push(Object.freeze({ path: file.path, content: next }));
  }
  return Object.freeze(out);
}

/**
 * Body-match key for reconciliation. The surfaced daily copy renders open-loop
 * bodies with leading `#task`/`#followup` tags stripped (only `#followup` is
 * re-prepended), while the origin line may carry those tags inline. Comparing
 * with tags removed (wherever they sit on the line) lets the daily copy line up
 * with its origin regardless of tag placement.
 */
function reconcileBodyKey(body: string): string {
  return normalizeOpenLoopBody(body)
    .replace(/(^|\s)#(?:task|follow-?up)(?=\s|$)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Rewrite the open `[ ]` marker on the given 1-based line to the settled
 * marker (`x` resolved / `-` dismissed), preserving the rest of the line
 * verbatim. Returns `null` when the line is missing or not an open checkbox.
 */
function settleCheckboxLine(
  content: string,
  lineNumber: number,
  status: DailyOpenLoopSettlementStatus,
): string | null {
  const lines = content.split(/\r?\n/);
  const idx = lineNumber - 1;
  const line = lines[idx];
  if (line === undefined || !isOpenCheckboxLine(line)) return null;
  const marker = status === "dismissed" ? "-" : "x";
  lines[idx] = line.replace(/^(\s*[-*]\s+)\[ \]/, `$1[${marker}]`);
  return lines.join("\n");
}

export function completedSourceBackedOpenLoopsFromMarkdown(input: {
  readonly path: string;
  readonly content: string;
}): ReadonlyArray<DailySettledOpenLoopSource> {
  return Object.freeze(
    settledSourceBackedOpenLoopsFromMarkdown(input).filter((item) =>
      item.status === "resolved"
    ),
  );
}

export function openLoopIdentity(input: {
  readonly sourcePath: string;
  readonly body: string;
  readonly anchor?: string;
}): string {
  return taskStableId(input);
}

export function openLoopSurfaceKey(input: { readonly body: string }): string {
  return normalizeOpenLoopBody(input.body);
}

/**
 * The canonical stable identity for an action item. When the line carries a
 * stamped `^block-anchor`, identity is the anchor — path-independent and
 * move-stable, surviving relocation and body edits. Otherwise it falls back to
 * the legacy path+body hash, so unstamped tasks keep their prior identity
 * during the transition. Both forms share the `dome.daily.open-loop:` prefix
 * so prefix-scoped consumers are unaffected.
 */
export function taskStableId(input: {
  readonly sourcePath: string;
  readonly body: string;
  readonly anchor?: string;
}): string {
  if (input.anchor !== undefined) {
    return `dome.daily.open-loop:${input.anchor}`;
  }
  return openLoopStableId({ sourcePath: input.sourcePath, body: input.body });
}

// The 24-char slice + `dome.daily.open-loop:` prefix is durable open-loop
// identity, deliberately NOT folded into `contentAnchorId` (different length,
// different collision budget); pinned by golden tests.
export function openLoopStableId(input: {
  readonly sourcePath: string;
  readonly body: string;
}): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        normalizeSourcePath(input.sourcePath),
        normalizeOpenLoopBody(input.body),
      ]),
    )
    .digest("hex")
    .slice(0, 24);
  return `dome.daily.open-loop:${hash}`;
}

export function rankDailyOpenLoopSurfaceItems(
  items: ReadonlyArray<DailyOpenLoopCandidate>,
  limit = 12,
): ReadonlyArray<DailyOpenLoopSource> {
  if (limit <= 0) return Object.freeze([]);
  const seen = new Set<string>();
  const seenSurface = new Set<string>();
  const out: DailyOpenLoopSource[] = [];
  for (const item of [...items].sort(compareOpenLoopSources)) {
    const key = openLoopIdentity(item);
    if (seen.has(key)) continue;
    seen.add(key);
    const surfaceKey = openLoopSurfaceKey(item);
    if (seenSurface.has(surfaceKey)) continue;
    seenSurface.add(surfaceKey);
    out.push(stripCandidateMetadata(item));
    if (out.length >= limit) break;
  }
  return Object.freeze(out);
}

export function openLoopFreshnessKey(input: {
  readonly path: string;
  readonly lastChangedAt: string | null | undefined;
  readonly settings?: DailyPathSettings;
}): string {
  const dailyDate = parseDailyPath(
    input.path,
    input.settings ?? DEFAULT_DAILY_PATH_SETTINGS,
  );
  if (dailyDate !== null) return `${formatDate(dailyDate)}T00:00:00.000Z`;
  return input.lastChangedAt ?? "";
}

export function replaceOpenLoopSurfaceSection(input: {
  readonly content: string;
  readonly section: string | null;
}): string {
  const existing = dailyGeneratedBlockRange(input.content);
  if (existing !== null) {
    if (
      input.section !== null &&
      shouldRelocateExistingOpenLoopSurface(input.content, existing.start)
    ) {
      return insertOpenLoopSurfaceSection({
        content: removeGeneratedOpenLoopSurface(input.content, existing),
        section: input.section,
      });
    }
    const replacement = input.section === null ? "" : input.section;
    return `${input.content.slice(0, existing.start)}${replacement}${input.content.slice(existing.end)}`;
  }
  if (input.section === null) return input.content;

  return insertOpenLoopSurfaceSection({
    content: input.content,
    section: input.section,
  });
}

function insertOpenLoopSurfaceSection(input: {
  readonly content: string;
  readonly section: string;
}): string {
  const openLoops = /^## Open Loops[ \t]*$/m.exec(input.content);
  if (openLoops !== null && openLoops.index !== undefined) {
    const insertAt = openLoops.index + openLoops[0].length;
    const rest = input.content.slice(insertAt).replace(/^(?:\r?\n)*/, "\n\n");
    return `${input.content.slice(0, insertAt)}\n\n${input.section}${rest}`;
  }

  const todayTasks = /^#{1,3} Today's tasks[ \t]*$/im.exec(input.content);
  if (todayTasks !== null && todayTasks.index !== undefined) {
    const insertAt = endOfHeadingSection(input.content, todayTasks);
    const before = input.content.slice(0, insertAt).trimEnd();
    const after = input.content.slice(insertAt).replace(/^(?:\r?\n)*/, "");
    return `${before}\n\n## Open Loops\n\n${input.section}\n\n${after}`;
  }

  const notes = /^## Notes[ \t]*$/m.exec(input.content);
  if (notes !== null && notes.index !== undefined) {
    return `${input.content.slice(0, notes.index)}## Open Loops\n\n${input.section}\n\n${input.content.slice(notes.index)}`;
  }

  const suffix = input.content.endsWith("\n") ? "" : "\n";
  return `${input.content}${suffix}\n## Open Loops\n\n${input.section}\n`;
}

// Render a source-backed open-loop line. The two former twin renderers
// differed ONLY in the checkbox marker — open loops use a blank `[ ]`, settled
// loops use `[x]` (resolved) / `[-]` (dismissed). The `#followup` prefix, body,
// and `(from [[…]])` suffix are identical in both.
function renderOpenLoopSourceLine(
  item: {
    readonly followup: boolean;
    readonly body: string;
    readonly sourcePath: string;
    readonly anchor?: string;
  },
  marker: string,
): string {
  const followup = item.followup ? "#followup " : "";
  const anchor = item.anchor === undefined ? "" : ` ^${item.anchor}`;
  return `- [${marker}] ${followup}${item.body} (from [[${item.sourcePath.replace(/\.md$/, "")}]])${anchor}`;
}

function renderOpenLoopSource(item: DailyOpenLoopSource): string {
  return renderOpenLoopSourceLine(item, " ");
}

function renderSettledOpenLoopSource(
  item: DailySettledOpenLoopSource,
): string {
  return renderOpenLoopSourceLine(item, item.status === "dismissed" ? "-" : "x");
}

function stripCandidateMetadata(
  item: DailyOpenLoopCandidate,
): DailyOpenLoopSource {
  return Object.freeze({
    line: item.line,
    stableId: item.stableId,
    body: item.body,
    followup: item.followup,
    sourcePath: item.sourcePath,
    ...(item.anchor !== undefined ? { anchor: item.anchor } : {}),
  });
}

function compareOpenLoopSources(
  a: DailyOpenLoopCandidate,
  b: DailyOpenLoopCandidate,
): number {
  const changedCmp = compareStrings(b.lastChangedAt, a.lastChangedAt);
  if (changedCmp !== 0) return changedCmp;
  const pathCmp = compareStrings(a.sourcePath, b.sourcePath);
  if (pathCmp !== 0) return pathCmp;
  const lineCmp = a.line - b.line;
  if (lineCmp !== 0) return lineCmp;
  return compareStrings(a.body, b.body);
}

function shouldRelocateExistingOpenLoopSurface(
  content: string,
  existingStart: number,
): boolean {
  if (/^#{1,3} Today's tasks[ \t]*$/im.exec(content) === null) return false;
  const workLogHeading =
    /^# (?:What did I get done today\?|Story of the day)[ \t]*$/im.exec(content);
  return (
    workLogHeading !== null &&
    workLogHeading.index !== undefined &&
    existingStart > workLogHeading.index
  );
}

function removeGeneratedOpenLoopSurface(
  content: string,
  range: { readonly start: number; readonly end: number },
): string {
  const heading = precedingOpenLoopsHeadingRange(content, range.start);
  if (heading === null || !openLoopsHeadingWouldBeEmpty(content, heading, range)) {
    return `${content.slice(0, range.start)}${content.slice(range.end)}`;
  }
  const start = trimBackwardBlankLines(content, heading.start);
  const end = trimForwardOneBlankLine(content, range.end);
  return `${content.slice(0, start)}${content.slice(end)}`;
}

function precedingOpenLoopsHeadingRange(
  content: string,
  blockStart: number,
): { readonly start: number; readonly end: number } | null {
  const before = content.slice(0, blockStart);
  const match = /(^|\n)(## Open Loops[ \t]*)(?:\r?\n[ \t]*)*$/m.exec(before);
  if (match === null || match.index === undefined) return null;
  const prefix = match[1] ?? "";
  const heading = match[2] ?? "";
  const start = match.index + prefix.length;
  return Object.freeze({
    start,
    end: start + heading.length,
  });
}

function openLoopsHeadingWouldBeEmpty(
  content: string,
  heading: { readonly end: number },
  block: { readonly start: number; readonly end: number },
): boolean {
  if (content.slice(heading.end, block.start).trim().length > 0) return false;
  const nextHeading = /^#{1,6} .+$/m.exec(content.slice(block.end));
  const afterBlock =
    nextHeading === null
      ? content.slice(block.end)
      : content.slice(block.end, block.end + nextHeading.index);
  return afterBlock.trim().length === 0;
}

function trimBackwardBlankLines(content: string, offset: number): number {
  let i = offset;
  while (i > 0 && (content[i - 1] === "\n" || content[i - 1] === "\r")) {
    i -= 1;
  }
  return i;
}

function trimForwardOneBlankLine(content: string, offset: number): number {
  const match = /^(?:\r?\n){0,2}/.exec(content.slice(offset));
  return offset + (match?.[0].length ?? 0);
}

export function endOfHeadingSection(content: string, heading: RegExpExecArray): number {
  const headingLine = heading[0] ?? "";
  const headingLevel = headingLine.match(/^#+/)?.[0].length ?? 1;
  const bodyStart = heading.index + headingLine.length;
  const rest = content.slice(bodyStart);
  const nextHeadingRe = /^#{1,6} .+$/gm;
  let match: RegExpExecArray | null;
  while ((match = nextHeadingRe.exec(rest)) !== null) {
    const level = match[0]?.match(/^#+/)?.[0].length ?? 1;
    if (level <= headingLevel) return bodyStart + match.index;
  }
  return content.length;
}

/**
 * Bound a dome.daily generated block via the core grammar primitive's
 * line-anchored scan (a marker counts only when the entire trimmed line is
 * the marker — prose/fence mentions and mid-line smuggles never bound a
 * block; the historical indexOf bounding here was the weaker form of the
 * marker-injection bug fixed in the brief and preferences splices).
 */
export function dailyBlockRange(
  content: string,
  block: string,
): { readonly start: number; readonly end: number } | null {
  return dailyBlockRangeFor(content, DAILY_OWNER, block);
}

export function dailyBlockRangeFor(
  content: string,
  owner: string,
  block: string,
): { readonly start: number; readonly end: number } | null {
  const { range } = findGeneratedBlock(content, owner, block);
  if (range === null) return null;
  return Object.freeze({ start: range.start, end: range.end });
}

export function carriedForwardBlockRange(
  content: string,
): { readonly start: number; readonly end: number } | null {
  return dailyBlockRange(content, CARRIED_FORWARD_BLOCK);
}

function openLoopsBlockRange(
  content: string,
): { readonly start: number; readonly end: number } | null {
  return dailyBlockRange(content, OPEN_LOOPS_BLOCK);
}

function openLoopsBlockLineRange(
  content: string,
): { readonly start: number; readonly end: number } | null {
  const range = openLoopsBlockRange(content);
  if (range === null) return null;
  return Object.freeze({
    start: lineNumberAtOffset(content, range.start),
    end: lineNumberAtOffset(content, range.end),
  });
}

export function dailyGeneratedBlockRange(
  content: string,
): { readonly start: number; readonly end: number } | null {
  return openLoopsBlockRange(content) ?? carriedForwardBlockRange(content);
}
