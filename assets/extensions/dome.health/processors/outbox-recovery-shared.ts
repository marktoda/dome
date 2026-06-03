export const OUTBOX_RECOVERY_QUESTION_PREFIX =
  "dome.health.outbox-recovery:";
export const OUTBOX_RECOVERY_FAILURE_SEPARATOR = "|failure:";

export const OUTBOX_RECOVERY_OPTIONS = Object.freeze(["retry", "abandon"]);

export type OutboxRecoveryAnswer = "retry" | "abandon";

export function parseOutboxRecoveryAnswer(
  value: string,
): OutboxRecoveryAnswer | null {
  return value === "retry" || value === "abandon" ? value : null;
}

export function outboxKeyFromQuestionIdempotencyKey(
  idempotencyKey: string,
): string | null {
  if (!idempotencyKey.startsWith(OUTBOX_RECOVERY_QUESTION_PREFIX)) {
    return null;
  }
  const suffix = idempotencyKey.slice(OUTBOX_RECOVERY_QUESTION_PREFIX.length);
  const separatorIndex = suffix.lastIndexOf(OUTBOX_RECOVERY_FAILURE_SEPARATOR);
  return separatorIndex === -1 ? suffix : suffix.slice(0, separatorIndex);
}

export function failureTokenFromQuestionIdempotencyKey(
  idempotencyKey: string,
): string | null {
  if (!idempotencyKey.startsWith(OUTBOX_RECOVERY_QUESTION_PREFIX)) {
    return null;
  }
  const suffix = idempotencyKey.slice(OUTBOX_RECOVERY_QUESTION_PREFIX.length);
  const separatorIndex = suffix.lastIndexOf(OUTBOX_RECOVERY_FAILURE_SEPARATOR);
  if (separatorIndex === -1) return null;
  const token = suffix.slice(
    separatorIndex + OUTBOX_RECOVERY_FAILURE_SEPARATOR.length,
  );
  return token.length === 0 ? null : token;
}
