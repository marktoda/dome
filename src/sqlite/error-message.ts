// Shared error-message stringifier for the durable sqlite stores. Identical
// to the per-store helper each db.ts previously carried: prefer `Error.message`,
// pass strings through, and JSON.stringify everything else (falling back to
// `String()` if that throws) — better than `[object Object]` for the
// error-cause string callers surface in a ToolError.

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
