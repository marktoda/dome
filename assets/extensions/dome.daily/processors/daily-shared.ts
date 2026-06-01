const CARRY_FORWARD_RE =
  /\s+\(from \[\[([^\]\n]*\d{4}-\d{2}-\d{2})(?:\.md)?\]\]\)\s*$/;
const DEFAULT_DAILY_PATH_TEMPLATE = "wiki/dailies/{date}.md";

export const CARRIED_FORWARD_START =
  "<!-- dome.daily:carried-forward:start -->";
export const CARRIED_FORWARD_END =
  "<!-- dome.daily:carried-forward:end -->";
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
};

export type AmbiguousFollowup = {
  readonly line: number;
  readonly text: string;
};

export type DailyOpenLoopSource = {
  readonly line: number;
  readonly body: string;
  readonly followup: boolean;
  readonly sourcePath: string;
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

export function openLoopSurfaceSources(input: {
  readonly path: string;
  readonly content: string;
}): ReadonlyArray<DailyOpenLoopSource> {
  const generatedRanges = dailyGeneratedBlockLineRanges(input.content);
  const items: DailyOpenLoopSource[] = [];
  for (const item of actionItemsFromMarkdown(input.content)) {
    if (lineIsInsideRanges(item.line, generatedRanges)) continue;
    items.push(
      Object.freeze({
        line: item.line,
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
}): string | null {
  if (input.items.length === 0) return null;
  const lines = [
    OPEN_LOOPS_START,
    "### Source-backed Open Loops",
    ...input.items.map(renderOpenLoopSource),
    OPEN_LOOPS_END,
  ];
  return lines.join("\n");
}

export function replaceOpenLoopSurfaceSection(input: {
  readonly content: string;
  readonly section: string | null;
}): string {
  const existing = dailyGeneratedBlockRange(input.content);
  if (existing !== null) {
    const replacement = input.section === null ? "" : input.section;
    return `${input.content.slice(0, existing.start)}${replacement}${input.content.slice(existing.end)}`;
  }
  if (input.section === null) return input.content;

  const openLoops = /^## Open Loops[ \t]*$/m.exec(input.content);
  if (openLoops !== null && openLoops.index !== undefined) {
    const insertAt = openLoops.index + openLoops[0].length;
    const rest = input.content.slice(insertAt).replace(/^(?:\r?\n)*/, "\n\n");
    return `${input.content.slice(0, insertAt)}\n\n${input.section}${rest}`;
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

function semanticActionBody(body: string): string {
  const stripped = body
    .replace(/^(?:#(?:task|follow-?up)\s+)+/i, "")
    .trim();
  return stripped.length > 0 ? stripped : body;
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

function dailyGeneratedBlockLineRanges(
  content: string,
): ReadonlyArray<{ readonly start: number; readonly end: number }> {
  const ranges: { start: number; end: number }[] = [];
  for (
    const marker of [
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
