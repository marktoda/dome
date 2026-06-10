import { createHash } from "node:crypto";

import {
  appendBlockAnchor,
  hasBlockAnchor,
  parseBlockAnchor,
} from "../../../../src/core/block-anchor";
import {
  findGeneratedBlock,
  generatedBlockMarkers,
} from "../../../../src/core/generated-block";

import { compareStrings } from "../../../../src/core/compare";

const CARRY_FORWARD_RE =
  /\s+\(from \[\[([^\]\n]*\d{4}-\d{2}-\d{2})(?:\.md)?\]\]\)\s*$/;
const DEFAULT_DAILY_PATH_TEMPLATE = "wiki/dailies/{date}.md";

// dome.daily's generated blocks, rendered from the core grammar primitive —
// the only sanctioned marker implementation (see
// [[wiki/linters/generated-block-splice-guard]]).
const DAILY_OWNER = "dome.daily";
const CARRIED_FORWARD_BLOCK = "carried-forward";
const START_CONTEXT_BLOCK = "start-context";
const OPEN_LOOPS_BLOCK = "open-loops";

const CARRIED_FORWARD_MARKERS = generatedBlockMarkers(
  DAILY_OWNER,
  CARRIED_FORWARD_BLOCK,
);
const START_CONTEXT_MARKERS = generatedBlockMarkers(
  DAILY_OWNER,
  START_CONTEXT_BLOCK,
);
const OPEN_LOOPS_MARKERS = generatedBlockMarkers(DAILY_OWNER, OPEN_LOOPS_BLOCK);

export const CARRIED_FORWARD_START = CARRIED_FORWARD_MARKERS.start;
export const CARRIED_FORWARD_END = CARRIED_FORWARD_MARKERS.end;
export const START_CONTEXT_START = START_CONTEXT_MARKERS.start;
export const START_CONTEXT_END = START_CONTEXT_MARKERS.end;
export const OPEN_LOOPS_START = OPEN_LOOPS_MARKERS.start;
export const OPEN_LOOPS_END = OPEN_LOOPS_MARKERS.end;

/**
 * The dome.daily generated blocks as `(owner, block)` anomaly-scan targets —
 * what splice call sites feed `generatedBlockAnomalyDiagnostics` so smuggled
 * duplicate pairs / half-open markers in a daily note surface as info
 * diagnostics instead of staying invisible.
 */
export const DAILY_GENERATED_BLOCKS: ReadonlyArray<{
  readonly owner: string;
  readonly block: string;
}> = Object.freeze([
  Object.freeze({ owner: DAILY_OWNER, block: START_CONTEXT_BLOCK }),
  Object.freeze({ owner: DAILY_OWNER, block: OPEN_LOOPS_BLOCK }),
  Object.freeze({ owner: DAILY_OWNER, block: CARRIED_FORWARD_BLOCK }),
]);

export type DailyDate = {
  readonly yyyy: string;
  readonly mm: string;
  readonly dd: string;
};

export type DailyPathSettings = {
  readonly template: string;
};

export type OpenTask = {
  readonly line: number;
  readonly text: string;
  readonly sourcePath: string | null;
  readonly body: string;
  readonly followup: boolean;
  /** The stamped `^block-anchor` id, if the line carries one. */
  readonly anchor?: string;
};

export type MarkdownActionItem = {
  readonly line: number;
  readonly text: string;
  readonly body: string;
  readonly followup: boolean;
  readonly origin: "checkbox" | "directive";
  /** The stamped `^block-anchor` id, if the line carries one. */
  readonly anchor?: string;
};

export type AmbiguousFollowup = {
  readonly line: number;
  readonly text: string;
};

export type DailyOpenLoopSource = {
  readonly line: number;
  readonly stableId: string;
  readonly body: string;
  readonly followup: boolean;
  readonly sourcePath: string;
  /** The origin line's stamped `^block-anchor` id, when it carries one. */
  readonly anchor?: string;
};

export type DailyOpenLoopCandidate = DailyOpenLoopSource & {
  readonly lastChangedAt: string;
};

