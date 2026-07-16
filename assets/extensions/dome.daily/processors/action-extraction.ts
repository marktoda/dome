import {
  appendBlockAnchor,
  contentAnchorId,
  hasBlockAnchor,
  parseBlockAnchor,
} from "../../../../src/core/block-anchor";
import {
  findGeneratedBlock,
} from "../../../../src/core/generated-block";
import {
  fencedCodeBlockLineRanges,
  frontmatterLineRange,
} from "../../../../src/core/markdown-scan";
import {
  DAILY_GENERATED_BLOCKS,
  DAILY_OWNER,
  CAPTURED_BLOCK,
  CARRY_FORWARD_RE,
  type OpenTask,
  type MarkdownActionItem,
  type AmbiguousFollowup,
  type SettledActionItem,
  type DailyOpenLoopSettlementStatus,
} from "./daily-types";

/** A `(from [[…]])` provenance suffix — the carry-forward COPY shape. */
export const SOURCE_BACKED_SUFFIX_RE =
  /\(from \[\[[^\]\n]+\]\]\)(?:\s+\^[A-Za-z0-9][A-Za-z0-9-]*)?\s*$/;

// ── The origin marker — ([↗](target)) — a task's source provenance ──────────
// Canonical home (captured-block re-exports). The target is percent-encoded on
// ( and ) so the body regex stays [^)]*-simple even for URLs with parentheses.
export const ORIGIN_MARKER_RE = /\(\[↗\]\(/; // detection (opening syntax)
const ORIGIN_MARKER_FULL_RE = /\s*\(\[↗\]\(([^)]*)\)\)/; // capture the encoded target

function encodeTarget(target: string): string {
  return target.replace(/%/g, "%25").replace(/\(/g, "%28").replace(/\)/g, "%29");
}
function decodeTarget(target: string): string {
  return target.replace(/%28/g, "(").replace(/%29/g, ")").replace(/%25/g, "%");
}

/** Stamp ` ([↗](target))` onto a task line, before any trailing ^anchor.
 *  Idempotent; empty target is a no-op; ( and ) in target are percent-encoded. */
export function appendOriginMarker(line: string, target: string): string {
  if (target === "" || ORIGIN_MARKER_RE.test(line)) return line;
  const encoded = encodeTarget(target);
  const parsed = parseBlockAnchor(line);
  if (parsed !== null) return `${parsed.withoutAnchor} ([↗](${encoded})) ^${parsed.id}`;
  return `${line.trimEnd()} ([↗](${encoded}))`;
}

/** Remove the origin marker from a string (body or whole line). No-op if absent. */
export function stripOriginMarker(body: string): string {
  return body.replace(ORIGIN_MARKER_FULL_RE, "");
}

/** Parse the origin out of a line: { body (marker removed), target (decoded) }, or null.
 *  The returned `body` retains any trailing `^anchor` (only the marker is removed). */
export function parseOriginMarker(line: string): { readonly body: string; readonly target: string } | null {
  const m = ORIGIN_MARKER_FULL_RE.exec(line);
  if (m === null || m[1] === undefined) return null;
  return Object.freeze({ body: stripOriginMarker(line), target: decodeTarget(m[1]) });
}

export type SourceBackedCheckbox = {
  readonly line: number;
  readonly status: "open" | DailyOpenLoopSettlementStatus;
  readonly body: string;
  readonly followup: boolean;
  readonly sourcePath: string;
  readonly anchor?: string;
};

export type DuplicateTaskAnchorOccurrence = {
  readonly line: number;
  readonly body: string;
  readonly text: string;
};

export type DuplicateTaskAnchor = {
  readonly anchor: string;
  readonly occurrences: ReadonlyArray<DuplicateTaskAnchorOccurrence>;
};

export function openTasksFromMarkdown(content: string): ReadonlyArray<OpenTask> {
  const tasks: OpenTask[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!isOpenCheckboxLine(line)) continue;
    tasks.push(openTaskFromLine(line, i + 1));
  }
  return Object.freeze(tasks);
}

