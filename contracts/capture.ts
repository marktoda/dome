/** Versioned capture wire contract shared by host adapters and browser clients. */
export const CAPTURE_SCHEMA = "dome.capture/v1" as const;

export type CaptureRequest = {
  readonly text: string;
  readonly title?: string;
  /** Stable logical identity generated once by a retrying client. */
  readonly captureId?: string;
};

export type CaptureReceipt =
  | {
      readonly schema: typeof CAPTURE_SCHEMA;
      readonly status: "captured";
      readonly vault: string;
      readonly path: string;
      readonly commit: string;
      readonly capture_id?: string;
      readonly title: string;
      readonly captured_at: string;
      readonly source: string;
      readonly branch: string;
      readonly serve_status: "running" | "stale" | "off";
      readonly adopted_initialized: boolean;
      readonly compile_pending: boolean;
      readonly commit_status: "committed";
      readonly adoption_status: "pending";
    }
  | {
      readonly schema: typeof CAPTURE_SCHEMA;
      readonly status: "duplicate";
      readonly vault: string;
      readonly path: string;
      readonly capture_id: string;
      readonly commit_status: "already-committed";
      readonly adoption_status: "unknown";
    }
  | {
      readonly schema: typeof CAPTURE_SCHEMA;
      readonly status: "error";
      readonly vault: string;
      readonly error: string;
    };

/** Defensive boundary for data received from an independently deployed host. */
export function parseCaptureReceipt(value: unknown): CaptureReceipt {
  if (!isRecord(value) || value.schema !== CAPTURE_SCHEMA) {
    throw new Error("invalid capture receipt: wrong schema");
  }
  if (value.status === "error") {
    requireString(value, "vault");
    requireString(value, "error");
    return value as CaptureReceipt;
  }
  requireString(value, "path");
  requireString(value, "vault");
  if (value.status === "duplicate") {
    requireString(value, "capture_id");
    if (value.commit_status !== "already-committed" || value.adoption_status !== "unknown") {
      throw new Error("invalid capture receipt: bad duplicate state");
    }
    return value as CaptureReceipt;
  }
  if (value.status === "captured") {
    for (const key of ["commit", "title", "captured_at", "source", "branch"] as const) {
      requireString(value, key);
    }
    if (value.commit_status !== "committed" || value.adoption_status !== "pending") {
      throw new Error("invalid capture receipt: bad committed state");
    }
    if (
      value.serve_status !== "running" &&
      value.serve_status !== "stale" &&
      value.serve_status !== "off"
    ) {
      throw new Error("invalid capture receipt: bad serve_status");
    }
    requireBoolean(value, "adopted_initialized");
    requireBoolean(value, "compile_pending");
    return value as CaptureReceipt;
  }
  throw new Error("invalid capture receipt: unknown status");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: Record<string, unknown>, key: string): void {
  if (typeof value[key] !== "string" || value[key].length === 0) {
    throw new Error(`invalid capture receipt: missing ${key}`);
  }
}

function requireBoolean(value: Record<string, unknown>, key: string): void {
  if (typeof value[key] !== "boolean") {
    throw new Error(`invalid capture receipt: missing ${key}`);
  }
}
