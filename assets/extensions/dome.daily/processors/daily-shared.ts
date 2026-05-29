const DAILY_DIR = "wiki/dailies";
const DAILY_PATH_RE = /^wiki\/dailies\/(\d{4})-(\d{2})-(\d{2})\.md$/;
const CARRY_FORWARD_RE =
  /\s+\(from \[\[(wiki\/dailies\/\d{4}-\d{2}-\d{2})\]\]\)\s*$/;

export const CARRIED_FORWARD_START =
  "<!-- dome.daily:carried-forward:start -->";
export const CARRIED_FORWARD_END =
  "<!-- dome.daily:carried-forward:end -->";

export type DailyDate = {
  readonly yyyy: string;
  readonly mm: string;
  readonly dd: string;
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

export function dailyPath(date: DailyDate): string {
  return `${DAILY_DIR}/${formatDate(date)}.md`;
}

export function dailyLink(date: DailyDate): string {
  return `${DAILY_DIR}/${formatDate(date)}`;
}

export function parseDailyPath(path: string): DailyDate | null {
  const match = DAILY_PATH_RE.exec(path);
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
  for (let i = 0; i < lines.length; i += 1) {
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
  for (let i = 0; i < lines.length; i += 1) {
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
}): string {
  const today = formatDate(input.today);
  const lines: string[] = [
    "---",
    "type: daily",
    `created: ${today}`,
    `updated: ${today}`,
    `recurrence: "${today}"`,
  ];
  if (input.yesterday !== null) {
    lines.push(`prev: "[[${dailyLink(input.yesterday)}]]"`);
  }
  lines.push(
    "---",
    "",
    `# ${today}`,
    "",
    "## Notes",
    "",
    "## Today's meetings",
    "",
    "## What did I get done today?",
    "",
    "## Story of the day",
    "",
  );
  return lines.join("\n");
}

export function carriedForwardSection(input: {
  readonly yesterday: DailyDate;
  readonly tasks: ReadonlyArray<OpenTask>;
}): string {
  return [
    CARRIED_FORWARD_START,
    "### Carried Forward",
    ...input.tasks.map((task) => {
      const sourcePath = task.sourcePath ?? dailyLink(input.yesterday);
      return `${task.text} (from [[${sourcePath}]])`;
    }),
    CARRIED_FORWARD_END,
  ].join("\n");
}

export function replaceCarriedForwardSection(input: {
  readonly content: string;
  readonly section: string;
}): string {
  const existing = carriedForwardBlockRange(input.content);
  if (existing !== null) {
    return `${input.content.slice(0, existing.start)}${input.section}${input.content.slice(existing.end)}`;
  }

  const notes = /^## Notes\s*$/m.exec(input.content);
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
    body,
    followup:
      marker === "follow-up" ||
      marker === "followup" ||
      isExplicitFollowup(body),
  });
}

function taskBodyFromCheckboxLine(line: string): string {
  return stripCarryForwardSource(line)
    .replace(/^\s*[-*]\s+\[ \]\s+/, "")
    .trim();
}

function isExplicitFollowup(line: string): boolean {
  return /(^|\s)#follow-?up(\s|$)/i.test(line);
}

function looksLikeAmbiguousFollowup(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith("#")) return false;
  return /\bfollow\s+up\s+with\b/i.test(trimmed);
}

function stripCarryForwardSource(line: string): string {
  return line.replace(CARRY_FORWARD_RE, "").trimEnd();
}

function carryForwardSourcePath(line: string): string | null {
  return CARRY_FORWARD_RE.exec(line)?.[1] ?? null;
}

function isValidDailyDate(date: DailyDate): boolean {
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
