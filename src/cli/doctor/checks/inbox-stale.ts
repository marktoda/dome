// INBOX_IS_EPHEMERAL fallback check.
//
// CHECK 9: files in `inbox/<bucket>/` (excluding `inbox/review/`, which is a
// destination not an intake) aged past `hooks.inbox_stale_age_hours` emit a
// violation. Per docs/wiki/invariants/INBOX_IS_EPHEMERAL.md §"Structural
// enforcement" — last line of defence when intake hooks fail to drain.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Vault } from "../../../vault";
import type { CheckResult } from "./types";

export async function checkInboxStale(vault: Vault): Promise<CheckResult> {
  const violations: string[] = [];
  const info: string[] = [];

  const inboxRoot = join(vault.path, "inbox");
  if (existsSync(inboxRoot)) {
    const thresholdMs = vault.config.hooks.inbox_stale_age_hours * 60 * 60 * 1000;
    const cutoff = Date.now() - thresholdMs;
    const buckets = await readdir(inboxRoot, { withFileTypes: true });
    for (const bucket of buckets) {
      if (!bucket.isDirectory()) continue;
      // inbox/review/ is a lint-report destination, not an intake — exclude
      // unconditionally per INBOX_IS_EPHEMERAL.md.
      if (bucket.name === "review") continue;
      const bucketDir = join(inboxRoot, bucket.name);
      const files = await readdir(bucketDir, { withFileTypes: true });
      for (const f of files) {
        if (!f.isFile()) continue;
        const filePath = join(bucketDir, f.name);
        const st = await stat(filePath);
        if (st.mtimeMs < cutoff) {
          const ageHours = ((Date.now() - st.mtimeMs) / (60 * 60 * 1000)).toFixed(1);
          violations.push(
            `inbox/${bucket.name}/${f.name}: stale (${ageHours}h old, threshold ${vault.config.hooks.inbox_stale_age_hours}h) — INBOX_IS_EPHEMERAL`,
          );
        }
      }
    }
  }

  return { violations, info };
}