export function actionItemsFromMarkdown(
  content: string,
): ReadonlyArray<MarkdownActionItem> {
  const items: MarkdownActionItem[] = [];
  const lines = content.split(/\r?\n/);
  const ignoredRanges = actionExtractionLineRanges(content);
  for (let i = 0; i < lines.length; i += 1) {
    if (lineIsInsideRanges(i + 1, ignoredRanges)) continue;
    const line = lines[i] ?? "";
    if (isOpenCheckboxLine(line)) {
      const task = openTaskFromLine(line, i + 1);
      items.push(
        Object.freeze({
          line: task.line,
          text: task.text,
          body: task.body,
          followup: task.followup,
          kind: "checkbox" as const,
          ...(task.origin !== undefined ? { origin: task.origin } : {}),
          ...(task.anchor !== undefined ? { anchor: task.anchor } : {}),
        }),
      );
      continue;
    }

    const directive = directiveActionItemFromLine(line, i + 1);
    if (directive !== null) items.push(directive);
  }
  return Object.freeze(items);
}

/**
 * True when the file is an Obsidian Tasks plugin query dashboard — it contains
 * a fenced ` ```tasks ` (or `~~~tasks`) query block. Such files are managed by
 * the plugin (which parses task lines and would choke on a `^anchor` suffix),
 * so the task-lifecycle rewriters (stamp / normalize / reconcile) leave the
 * whole file alone. Read-only parsing (`actionItemsFromMarkdown`) is
 * unaffected; task-index still applies the shared daily/non-daily global-task
 * eligibility rule before projecting facts.
 */
