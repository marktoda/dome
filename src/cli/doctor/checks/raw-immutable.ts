// RAW_IS_IMMUTABLE structural check.
//
// CHECK 6: raw files modified after creation (heuristic for files that
// bypassed the Tool boundary). birthtime is unreliable on Linux ext4
// (returns 0); the > 0 guard skips ambiguous platforms.

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Vault } from "../../../vault";
import { walkMd } from "../../../vault-fs";
import type { CheckResult } from "./types";

export async function checkRawImmutable(vault: Vault): Promise<CheckResult> {
  const violations: string[] = [];
  const info: string[] = [];

  const rawRoot = join(vault.path, "raw");
  if (existsSync(rawRoot)) {
    for await (const filePath of walkMd(rawRoot)) {
      const st = await stat(filePath);
      // birthtime is unreliable on Linux ext4 (returns 0); guard with > 0.
      if (st.birthtimeMs > 0 && st.mtimeMs > st.birthtimeMs + 1000) {
        const rel = filePath.slice(vault.path.length + 1);
        violations.push(`${rel}: raw file modified after creation (RAW_IS_IMMUTABLE; mtime>${(st.mtimeMs - st.birthtimeMs).toFixed(0)}ms past ctime)`);
      }
    }
  }

  return { violations, info };
}
