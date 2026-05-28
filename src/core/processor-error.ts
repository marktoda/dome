const TRANSIENT_PROCESSOR_ERRORS = new WeakSet<object>();

export type TransientProcessorError = Error & {
  readonly retryable: true;
};

export function transientProcessorError(
  message: string,
): TransientProcessorError {
  const error = new Error(message) as TransientProcessorError;
  Object.defineProperty(error, "retryable", {
    value: true,
    enumerable: true,
  });
  TRANSIENT_PROCESSOR_ERRORS.add(error);
  return Object.freeze(error);
}

export function isTransientProcessorError(
  error: unknown,
): error is TransientProcessorError {
  return (
    typeof error === "object" &&
    error !== null &&
    TRANSIENT_PROCESSOR_ERRORS.has(error)
  );
}
