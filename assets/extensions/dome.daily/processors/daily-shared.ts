import { createHash } from "node:crypto";

const CARRY_FORWARD_RE =
  /\s+\(from \[\[([^\]\n]*\d{4}-\d{2}-\d{2})(?:\.md)?\]\]\)\s*$/;
const DEFAULT_DAILY_PATH_TEMPLATE = "wiki/dailies/{date}.md";

export const CARRIED_FORWARD_START =
  "<!-- dome.daily:carried-forward:start -->";
export const CARRIED_FORWARD_END =
  "<!-- dome.daily:carried-forward:end -->";
export const START_CONTEXT_START =
  "<!-- dome.daily:start-context:start -->";
export const START_CONTEXT_END =
  "<!-- dome.daily:start-context:end -->";
export const OPEN_LOOPS_START = "<!-- dome.daily:open-loops:start -->";
export const OPEN_LOOPS_END = "<!-- dome.daily:open-loops:end -->";

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
};

export type MarkdownActionItem = {
  readonly line: number;
  readonly text: string;
  readonly body: string;
  readonly followup: boolean;
  readonly origin: "checkbox" | "directive";
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
};

export type DailyOpenLoopCandidate = DailyOpenLoopSource & {
  readonly lastChangedAt: string;
};

export type DailyResolvedOpenLoopSource = {
  readonly line: number;
  readonly stableId: string;
  readonly path: string;
  readonly body: string;
  readonly followup: boolean;
  readonly sourcePath: string;
};

export type DailyStartContext = {
  readonly previousPath: string;
  readonly done: ReadonlyArray<string>;
  readonly decisions: ReadonlyArray<string>;
  readonly story: string | null;
};

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
  const generatedRanges = dailyGeneratedBlockLineRanges(content);
  for (let i = 0; i < lines.length; i += 1) {
    if (lineIsInsideRanges(i + 1, generatedRanges)) continue;
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
        }),
      );
      continue;
    }

    const directive = directiveActionItemFromLine(line, i + 1);
    if (directive !== null) items.push(directive);
  }
  return Object.freeze(items);
}

export function ambiguousFollowupsFromMarkdown(
  content: string,
): ReadonlyArray<AmbiguousFollowup> {
  const items: AmbiguousFollowup[] = [];
  const lines = content.split(/\r?\n/);
  const generatedRanges = dailyGeneratedBlockLineRanges(content);
  for (let i = 0; i < lines.length; i += 1) {
    if (lineIsInsideRanges(i + 1, generatedRanges)) continue;
    const line = lines[i] ?? "";
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
        stableId: openLoopStableId({
          sourcePath: input.path,
          body: item.body,
        }),
        body: item.body,
        followup: item.followup,
        sourcePath: input.path,
      }),
    );
  }
  return Object.freeze(items);
}

export function openLoopSurfaceSection(input: {
  readonly items: ReadonlyArray<DailyOpenLoopSource>;
  readonly resolvedItems?: ReadonlyArray<DailyResolvedOpenLoopSource>;
}): string | null {
  const resolvedItems = input.resolvedItems ?? [];
  if (input.items.length === 0 && resolvedItems.length === 0) return null;
  const lines = [OPEN_LOOPS_START];
  if (input.items.length > 0) {
    lines.push(
      "### Source-backed Open Loops",
      ...input.items.map(renderOpenLoopSource),
    );
  }
  if (resolvedItems.length > 0) {
    if (input.items.length > 0) lines.push("");
    lines.push(
      "### Resolved Today",
      ...resolvedItems.map(renderResolvedOpenLoopSource),
    );
  }
  lines.push(OPEN_LOOPS_END);
  return lines.join("\n");
}

