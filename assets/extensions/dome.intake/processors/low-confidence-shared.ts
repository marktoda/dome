export const LOW_CONFIDENCE_QUESTION_PREFIX =
  "dome.intake.low-confidence:";

export const LOW_CONFIDENCE_QUESTION_OPTIONS = Object.freeze([
  "track",
  "ignore",
]);

export type CaptureLowConfidenceAnswer = "track" | "ignore";

export type CaptureLowConfidenceKind =
  | "task"
  | "followup"
  | "decision"
  | "entity";

export type CaptureLowConfidenceTarget = {
  readonly version: 1;
  readonly path: string;
  readonly kind: CaptureLowConfidenceKind;
  readonly text: string;
  readonly confidence?: number;
};

export function lowConfidenceQuestionKey(
  target: CaptureLowConfidenceTarget,
): string {
  return `${LOW_CONFIDENCE_QUESTION_PREFIX}${encodeURIComponent(
    JSON.stringify({
      version: target.version,
      path: target.path,
      kind: target.kind,
      text: target.text,
      ...(target.confidence !== undefined
        ? { confidence: target.confidence }
        : {}),
    }),
  )}`;
}

export function targetFromLowConfidenceQuestionKey(
  key: string,
): CaptureLowConfidenceTarget | null {
  if (!key.startsWith(LOW_CONFIDENCE_QUESTION_PREFIX)) return null;
  const encoded = key.slice(LOW_CONFIDENCE_QUESTION_PREFIX.length);
  let raw: unknown;
  try {
    raw = JSON.parse(decodeURIComponent(encoded));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) return null;
  if (typeof record.path !== "string" || record.path === "") return null;
  if (!isLowConfidenceKind(record.kind)) return null;
  if (typeof record.text !== "string" || record.text.trim() === "") {
    return null;
  }
  if (
    record.confidence !== undefined &&
    (typeof record.confidence !== "number" ||
      record.confidence < 0 ||
      record.confidence > 1)
  ) {
    return null;
  }
  return Object.freeze({
    version: 1,
    path: record.path,
    kind: record.kind,
    text: record.text,
    ...(record.confidence !== undefined
      ? { confidence: record.confidence }
      : {}),
  });
}

export function parseLowConfidenceAnswer(
  answer: string,
): CaptureLowConfidenceAnswer | null {
  return answer === "track" || answer === "ignore" ? answer : null;
}

function isLowConfidenceKind(
  value: unknown,
): value is CaptureLowConfidenceKind {
  return (
    value === "task" ||
    value === "followup" ||
    value === "decision" ||
    value === "entity"
  );
}