export function isObsidianTasksDashboard(content: string): boolean {
  return /^[ ]{0,3}(?:```|~~~)\s*tasks(?:\s|$)/m.test(content);
}

/**
 * Stamp a stable `^block-anchor` onto every action-item line that lacks one,
 * returning the rewritten document — or `null` when nothing needs stamping
 * (the idempotent fixed point). The stamped line-set is exactly
 * {@link actionItemsFromMarkdown}, so identity and surfacing agree and
 * generated blocks (which that extractor already skips) are never stamped.
 *
 * The anchor id is a deterministic function of the normalized source path,
 * the normalized task body, and the body's occurrence index within the file —
 * so it is reproducible (rebuild-safe), collision-resistant, and unique even
 * for two identical-body tasks in one file. Once stamped, a line carries its
 * identity in the markdown itself and survives moves and body edits.
 */
export function stampTaskAnchors(input: {
  readonly path: string;
  readonly content: string;
}): string | null {
  if (isObsidianTasksDashboard(input.content)) return null;
  const lines = input.content.split(/\r?\n/);
  const actionItemsByLine = new Map(
    actionItemsFromMarkdown(input.content).map((item) => [item.line, item]),
  );
  const occurrences = new Map<string, number>();
  const ignoredRanges = actionExtractionLineRanges(input.content);
  let changed = false;
  for (let idx = 0; idx < lines.length; idx += 1) {
    const lineNumber = idx + 1;
    if (lineIsInsideRanges(lineNumber, ignoredRanges)) continue;
    const line = lines[idx];
    if (line === undefined) continue;
    const occurrenceSource = originTaskIdentityLineFromLine(line, lineNumber);
    if (occurrenceSource === null) continue;
    const bodyKey = normalizeOpenLoopBody(occurrenceSource.body);
    const occurrence = occurrences.get(bodyKey) ?? 0;
    occurrences.set(bodyKey, occurrence + 1);
    const item = actionItemsByLine.get(lineNumber);
    if (item === undefined || hasBlockAnchor(line)) continue;
    lines[idx] = appendBlockAnchor(
      line,
      taskAnchorId({ path: input.path, body: item.body, occurrence }),
    );
    changed = true;
  }
  return changed ? lines.join("\n") : null;
}

export function duplicateTaskAnchorsFromMarkdown(
  content: string,
): ReadonlyArray<DuplicateTaskAnchor> {
  if (isObsidianTasksDashboard(content)) return Object.freeze([]);
  const byAnchor = new Map<string, DuplicateTaskAnchorOccurrence[]>();
  const lines = content.split(/\r?\n/);
  const ignoredRanges = actionExtractionLineRanges(content);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const lineNumber = idx + 1;
    if (lineIsInsideRanges(lineNumber, ignoredRanges)) continue;
    const line = lines[idx] ?? "";
    const parsed = parseBlockAnchor(line);
    if (parsed === null) continue;
    const occurrenceSource = originTaskIdentityLineFromLine(line, lineNumber);
    if (occurrenceSource === null) continue;
    const occurrences = byAnchor.get(parsed.id) ?? [];
    occurrences.push(
      Object.freeze({
        line: lineNumber,
        body: occurrenceSource.body,
        text: line.trim(),
      }),
    );
    byAnchor.set(parsed.id, occurrences);
  }
  const duplicates: DuplicateTaskAnchor[] = [];
  for (const [anchor, occurrences] of byAnchor) {
    if (occurrences.length < 2) continue;
    duplicates.push(
      Object.freeze({
        anchor,
        occurrences: Object.freeze([...occurrences]),
      }),
    );
  }
  return Object.freeze(duplicates);
}

/**
 * Normalize the *cosmetic* syntax of task lines, returning the rewritten
 * document — or `null` when nothing needs normalizing (the idempotent fixed
 * point). Operates on the same checkbox lines {@link actionItemsFromMarkdown}
 * targets, sharing its generated/ignored-range exclusions (frontmatter and
 * dome.daily-generated blocks are never touched), so cosmetic cleanup and
 * surfacing agree.
 *
 * Three safe, deterministic, idempotent rewrites — casing and spacing only,
 * never semantics:
 *   1. Uppercase checkbox marker `- [X]` → `- [x]` (`[ ]`/`[-]` left as-is).
 *   2. Collapse the run of spaces immediately after `]` to exactly one.
 *   3. Trim trailing whitespace, preserving a trailing `^block-anchor` exactly.
 *
 * Non-task lines, anchors, tags, line count, and all other internal spacing are
 * preserved verbatim, so a re-run over the output returns `null`.
 */
export function normalizeTaskSyntax(content: string): string | null {
  if (isObsidianTasksDashboard(content)) return null;
  const lines = content.split(/\r?\n/);
  const ignoredRanges = actionExtractionLineRanges(content);
  let changed = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (lineIsInsideRanges(i + 1, ignoredRanges)) continue;
    const line = lines[i] ?? "";
    if (!isAnyCheckboxLine(line)) continue;
    const next = normalizeTaskLineSyntax(line);
    if (next !== line) {
      lines[i] = next;
      changed = true;
    }
  }
  return changed ? lines.join("\n") : null;
}

/** Any checkbox task line, regardless of marker state (` `, `x`, `X`, `-`). */
function isAnyCheckboxLine(line: string): boolean {
  return /^\s*[-*]\s+\[[ xX-]\]/.test(line);
}

/**
 * Apply the cosmetic normalizations to a single checkbox line: lowercase an
 * uppercase `X` marker, collapse the post-marker space run to one, and trim
 * trailing whitespace while preserving any trailing `^block-anchor`.
 */
function normalizeTaskLineSyntax(line: string): string {
  let next = line.replace(/^(\s*[-*]\s+)\[X\]/, "$1[x]");
  next = next.replace(/^(\s*[-*]\s+\[[ x-]\]) +/, "$1 ");
  const anchor = parseBlockAnchor(next);
  if (anchor !== null) {
    return `${anchor.withoutAnchor} ^${anchor.id}`;
  }
  return next.trimEnd();
}

/**
 * Deterministic, collision-resistant block-anchor id for a task line. The
 * `t` prefix namespaces Dome task anchors away from hand-authored block refs.
 */
export function taskAnchorId(input: {
  readonly path: string;
  readonly body: string;
  readonly occurrence: number;
}): string {
  return contentAnchorId("t", [
    normalizeSourcePath(input.path),
    normalizeOpenLoopBody(input.body),
    input.occurrence,
  ]);
}

export function ambiguousFollowupsFromMarkdown(
  content: string,
): ReadonlyArray<AmbiguousFollowup> {
  const items: AmbiguousFollowup[] = [];
  const lines = content.split(/\r?\n/);
  const ignoredRanges = actionExtractionLineRanges(content);
  for (let i = 0; i < lines.length; i += 1) {
    if (lineIsInsideRanges(i + 1, ignoredRanges)) continue;
    const line = lines[i] ?? "";
    if (line.trimStart().startsWith(">")) continue;
    if (isCheckboxLine(line)) continue;
    if (directiveActionItemFromLine(line, i + 1) !== null) continue;
    if (!looksLikeAmbiguousFollowup(line)) continue;
    items.push(
      Object.freeze({
        line: i + 1,
        text: line.trim(),
      }),
    );
  }
  return Object.freeze(items);
}

/**
 * Settled (`[x]`/`[-]`) checkbox lines authored directly in a note — outside
 * generated blocks, fences, and frontmatter, and excluding source-backed
 * `(from [[origin]])` copies (those are derived separately and carry their
 * origin). The direct half of the close's done-candidate derivation
 * ([[wiki/specs/daily-surface]] §"The close block").
 */
export function settledActionItemsFromMarkdown(
  content: string,
): ReadonlyArray<SettledActionItem> {
  const items: SettledActionItem[] = [];
  const lines = content.split(/\r?\n/);
  const ignoredRanges = actionExtractionLineRanges(content);
  for (let i = 0; i < lines.length; i += 1) {
    if (lineIsInsideRanges(i + 1, ignoredRanges)) continue;
    const line = lines[i] ?? "";
    const base = parseBlockAnchor(line)?.withoutAnchor ?? line;
    if (sourceBackedCheckboxFromLine(base, i + 1) !== null) continue;
    const match = /^\s*[-*]\s+\[([xX-])\]\s+(\S.*?)\s*$/.exec(base);
    if (match === null) continue;
    const body = semanticActionBody(stripOriginMarker((match[2] ?? "").trim()));
    if (body.length === 0) continue;
    items.push(
      Object.freeze({
        line: i + 1,
        body,
        status: match[1] === "-" ? ("dismissed" as const) : ("resolved" as const),
      }),
    );
  }
  return Object.freeze(items);
}

/**
 * Line ranges excluded from task/action extraction: frontmatter, fenced code
 * blocks, and Dome-generated daily blocks. Checkbox/directive syntax inside
 * a fence is documentation, not an action item — excluding these ranges
 * keeps task extraction, stamping, and syntax normalization from mutating
 * example code.
 */
export function actionExtractionLineRanges(
  content: string,
): ReadonlyArray<{ readonly start: number; readonly end: number }> {
  const frontmatter = frontmatterLineRange(content);
  return Object.freeze([
    ...dailyGeneratedBlockLineRanges(content),
    ...fencedCodeBlockLineRanges(content),
    ...(frontmatter === null ? [] : [frontmatter]),
  ]);
}

export function dailyGeneratedBlockLineRanges(
  content: string,
): ReadonlyArray<{ readonly start: number; readonly end: number }> {
  const ranges: { start: number; end: number }[] = [];
  // Every recognized daily-note generated block EXCEPT dome.daily:captured
  // is excluded from task extraction. The excluded blocks hold copies or
  // digests (incl. retired-legacy markers and the dual-writer yesterday
  // block, whose mechanical fallback compresses human prose that may contain
  // directive-shaped text) — generated copies must never re-ingest as tasks.
  // dome.daily:captured is deliberately NOT excluded: captured tasks
  // ORIGINATE in the daily (origins, not projection copies), so extraction,
  // stamping, normalization, and open-loop surfacing must all see them.
  for (const block of DAILY_GENERATED_BLOCKS) {
    if (block.owner === DAILY_OWNER && block.block === CAPTURED_BLOCK) {
      continue;
    }
    const { range } = findGeneratedBlock(content, block.owner, block.block);
    if (range === null) continue;
    ranges.push({ start: range.startLine, end: range.endLine });
  }
  return Object.freeze(ranges.map((range) => Object.freeze(range)));
}

export function lineIsInsideRanges(
  line: number,
  ranges: ReadonlyArray<{ readonly start: number; readonly end: number }>,
): boolean {
  return ranges.some((range) => line >= range.start && line <= range.end);
}

export function lineNumberAtOffset(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

export function isOpenCheckboxLine(line: string): boolean {
  return /^\s*[-*]\s+\[ \]\s+\S/.test(line);
}

function isCheckboxLine(line: string): boolean {
  return /^\s*[-*]\s+\[[ xX]\]\s+\S/.test(line);
}

function openTaskFromLine(line: string, lineNumber: number): OpenTask {
  const anchor = parseBlockAnchor(stripCarryForwardSource(line))?.id;
  const originParsed = parseOriginMarker(line);
  return Object.freeze({
    line: lineNumber,
    text: stripCarryForwardSource(line),
    sourcePath: carryForwardSourcePath(line),
    body: taskBodyFromCheckboxLine(line),
    followup: isExplicitFollowup(line),
    ...(anchor !== undefined ? { anchor } : {}),
    ...(originParsed !== null ? { origin: originParsed.target } : {}),
  });
}

function originTaskIdentityLineFromLine(
  line: string,
  lineNumber: number,
): { readonly body: string } | null {
  if (sourceBackedCheckboxFromLine(line, lineNumber) !== null) return null;
  const checkboxBody = taskBodyFromAnyCheckboxLine(line);
  if (checkboxBody !== null) return Object.freeze({ body: checkboxBody });
  const directive = directiveActionItemFromLine(line, lineNumber);
  if (directive === null) return null;
  return Object.freeze({ body: directive.body });
}

function directiveActionItemFromLine(
  line: string,
  lineNumber: number,
): MarkdownActionItem | null {
  const parsedAnchor = parseBlockAnchor(line);
  const lineWithoutAnchor =
    parsedAnchor === null ? line : parsedAnchor.withoutAnchor;
  const match = /^\s*(?:[-*]\s+)?(todo|follow[- ]?up)\s*:\s*(\S.*)$/i.exec(
    lineWithoutAnchor,
  );
  if (match === null) return null;
  const marker = match[1]?.toLowerCase().replace(/\s+/g, "-") ?? "";
  const body = match[2]?.trim();
  if (body === undefined || body.length === 0) return null;
  return Object.freeze({
    line: lineNumber,
    text: line.trim(),
    body: semanticActionBody(body),
    followup:
      marker === "follow-up" ||
      marker === "followup" ||
      isExplicitFollowup(body),
    kind: "directive" as const,
    ...(parsedAnchor !== null ? { anchor: parsedAnchor.id } : {}),
  });
}

function taskBodyFromCheckboxLine(line: string): string {
  const base = stripCarryForwardSource(line);
  const withoutAnchor = parseBlockAnchor(base)?.withoutAnchor ?? base;
  const withoutMarker = stripOriginMarker(withoutAnchor);
  return semanticActionBody(
    withoutMarker.replace(/^\s*[-*]\s+\[ \]\s+/, "").trim(),
  );
}

function taskBodyFromAnyCheckboxLine(line: string): string | null {
  const base = stripCarryForwardSource(line);
  const withoutAnchor = parseBlockAnchor(base)?.withoutAnchor ?? base;
  const withoutMarker = stripOriginMarker(withoutAnchor);
  const match = /^\s*[-*]\s+\[[ xX-]\]\s+(\S.*?)\s*$/.exec(withoutMarker);
  if (match === null) return null;
  const body = semanticActionBody((match[1] ?? "").trim());
  return body.length === 0 ? null : body;
}

function isExplicitFollowup(line: string): boolean {
  return /(^|\s)#follow-?up(\s|$)/i.test(line);
}

export function isSurfaceEligibleNonDailyAction(item: MarkdownActionItem): boolean {
  if (item.kind === "directive") return true;
  const line = item.text;
  return /(^|\s)#(?:task|follow-?up)(\s|$)/i.test(line) ||
    /(?:\u{1F53A}|\u{23EB}|\u{1F53C}|\u{23EC}|\u{1F4C5})/u.test(line) ||
    /\b\d{4}-\d{2}-\d{2}\b/.test(line);
}

function looksLikeAmbiguousFollowup(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith("#")) return false;
  const match = /\bfollow\s+up\s+with\s+(.+)$/i.exec(trimmed);
  if (match === null) return false;
  const target = (match[1] ?? "").trim().replace(/^[("'`]+/, "");
  if (target.length === 0) return false;
  return !/^(?:additional|extra|further|more)\b/i.test(target);
}

