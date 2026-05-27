// `--show review-queue`: lists files in inbox/review/, sorted by name.
//
// inbox/review/ is the lint-report destination — a queue of pages that have
// been flagged but not yet resolved. Empty/missing variants are reported
// rather than silently skipped so the operator can distinguish "no
// review-queue work" from "vault not initialized".

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Vault } from "../../../vault";

export async function showReviewQueue(vault: Vault): Promise<{ info: string[] }> {
  const info: string[] = [];

  const reviewDir = join(vault.path, "inbox", "review");
  if (existsSync(reviewDir)) {
    const items = await readdir(reviewDir, { withFileTypes: true });
    const files = items.filter(e => e.isFile()).map(e => e.name).sort();
    if (files.length === 0) {
      info.push("review-queue: (empty)");
    } else {
      for (const name of files) {
        const st = await stat(join(reviewDir, name));
        info.push(`review-queue: inbox/review/${name} (mtime ${new Date(st.mtimeMs).toISOString()})`);
      }
    }
  } else {
    info.push("review-queue: (inbox/review/ not present — run `dome init` or `dome doctor --repair`)");
  }

  return { info };
}