export type DailySettledOpenLoopSource = {
  readonly line: number;
  readonly stableId: string;
  readonly path: string;
  readonly body: string;
  readonly followup: boolean;
  readonly sourcePath: string;
  readonly status: DailyOpenLoopSettlementStatus;
};

export type DailyStartContext = {
  readonly previousPath: string;
  readonly done: ReadonlyArray<string>;
  readonly decisions: ReadonlyArray<string>;
  readonly story: string | null;
};

export type DailyOpenLoopSettlementStatus = "resolved" | "dismissed";

const DEFAULT_DAILY_PATH_SETTINGS: DailyPathSettings = Object.freeze({
  template: DEFAULT_DAILY_PATH_TEMPLATE,
});

function validateDailyPathTemplate(template: string): string {
  const parts = template.split("{date}");
  if (parts.length !== 2) {
    throw new Error(
      "dome.daily config daily_path must contain exactly one {date} placeholder",
    );
  }
  if (template.trim() !== template || template.length === 0) {
    throw new Error("dome.daily config daily_path must be a non-empty path");
  }
  const sample = template.replace("{date}", "2026-01-02");
  if (!sample.endsWith(".md")) {
    throw new Error("dome.daily config daily_path must produce a .md file");
  }
  if (
    sample.startsWith("/") ||
    sample.includes("\\") ||
    sample.split("/").some((segment) =>
      segment.length === 0 || segment === "." || segment === ".."
    )
  ) {
    throw new Error(
      "dome.daily config daily_path must be a relative vault markdown path",
    );
  }
  return template;
}