export function completedSourceBackedOpenLoopsFromMarkdown(input: {
  readonly path: string;
  readonly content: string;
}): ReadonlyArray<DailyResolvedOpenLoopSource> {
  const items: DailyResolvedOpenLoopSource[] = [];
  const lines = input.content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const item = sourceBackedCheckboxFromLine(lines[i] ?? "", i + 1);
    if (item === null || !item.completed) continue;
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
      }),
    );
  }
  return Object.freeze(items);
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
  return Object.freeze({
    line: lineNumber,
    text: stripCarryForwardSource(line),
    sourcePath: carryForwardSourcePath(line),
    body: taskBodyFromCheckboxLine(line),
    followup: isExplicitFollowup(line),
  });
}

function directiveActionItemFromLine(
  line: string,
  lineNumber: number,
): MarkdownActionItem | null {
  const match = /^\s*(?:[-*]\s+)?(todo|follow[- ]?up)\s*:\s*(\S.*)$/i.exec(
    line,
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
  });
}

function taskBodyFromCheckboxLine(line: string): string {
  return semanticActionBody(
    stripCarryForwardSource(line)
      .replace(/^\s*[-*]\s+\[ \]\s+/, "")
      .trim(),
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

function renderResolvedOpenLoopSource(
  item: DailyResolvedOpenLoopSource,
): string {
  const followup = item.followup ? "#followup " : "";
  return `- [x] ${followup}${item.body} (from [[${item.sourcePath.replace(/\.md$/, "")}]])`;
}

type SourceBackedCheckbox = {
  readonly line: number;
  readonly completed: boolean;
  readonly body: string;
  readonly followup: boolean;
  readonly sourcePath: string;
};

function sourceBackedCheckboxFromLine(
  line: string,
  lineNumber: number,
): SourceBackedCheckbox | null {
  const match =
    /^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s+\(from \[\[([^\]\n]+?)(?:\.md)?\]\]\)\s*$/.exec(
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
    completed: state.toLowerCase() === "x",
    body: semanticActionBody(rawBody),
    followup: isExplicitFollowup(rawBody),
    sourcePath: normalizeSourcePath(sourcePath),
  });
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
  const changedCmp = b.lastChangedAt.localeCompare(a.lastChangedAt);
  if (changedCmp !== 0) return changedCmp;
  const pathCmp = a.sourcePath.localeCompare(b.sourcePath);
  if (pathCmp !== 0) return pathCmp;
  const lineCmp = a.line - b.line;
  if (lineCmp !== 0) return lineCmp;
  return a.body.localeCompare(b.body);
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

function carriedForwardBlockRange(
  content: string,
): { readonly start: number; readonly end: number } | null {
  const start = content.indexOf(CARRIED_FORWARD_START);
  if (start < 0) return null;
  const endMarker = content.indexOf(CARRIED_FORWARD_END, start);
  if (endMarker < 0) return null;
  return Object.freeze({
    start,
    end: endMarker + CARRIED_FORWARD_END.length,
  });
}

function openLoopsBlockRange(
  content: string,
): { readonly start: number; readonly end: number } | null {
  const start = content.indexOf(OPEN_LOOPS_START);
  if (start < 0) return null;
  const endMarker = content.indexOf(OPEN_LOOPS_END, start);
  if (endMarker < 0) return null;
  return Object.freeze({
    start,
    end: endMarker + OPEN_LOOPS_END.length,
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
    const marker of [
      [START_CONTEXT_START, START_CONTEXT_END],
      [OPEN_LOOPS_START, OPEN_LOOPS_END],
      [CARRIED_FORWARD_START, CARRIED_FORWARD_END],
    ] as const
  ) {
    const start = content.indexOf(marker[0]);
    if (start < 0) continue;
    const endMarker = content.indexOf(marker[1], start);
    if (endMarker < 0) continue;
    ranges.push({
      start: lineNumberAtOffset(content, start),
      end: lineNumberAtOffset(content, endMarker + marker[1].length),
    });
  }
  return Object.freeze(ranges.map((range) => Object.freeze(range)));
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
  const start = content.indexOf(START_CONTEXT_START);
  if (start < 0) return null;
  const endMarker = content.indexOf(START_CONTEXT_END, start);
  if (endMarker < 0) return null;
  return Object.freeze({
    start,
    end: endMarker + START_CONTEXT_END.length,
  });
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
