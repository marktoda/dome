// `--show recent-hook-cycles`: parse `hook.cycle-detected` entries from
// log.md and surface them as info lines. A non-empty list means the
// dispatcher has aborted at least one event chain to break a feedback loop
// — operator should investigate before re-enabling involved handlers.

import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Vault } from "../../../vault";

export async function showRecentHookCycles(vault: Vault): Promise<{ info: string[] }> {
  const info: string[] = [];

  const logPath = join(vault.path, "log.md");
  if (existsSync(logPath)) {
    const logText = await Bun.file(logPath).text();
    const cycleRe = /^## \[([^\]]+)\] hook\.cycle-detected \| (.+)$/gm;
    const cycles: { ts: string; detail: string }[] = [];
    for (const m of logText.matchAll(cycleRe)) {
      cycles.push({ ts: m[1]!, detail: m[2]! });
    }
    if (cycles.length === 0) {
      info.push("hook-cycle: (none)");
    } else {
      for (const c of cycles) {
        info.push(`hook-cycle: [${c.ts}] ${c.detail}`);
      }
    }
  } else {
    info.push("hook-cycle: (log.md not present)");
  }

  return { info };
}
