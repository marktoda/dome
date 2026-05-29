export const ORPHAN_RUN_RECOVERY_QUESTION_PREFIX =
  "dome.health.orphan-run-recovery:";

export const ORPHAN_RUN_RECOVERY_OPTIONS = Object.freeze(["fail", "ignore"]);

export type OrphanRunRecoveryAnswer = "fail" | "ignore";

export type OrphanRunRecoveryTarget = {
  readonly runId: string;
  readonly startedAt: string;
  readonly processorId: string;
  readonly processorVersion: string;
  readonly phase: "adoption" | "garden" | "view";
};

export function parseOrphanRunRecoveryAnswer(
  answer: string,
): OrphanRunRecoveryAnswer | null {
  return answer === "fail" || answer === "ignore" ? answer : null;
}

export function orphanRunRecoveryQuestionKey(
  target: OrphanRunRecoveryTarget,
): string {
  return `${ORPHAN_RUN_RECOVERY_QUESTION_PREFIX}${encodeURIComponent(
    JSON.stringify(target),
  )}`;
}

export function orphanRunTargetFromQuestionIdempotencyKey(
  key: string,
): OrphanRunRecoveryTarget | null {
  if (!key.startsWith(ORPHAN_RUN_RECOVERY_QUESTION_PREFIX)) return null;
  const encoded = key.slice(ORPHAN_RUN_RECOVERY_QUESTION_PREFIX.length);
  let raw: unknown;
  try {
    raw = JSON.parse(decodeURIComponent(encoded));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const phase = record.phase;
  if (phase !== "adoption" && phase !== "garden" && phase !== "view") {
    return null;
  }
  if (typeof record.runId !== "string" || record.runId === "") return null;
  if (
    typeof record.startedAt !== "string" ||
    Number.isNaN(new Date(record.startedAt).getTime())
  ) {
    return null;
  }
  if (typeof record.processorId !== "string" || record.processorId === "") {
    return null;
  }
  if (
    typeof record.processorVersion !== "string" ||
    record.processorVersion === ""
  ) {
    return null;
  }
  return Object.freeze({
    runId: record.runId,
    startedAt: new Date(record.startedAt).toISOString(),
    processorId: record.processorId,
    processorVersion: record.processorVersion,
    phase,
  });
}
