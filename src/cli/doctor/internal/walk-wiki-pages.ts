// Shared iterator for `dome doctor` checks and shows that need to walk
// every wiki page. Yields (subdir, filename, rel) tuples. Skips silently
// when `wiki/` is absent (fresh vault, mid-init).

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Vault } from "../../../vault";

export async function* walkWikiPages(
  vault: Vault,
): AsyncGenerator<{ subdir: string; filename: string; rel: string }> {
  const wikiRoot = join(vault.path, "wiki");
  if (!existsSync(wikiRoot)) return;
  const subdirs = await readdir(wikiRoot, { withFileTypes: true });
  for (const subdir of subdirs) {
    if (!subdir.isDirectory()) continue;
    const files = await readdir(join(wikiRoot, subdir.name), { withFileTypes: true });
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".md")) continue;
      yield { subdir: subdir.name, filename: f.name, rel: `wiki/${subdir.name}/${f.name}` };
    }
  }
}
