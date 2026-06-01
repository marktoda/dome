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
  readonly sourceHash?: string;
  readonly generatedPath?: string;
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
      ...(target.sourceHash !== undefined
        ? { sourceHash: target.sourceHash }
        : {}),
      ...(target.generatedPath !== undefined
        ? { generatedPath: target.generatedPath }
        : {}),
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
  if (
    record.sourceHash !== undefined &&
    !isSha256Hex(record.sourceHash)
  ) {
    return null;
  }
  if (
    record.generatedPath !== undefined &&
    (typeof record.generatedPath !== "string" ||
      !/^wiki\/generated\/intake\/[^/]+\.md$/.test(record.generatedPath))
  ) {
    return null;
  }
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
    ...(typeof record.sourceHash === "string"
      ? { sourceHash: record.sourceHash }
      : {}),
    ...(typeof record.generatedPath === "string"
      ? { generatedPath: record.generatedPath }
      : {}),
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

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
