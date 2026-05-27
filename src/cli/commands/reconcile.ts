import { domeSync } from "./sync";
import type { Result, ToolError } from "../../types";

export interface ReconcileResult {
  inboxProcessed: number;
  changedFiles: number;
  scheduledFired: number;
}

/**
 * `dome reconcile` — deprecated alias for `dome sync`. Preserved for
 * back-compat with v0.5 cron entries, test fixtures, and harness
 * invocations. Delegates to `domeSync` and projects the result onto the
 * pre-rewrite shape (the three counters callers expect).
 *
 * The deprecation notice is printed at the CLI wiring layer in `cli.ts`
 * rather than here so programmatic consumers (tests calling `domeReconcile`
 * directly) don't get stderr noise.
 *
 * See docs/wiki/specs/adoption.md §"Relationship to `dome reconcile`".
 */
export async function domeReconcile(
  vaultPath: string,
): Promise<Result<ReconcileResult, ToolError>> {
  const r = await domeSync(vaultPath);
  if (!r.ok) return r;
  return {
    ok: true,
    value: {
      inboxProcessed: r.value.inboxProcessed,
      changedFiles: r.value.changedFiles,
      scheduledFired: r.value.scheduledFired,
    },
  };
}
