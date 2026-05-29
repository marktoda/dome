export const QUARANTINE_RECOVERY_QUESTION_PREFIX =
  "dome.health.quarantine-recovery:";

export const QUARANTINE_RECOVERY_OPTIONS = Object.freeze(["reset", "ignore"]);

export type QuarantineRecoveryAnswer = "reset" | "ignore";

export type QuarantineRecoveryTarget = {
  readonly phase: "adoption" | "garden" | "view";
  readonly processorId: string;
  readonly processorVersion: string;
  readonly triggerHash: string;
};

export function parseQuarantineRecoveryAnswer(
  answer: string,
): QuarantineRecoveryAnswer | null {
  return answer === "reset" || answer === "ignore" ? answer : null;
}

export function quarantineRecoveryQuestionKey(
  target: QuarantineRecoveryTarget & {
    readonly quarantinedAt: string;
    readonly consecutiveRetryableFailures: number;
  },
): string {
  return `${QUARANTINE_RECOVERY_QUESTION_PREFIX}${encodeURIComponent(
    JSON.stringify(target),
  )}`;
}

export function targetFromQuestionIdempotencyKey(
  key: string,
): QuarantineRecoveryTarget | null {
  if (!key.startsWith(QUARANTINE_RECOVERY_QUESTION_PREFIX)) return null;
  const encoded = key.slice(QUARANTINE_RECOVERY_QUESTION_PREFIX.length);
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
  if (typeof record.processorId !== "string" || record.processorId === "") {
    return null;
  }
  if (
    typeof record.processorVersion !== "string" ||
    record.processorVersion === ""
  ) {
    return null;
  }
  if (typeof record.triggerHash !== "string" || record.triggerHash === "") {
    return null;
  }
  return Object.freeze({
    phase,
    processorId: record.processorId,
    processorVersion: record.processorVersion,
    triggerHash: record.triggerHash,
  });
}
