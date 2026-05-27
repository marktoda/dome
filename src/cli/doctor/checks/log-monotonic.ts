// log.md timestamp monotonicity check.
//
// CHECK 7: `## [timestamp]` headers must be monotonically non-decreasing.
// Out-of-order entries indicate a logger raced with itself or an external
// editor reordered entries — either way, downstream tail-walks that assume
// chronological order would silently miss events.

import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Vault } from "../../../vault";
import type { CheckResult } from "./types";

export async function checkLogMonotonic(vault: Vault): Promise<CheckResult> {
  const violations: string[] = [];
  const info: string[] = [];

  const logPath = join(vault.path, "log.md");
  if (existsSync(logPath)) {
    const logText = await Bun.file(logPath).text();
    const tsRe = /^## \[([^\]]+)\]/gm;
    let prev: string | null = null;
    let lineNo = 0;
    for (const match of logText.matchAll(tsRe)) {
      lineNo++;
      const ts = match[1]!;
      if (prev !== null && ts < prev) {
        violations.push(`log.md: non-monotonic timestamp at entry #${lineNo}: ${ts} < ${prev}`);
      }
      prev = ts;
    }
  }

  return { violations, info };
}