function stripCarryForwardSource(line: string): string {
  return line.replace(CARRY_FORWARD_RE, "").trimEnd();
}

function carryForwardSourcePath(line: string): string | null {
  return CARRY_FORWARD_RE.exec(line)?.[1] ?? null;
}

export function semanticActionBody(body: string): string {
  const stripped = body
    .replace(/^(?:#(?:task|follow-?up)\s+)+/i, "")
    .trim();
  return stripped.length > 0 ? stripped : body;
}

export function normalizeOpenLoopBody(body: string): string {
  return semanticActionBody(body).toLowerCase().replace(/\s+/g, " ").trim();
}

export function normalizeSourcePath(path: string): string {
  const trimmed = path.trim();
  const hash = trimmed.indexOf("#");
  const base = hash < 0 ? trimmed : trimmed.slice(0, hash);
  const fragment = hash < 0 ? "" : trimmed.slice(hash);
  const normalizedBase = base.endsWith(".md") ? base : `${base}.md`;
  return `${normalizedBase}${fragment}`;
}

export function sourceBackedCheckboxFromLine(
  line: string,
  lineNumber: number,
): SourceBackedCheckbox | null {
  const parsedAnchor = parseBlockAnchor(line);
  const base = parsedAnchor?.withoutAnchor ?? line;
  const match =
    /^\s*[-*]\s+\[([ xX-])\]\s+(.+?)\s+\(from \[\[([^\]\n]+?)(?:\.md)?\]\]\)\s*$/.exec(
      base,
    );
  if (match === null) return null;
  const state = match[1] ?? " ";
  const rawBody = match[2]?.trim();
  const sourcePath = match[3]?.trim();
  if (
    rawBody === undefined ||
    rawBody.length === 0 ||
    sourcePath === undefined ||
    sourcePath.length === 0
  ) {
    return null;
  }
  return Object.freeze({
    line: lineNumber,
    status: sourceBackedCheckboxStatus(state),
    body: semanticActionBody(stripOriginMarker(rawBody)),
    followup: isExplicitFollowup(rawBody),
    sourcePath: normalizeSourcePath(sourcePath),
    ...(parsedAnchor !== null ? { anchor: parsedAnchor.id } : {}),
  });
}

function sourceBackedCheckboxStatus(
  state: string,
): "open" | DailyOpenLoopSettlementStatus {
  if (state === "-") return "dismissed";
  return state.toLowerCase() === "x" ? "resolved" : "open";
}