function dailyPathRegex(settings: DailyPathSettings): RegExp {
  const [before, after] = settings.template.split("{date}");
  return new RegExp(
    `^${escapeRegExp(before ?? "")}(\\d{4})-(\\d{2})-(\\d{2})${escapeRegExp(after ?? "")}$`,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * THE vault-date policy: a clock reading becomes a vault-facing calendar
 * date via the HOST-LOCAL timezone. Daily notes, sweep/consolidation ledger
 * dates, and "today" in agent prompts all mean the owner's calendar day —
 * an evening capture west of UTC belongs to today's daily, not tomorrow's.
 * Every clock→date conversion in bundle code must go through this helper
 * (fed by ctx.now(), per the processor-clock fence). UTC date handling is
 * reserved for TZ-less date *literals* (frontmatter `YYYY-MM-DD` values,
 * date-string arithmetic), which never touch the clock.
 */
export function localDateParts(date: Date): DailyDate {
  return Object.freeze({
    yyyy: String(date.getFullYear()).padStart(4, "0"),
    mm: String(date.getMonth() + 1).padStart(2, "0"),
    dd: String(date.getDate()).padStart(2, "0"),
  });
}

export function previousLocalDate(date: DailyDate): DailyDate {
  const previous = new Date(
    Number(date.yyyy),
    Number(date.mm) - 1,
    Number(date.dd) - 1,
  );
  return localDateParts(previous);
}

export function dailyPathSettings(
  config?: Readonly<Record<string, unknown>>,
): DailyPathSettings {
  const raw = config?.daily_path;
  if (raw === undefined) return DEFAULT_DAILY_PATH_SETTINGS;
  if (typeof raw !== "string") {
    throw new Error("dome.daily config daily_path must be a string");
  }
  return Object.freeze({
    template: validateDailyPathTemplate(raw),
  });
}

export function dailyPath(
  date: DailyDate,
  settings: DailyPathSettings = DEFAULT_DAILY_PATH_SETTINGS,
): string {
  return settings.template.replace("{date}", formatDate(date));
}

export function dailyLink(
  date: DailyDate,
  settings: DailyPathSettings = DEFAULT_DAILY_PATH_SETTINGS,
): string {
  return dailyPath(date, settings).replace(/\.md$/, "");
}

export function parseDailyPath(
  path: string,
  settings: DailyPathSettings = DEFAULT_DAILY_PATH_SETTINGS,
): DailyDate | null {
  const match = dailyPathRegex(settings).exec(path);
  if (match === null) return null;
  const [, yyyy, mm, dd] = match;
  if (yyyy === undefined || mm === undefined || dd === undefined) return null;
  const parsed = Object.freeze({ yyyy, mm, dd });
  if (!isValidDailyDate(parsed)) return null;
  return parsed;
}

export function formatDate(date: DailyDate): string {
  return `${date.yyyy}-${date.mm}-${date.dd}`;
}

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
          origin: "checkbox" as const,
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
/**
 * True when the file is an Obsidian Tasks plugin query dashboard — it contains
 * a fenced ` ```tasks ` (or `~~~tasks`) query block. Such files are managed by
 * the plugin (which parses task lines and would choke on a `^anchor` suffix),
 * so the task-lifecycle rewriters (stamp / normalize / reconcile) leave the
 * whole file alone. Read-only extraction (`actionItemsFromMarkdown`,
 * task-index) is unaffected — the tasks still project into facts.
 */
export function isObsidianTasksDashboard(content: string): boolean {
  return /^[ ]{0,3}(?:```|~~~)\s*tasks(?:\s|$)/m.test(content);
}

export function stampTaskAnchors(input: {
  readonly path: string;
  readonly content: string;
}): string | null {
  if (isObsidianTasksDashboard(input.content)) return null;
  const lines = input.content.split(/\r?\n/);
  const occurrences = new Map<string, number>();
  let changed = false;
  for (const item of actionItemsFromMarkdown(input.content)) {
    const idx = item.line - 1;
    const line = lines[idx];
    if (line === undefined || hasBlockAnchor(line)) continue;
    const bodyKey = normalizeOpenLoopBody(item.body);
    const occurrence = occurrences.get(bodyKey) ?? 0;
    occurrences.set(bodyKey, occurrence + 1);
    lines[idx] = appendBlockAnchor(
      line,
      taskAnchorId({ path: input.path, body: item.body, occurrence }),
    );
    changed = true;
  }
  return changed ? lines.join("\n") : null;
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
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        normalizeSourcePath(input.path),
        normalizeOpenLoopBody(input.body),
        input.occurrence,
      ]),
    )
    .digest("hex")
    .slice(0, 8);
  return `t${hash}`;
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

export function renderDailySkeleton(input: {
  readonly today: DailyDate;
  readonly yesterday: DailyDate | null;
  readonly settings?: DailyPathSettings;
}): string {
  const today = formatDate(input.today);
  const settings = input.settings ?? DEFAULT_DAILY_PATH_SETTINGS;
  const lines: string[] = [
    "---",
    "type: daily",
    `created: ${today}`,
    `updated: ${today}`,
    `recurrence: "${today}"`,
  ];
  if (input.yesterday !== null) {
    lines.push(`prev: "[[${dailyLink(input.yesterday, settings)}]]"`);
  }
  lines.push(
    "---",
    "",
    `# ${today}`,
    "",
    "## Start Here",
    "",
    "## Meetings",
    "",
    "## Open Loops",
    "",
    "## Notes",
    "",
    "## Decisions",
    "",
    "## Done",
    "",
    "## Story of the Day",
    "",
  );
  return lines.join("\n");
}

export function carriedForwardSection(input: {
  readonly yesterday: DailyDate;
  readonly tasks: ReadonlyArray<OpenTask>;
  readonly settings?: DailyPathSettings;
}): string {
  const settings = input.settings ?? DEFAULT_DAILY_PATH_SETTINGS;
  return [
    CARRIED_FORWARD_START,
    "### Carried Forward",
    ...input.tasks.map((task) => {
      const sourcePath =
        task.sourcePath ?? dailyLink(input.yesterday, settings);
      return `${task.text} (from [[${sourcePath}]])`;
    }),
    CARRIED_FORWARD_END,
  ].join("\n");
}

export function previousDailyStartContext(input: {
  readonly previousPath: string;
  readonly previousContent: string;
}): DailyStartContext {
  return Object.freeze({
    previousPath: input.previousPath,
    done: extractSectionItems(input.previousContent, "Done"),
    decisions: extractSectionItems(input.previousContent, "Decisions"),
    story: extractStorySummary(input.previousContent),
  });
}

export function dailyStartContextSection(
  context: DailyStartContext | null,
): string | null {
  if (context === null) return null;
  const lines = [
    START_CONTEXT_START,
    "### Since Yesterday",
    `- Previous daily: [[${context.previousPath.replace(/\.md$/, "")}]]`,
  ];
  if (context.done.length > 0) {
    lines.push(`- Done yesterday: ${renderCompactList(context.done)}`);
  }
  if (context.decisions.length > 0) {
    lines.push(`- Decisions yesterday: ${renderCompactList(context.decisions)}`);
  }
  if (context.story !== null) {
    lines.push(`- Story: ${context.story}`);
  }
  lines.push(START_CONTEXT_END);
  return lines.join("\n");
}

export function replaceDailyStartContextSection(input: {
  readonly content: string;
  readonly section: string | null;
}): string {
  const existing = startContextBlockRange(input.content);
  if (existing !== null) {
    const replacement = input.section === null ? "" : input.section;
    return `${input.content.slice(0, existing.start)}${replacement}${input.content.slice(existing.end)}`;
  }
  if (input.section === null) return input.content;
  return insertDailyStartContextSection({
    content: input.content,
    section: input.section,
  });
}

export function openLoopSurfaceSources(input: {
  readonly path: string;
  readonly content: string;
  readonly settings?: DailyPathSettings;
}): ReadonlyArray<DailyOpenLoopSource> {
  const generatedRanges = dailyGeneratedBlockLineRanges(input.content);
  const isDailySource =
    parseDailyPath(input.path, input.settings ?? DEFAULT_DAILY_PATH_SETTINGS) !==
    null;
  const items: DailyOpenLoopSource[] = [];
  for (const item of actionItemsFromMarkdown(input.content)) {
    if (lineIsInsideRanges(item.line, generatedRanges)) continue;
    if (!isDailySource && !isSurfaceEligibleNonDailyAction(item)) {
      continue;
    }
    items.push(
      Object.freeze({
        line: item.line,
        stableId: taskStableId({
          sourcePath: input.path,
          body: item.body,
          ...(item.anchor !== undefined ? { anchor: item.anchor } : {}),
        }),
        body: item.body,
        followup: item.followup,
        sourcePath: input.path,
        ...(item.anchor !== undefined ? { anchor: item.anchor } : {}),
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
        stableId: openLoopStableId({
          sourcePath: item.sourcePath,
          body: item.body,
        }),
        path: input.path,
        body: item.body,
        followup: item.followup,
        sourcePath: item.sourcePath,
        status: item.status,
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
        stableId: openLoopStableId({
          sourcePath: item.sourcePath,
          body: item.body,
        }),
        body: item.body,
        followup: item.followup,
        sourcePath: item.sourcePath,
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
 * Across all `files`, every settled `- [x]/[-] body (from [[origin]])` copy
 * yields a target `{ sourcePath, body, status }`. For each target, the file at
 * `sourcePath` (matched within the same `files` list, path-normalized with
 * `.md`) is scanned for the OPEN action-item line whose normalized body matches.
 * Matching is by normalized body, not by anchor — the generated copy carries no
 * `^anchor`. When exactly one open line matches, only its checkbox marker is
 * rewritten (`[ ]` → `[x]` for resolved, `[ ]` → `[-]` for dismissed); when the
 * origin has two open lines sharing that body the match is ambiguous and is
 * skipped (never guess which to close). The rest of the line — trailing
 * `^anchor`, tags, source suffix — is preserved verbatim, and no line is ever
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
    const wantBody = reconcileBodyKey(target.body);
    const matches = actionItemsFromMarkdown(current).filter(
      (item) =>
        item.origin === "checkbox" &&
        !consumed.has(item.line) &&
        reconcileBodyKey(item.body) === wantBody,
    );
    // The generated daily copy carries no `^anchor`, so a body match is the
    // only signal. When two open lines in the origin share a body we cannot
    // tell which one the user settled — skip rather than close the wrong line.
    // (carry-forward dedups surfaced copies by body, so the unambiguous 1:1
    // case is the norm; genuine duplicates are left for explicit settling.)
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
}): string {
  return openLoopStableId(input);
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

export function replaceCarriedForwardSection(input: {
  readonly content: string;
  readonly section: string;
}): string {
  const existing = carriedForwardBlockRange(input.content);
  if (existing !== null) {
    return `${input.content.slice(0, existing.start)}${input.section}${input.content.slice(existing.end)}`;
  }

  const notes = /^## Notes[ \t]*$/m.exec(input.content);
  if (notes !== null && notes.index !== undefined) {
    const insertAt = notes.index + notes[0].length;
    return `${input.content.slice(0, insertAt)}\n\n${input.section}${input.content.slice(insertAt)}`;
  }

  const suffix = input.content.endsWith("\n") ? "" : "\n";
  return `${input.content}${suffix}\n## Notes\n\n${input.section}\n`;
}

function isOpenCheckboxLine(line: string): boolean {
  return /^\s*[-*]\s+\[ \]\s+\S/.test(line);
}

function isCheckboxLine(line: string): boolean {
  return /^\s*[-*]\s+\[[ xX]\]\s+\S/.test(line);
}

function openTaskFromLine(line: string, lineNumber: number): OpenTask {
  const anchor = parseBlockAnchor(stripCarryForwardSource(line))?.id;
  return Object.freeze({
    line: lineNumber,
    text: stripCarryForwardSource(line),
    sourcePath: carryForwardSourcePath(line),
    body: taskBodyFromCheckboxLine(line),
    followup: isExplicitFollowup(line),
    ...(anchor !== undefined ? { anchor } : {}),
  });
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
    origin: "directive",
    ...(parsedAnchor !== null ? { anchor: parsedAnchor.id } : {}),
  });
}

function taskBodyFromCheckboxLine(line: string): string {
  const base = stripCarryForwardSource(line);
  const withoutAnchor = parseBlockAnchor(base)?.withoutAnchor ?? base;
  return semanticActionBody(
    withoutAnchor.replace(/^\s*[-*]\s+\[ \]\s+/, "").trim(),
  );
}

function isExplicitFollowup(line: string): boolean {
  return /(^|\s)#follow-?up(\s|$)/i.test(line);
}

function isSurfaceEligibleNonDailyAction(item: MarkdownActionItem): boolean {
  if (item.origin === "directive") return true;
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

function renderOpenLoopSource(item: DailyOpenLoopSource): string {
  const followup = item.followup ? "#followup " : "";
  return `- [ ] ${followup}${item.body} (from [[${item.sourcePath.replace(/\.md$/, "")}]])`;
}

function renderSettledOpenLoopSource(
  item: DailySettledOpenLoopSource,
): string {
  const followup = item.followup ? "#followup " : "";
  const state = item.status === "dismissed" ? "-" : "x";
  return `- [${state}] ${followup}${item.body} (from [[${item.sourcePath.replace(/\.md$/, "")}]])`;
}

type SourceBackedCheckbox = {
  readonly line: number;
  readonly status: "open" | DailyOpenLoopSettlementStatus;
  readonly body: string;
  readonly followup: boolean;
  readonly sourcePath: string;
};

function sourceBackedCheckboxFromLine(
  line: string,
  lineNumber: number,
): SourceBackedCheckbox | null {
  const match =
    /^\s*[-*]\s+\[([ xX-])\]\s+(.+?)\s+\(from \[\[([^\]\n]+?)(?:\.md)?\]\]\)\s*$/.exec(
      line,
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
    body: semanticActionBody(rawBody),
    followup: isExplicitFollowup(rawBody),
    sourcePath: normalizeSourcePath(sourcePath),
  });
}

function sourceBackedCheckboxStatus(
  state: string,
): "open" | DailyOpenLoopSettlementStatus {
  if (state === "-") return "dismissed";
  return state.toLowerCase() === "x" ? "resolved" : "open";
}

function semanticActionBody(body: string): string {
  const stripped = body
    .replace(/^(?:#(?:task|follow-?up)\s+)+/i, "")
    .trim();
  return stripped.length > 0 ? stripped : body;
}

function normalizeOpenLoopBody(body: string): string {
  return semanticActionBody(body).toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeSourcePath(path: string): string {
  const trimmed = path.trim();
  const hash = trimmed.indexOf("#");
  const base = hash < 0 ? trimmed : trimmed.slice(0, hash);
  const fragment = hash < 0 ? "" : trimmed.slice(hash);
  const normalizedBase = base.endsWith(".md") ? base : `${base}.md`;
  return `${normalizedBase}${fragment}`;
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

function stripCandidateMetadata(
  item: DailyOpenLoopCandidate,
): DailyOpenLoopSource {
  return Object.freeze({
    line: item.line,
    stableId: item.stableId,
    body: item.body,
    followup: item.followup,
    sourcePath: item.sourcePath,
  });
}

export function isValidDailyDate(date: DailyDate): boolean {
  const normalized = localDateParts(
    new Date(Number(date.yyyy), Number(date.mm) - 1, Number(date.dd)),
  );
  return (
    normalized.yyyy === date.yyyy &&
    normalized.mm === date.mm &&
    normalized.dd === date.dd
  );
}

/**
 * Bound a dome.daily generated block via the core grammar primitive's
 * line-anchored scan (a marker counts only when the entire trimmed line is
 * the marker — prose/fence mentions and mid-line smuggles never bound a
 * block; the historical indexOf bounding here was the weaker form of the
 * marker-injection bug fixed in the brief and preferences splices).
 */
function dailyBlockRange(
  content: string,
  block: string,
): { readonly start: number; readonly end: number } | null {
  const { range } = findGeneratedBlock(content, DAILY_OWNER, block);
  if (range === null) return null;
  return Object.freeze({ start: range.start, end: range.end });
}

function carriedForwardBlockRange(
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

function dailyGeneratedBlockRange(
  content: string,
): { readonly start: number; readonly end: number } | null {
  return openLoopsBlockRange(content) ?? carriedForwardBlockRange(content);
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

function endOfHeadingSection(content: string, heading: RegExpExecArray): number {
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

function dailyGeneratedBlockLineRanges(
  content: string,
): ReadonlyArray<{ readonly start: number; readonly end: number }> {
  const ranges: { start: number; end: number }[] = [];
  for (
    const block of [
      START_CONTEXT_BLOCK,
      OPEN_LOOPS_BLOCK,
      CARRIED_FORWARD_BLOCK,
    ] as const
  ) {
    const { range } = findGeneratedBlock(content, DAILY_OWNER, block);
    if (range === null) continue;
    ranges.push({ start: range.startLine, end: range.endLine });
  }
  return Object.freeze(ranges.map((range) => Object.freeze(range)));
}

function actionExtractionLineRanges(
  content: string,
): ReadonlyArray<{ readonly start: number; readonly end: number }> {
  const frontmatter = frontmatterLineRange(content);
  return Object.freeze([
    ...dailyGeneratedBlockLineRanges(content),
    ...fencedCodeBlockLineRanges(content),
    ...(frontmatter === null ? [] : [frontmatter]),
  ]);
}

/**
 * Line ranges (1-indexed, inclusive of the fence lines) covered by fenced
 * code blocks (``` or ~~~). Checkbox/directive syntax inside a fence is
 * documentation, not an action item — excluding these ranges keeps task
 * extraction, stamping, and syntax normalization from mutating example code.
 * A fence opens on a line whose first non-space run is ``` (3+) or ~~~ (3+)
 * and closes on the next line opening with the same fence character; an
 * unterminated fence extends to end of file.
 */
function fencedCodeBlockLineRanges(
  content: string,
): ReadonlyArray<{ readonly start: number; readonly end: number }> {
  const lines = content.split(/\r?\n/);
  const ranges: { start: number; end: number }[] = [];
  let openLine = -1;
  let fenceChar = "";
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(`{3,}|~{3,})/.exec((lines[i] ?? "").trimStart());
    if (match === null) continue;
    const char = (match[1] ?? "").charAt(0);
    if (openLine < 0) {
      openLine = i + 1;
      fenceChar = char;
    } else if (char === fenceChar) {
      ranges.push({ start: openLine, end: i + 1 });
      openLine = -1;
      fenceChar = "";
    }
  }
  if (openLine > 0) ranges.push({ start: openLine, end: lines.length });
  return Object.freeze(ranges.map((range) => Object.freeze(range)));
}

function frontmatterLineRange(
  content: string,
): { readonly start: number; readonly end: number } | null {
  const lines = content.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") return null;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? "").trim() === "---") {
      return Object.freeze({ start: 1, end: i + 1 });
    }
  }
  return null;
}

function lineIsInsideRanges(
  line: number,
  ranges: ReadonlyArray<{ readonly start: number; readonly end: number }>,
): boolean {
  return ranges.some((range) => line >= range.start && line <= range.end);
}

function lineNumberAtOffset(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function insertDailyStartContextSection(input: {
  readonly content: string;
  readonly section: string;
}): string {
  const startHere = /^## Start Here[ \t]*$/m.exec(input.content);
  if (startHere !== null && startHere.index !== undefined) {
    const insertAt = startHere.index + startHere[0].length;
    const rest = input.content.slice(insertAt).replace(/^(?:\r?\n)*/, "\n\n");
    return `${input.content.slice(0, insertAt)}\n\n${input.section}${rest}`;
  }

  const meetings = /^## Meetings[ \t]*$/m.exec(input.content);
  if (meetings !== null && meetings.index !== undefined) {
    return (
      `${input.content.slice(0, meetings.index)}` +
      `## Start Here\n\n${input.section}\n\n` +
      input.content.slice(meetings.index)
    );
  }

  const openLoops = /^## Open Loops[ \t]*$/m.exec(input.content);
  if (openLoops !== null && openLoops.index !== undefined) {
    return (
      `${input.content.slice(0, openLoops.index)}` +
      `## Start Here\n\n${input.section}\n\n` +
      input.content.slice(openLoops.index)
    );
  }

  const suffix = input.content.endsWith("\n") ? "" : "\n";
  return `${input.content}${suffix}\n## Start Here\n\n${input.section}\n`;
}

function startContextBlockRange(
  content: string,
): { readonly start: number; readonly end: number } | null {
  return dailyBlockRange(content, START_CONTEXT_BLOCK);
}

function extractSectionItems(
  content: string,
  heading: string,
): ReadonlyArray<string> {
  const body = headingSectionBody(content, heading);
  if (body === null) return Object.freeze([]);
  const items: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const item = cleanContextLine(line);
    if (item === null) continue;
    items.push(item);
  }
  return Object.freeze(items);
}

function extractStorySummary(content: string): string | null {
  const body = headingSectionBody(content, "Story of the Day");
  if (body === null) return null;
  const paragraphs = body
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) =>
      paragraph
        .split(/\r?\n/)
        .map(cleanContextLine)
        .filter((line): line is string => line !== null)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((paragraph) => paragraph.length > 0);
  const first = paragraphs[0];
  return first === undefined ? null : truncateContextText(first, 220);
}

function headingSectionBody(
  content: string,
  heading: string,
): string | null {
  const match = new RegExp(`^## ${escapeRegExp(heading)}[ \\t]*$`, "m")
    .exec(content);
  if (match === null || match.index === undefined) return null;
  const bodyStart = match.index + (match[0]?.length ?? 0);
  return content.slice(bodyStart, endOfHeadingSection(content, match));
}

function cleanContextLine(line: string): string | null {
  const stripped = line
    .trim()
    .replace(/^\s*[-*]\s+\[[ xX]\]\s+/, "")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/^\s*\d+\.\s+/, "")
    .trim();
  if (stripped.length === 0) return null;
  if (stripped.startsWith("<!--")) return null;
  if (/^#{1,6}\s+/.test(stripped)) return null;
  return truncateContextText(stripped, 160);
}

function renderCompactList(items: ReadonlyArray<string>): string {
  const shown = items.slice(0, 3);
  const suffix = items.length > shown.length
    ? ` (+${items.length - shown.length} more)`
    : "";
  return `${shown.join("; ")}${suffix}`;
}

function truncateContextText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
