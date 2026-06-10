import {
  findGeneratedBlock,
  generatedBlockMarkers,
} from "../../../../src/core/generated-block";

export const AMBIGUOUS_FOLLOWUP_QUESTION_PREFIX =
  "dome.daily.ambiguous-followup:";

export const AMBIGUOUS_FOLLOWUP_OPTIONS = Object.freeze(["track", "ignore"]);

const TRACKED_FOLLOWUPS_OWNER = "dome.daily";
const TRACKED_FOLLOWUPS_BLOCK = "tracked-followups";
const TRACKED_FOLLOWUPS_MARKERS = generatedBlockMarkers(
  TRACKED_FOLLOWUPS_OWNER,
  TRACKED_FOLLOWUPS_BLOCK,
);
export const TRACKED_FOLLOWUPS_START = TRACKED_FOLLOWUPS_MARKERS.start;
export const TRACKED_FOLLOWUPS_END = TRACKED_FOLLOWUPS_MARKERS.end;

export type AmbiguousFollowupAnswer = "track" | "ignore";

export type AmbiguousFollowupTarget = {
  readonly version: 1 | 2;
  readonly path: string;
  readonly line?: number;
  readonly text: string;
};

export function ambiguousFollowupQuestionKey(
  target: AmbiguousFollowupTarget,
): string {
  return `${AMBIGUOUS_FOLLOWUP_QUESTION_PREFIX}${encodeURIComponent(
    JSON.stringify(target),
  )}`;
}

export function targetFromAmbiguousFollowupQuestionKey(
  key: string,
): AmbiguousFollowupTarget | null {
  if (!key.startsWith(AMBIGUOUS_FOLLOWUP_QUESTION_PREFIX)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(
      decodeURIComponent(key.slice(AMBIGUOUS_FOLLOWUP_QUESTION_PREFIX.length)),
    );
  } catch {
    return null;
  }
  return parseTarget(raw);
}

export function parseAmbiguousFollowupAnswer(
  answer: string,
): AmbiguousFollowupAnswer | null {
  return answer === "track" || answer === "ignore" ? answer : null;
}

export function renderTrackedFollowupLine(text: string): string {
  return `- [ ] #followup ${trackedFollowupText(text)}`;
}

export function insertTrackedFollowup(input: {
  readonly content: string;
  readonly text: string;
}): string {
  const line = renderTrackedFollowupLine(input.text);
  if (input.content.split(/\r?\n/).some((candidate) => candidate === line)) {
    return input.content;
  }

  // Line-anchored bound via the core grammar primitive: the new follow-up
  // line is inserted just above the block's end-marker line.
  const { range } = findGeneratedBlock(
    input.content,
    TRACKED_FOLLOWUPS_OWNER,
    TRACKED_FOLLOWUPS_BLOCK,
  );
  if (range !== null) {
    const lines = input.content.split(/\r?\n/);
    const next = [
      ...lines.slice(0, range.endLine - 1),
      line,
      ...lines.slice(range.endLine - 1),
    ];
    return next.join("\n");
  }

  const suffix = input.content.endsWith("\n") ? "" : "\n";
  return [
    `${input.content}${suffix}`,
    TRACKED_FOLLOWUPS_START,
    "### Tracked Follow-ups",
    line,
    TRACKED_FOLLOWUPS_END,
    "",
  ].join("\n");
}

function trackedFollowupText(text: string): string {
  const trimmed = text.trim();
  const should = /^(?:we|i)\s+should\s+(follow\s+up\s+with\b.*)$/i.exec(
    trimmed,
  );
  if (should?.[1] !== undefined) return capitalize(should[1]);
  const need = /^(?:need|needs|needed)\s+to\s+(follow\s+up\s+with\b.*)$/i.exec(
    trimmed,
  );
  if (need?.[1] !== undefined) return capitalize(need[1]);
  return trimmed;
}

function capitalize(value: string): string {
  return value.length === 0
    ? value
    : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}

function parseTarget(value: unknown): AmbiguousFollowupTarget | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 && record.version !== 2) return null;
  if (typeof record.path !== "string" || record.path === "") return null;
  if (record.version === 1) {
    if (
      typeof record.line !== "number" ||
      !Number.isInteger(record.line) ||
      record.line <= 0
    ) {
      return null;
    }
  } else if (record.line !== undefined) {
    return null;
  }
  if (typeof record.text !== "string" || record.text.trim() === "") {
    return null;
  }
  if (record.version === 1) {
    return Object.freeze({
      version: 1,
      path: record.path,
      line: record.line as number,
      text: record.text,
    });
  }
  return Object.freeze({
    version: 2,
    path: record.path,
    text: record.text,
  });
}
