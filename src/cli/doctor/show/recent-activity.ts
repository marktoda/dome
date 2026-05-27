// `--recent-activity [N]`: print the last N entries from log.md as info
// lines prefixed `recent:`. Default N is 50 when the flag is passed without
// a value. Each log entry is `## [ts] verb | subject` — we surface the
// last N in document order.

import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Vault } from "../../../vault";

export async function showRecentActivity(
  vault: Vault,
  limit: number,
): Promise<{ info: string[] }> {
  const info: string[] = [];

  const logPath = join(vault.path, "log.md");
  if (existsSync(logPath)) {
    const logText = await Bun.file(logPath).text();
    const re = /^## \[([^\]]+)\] (\S+) \| (.+)$/gm;
    const entries: { ts: string; verb: string; subject: string }[] = [];
    for (const m of logText.matchAll(re)) {
      entries.push({ ts: m[1]!, verb: m[2]!, subject: m[3]! });
    }
    const tail = entries.slice(-limit);
    for (const e of tail) {
      info.push(`recent: [${e.ts}] ${e.verb} | ${e.subject}`);
    }
  }

  return { info };
}
