export const OUTBOX_RECOVERY_QUESTION_PREFIX =
  "dome.health.outbox-recovery:";

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
  return idempotencyKey.startsWith(OUTBOX_RECOVERY_QUESTION_PREFIX)
    ? idempotencyKey.slice(OUTBOX_RECOVERY_QUESTION_PREFIX.length)
    : null;
}
