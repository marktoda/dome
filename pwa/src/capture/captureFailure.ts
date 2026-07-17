export type CaptureFailureKind = "not-confirmed" | "needs-attention";

/** Typed delivery truth shared by the HTTP boundary and durable retry queue. */
export class CaptureDeliveryError extends Error {
  constructor(
    readonly kind: CaptureFailureKind,
    message: string,
    readonly status: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CaptureDeliveryError";
  }
}

export function captureFailureOf(error: unknown): Readonly<{
  kind: CaptureFailureKind;
  message: string;
}> {
  if (error instanceof CaptureDeliveryError) {
    return { kind: error.kind, message: error.message };
  }
  return {
    kind: "needs-attention",
    message: error instanceof Error ? error.message : String(error),
  };
}
