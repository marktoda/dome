// Shared iterator for `dome doctor` checks and shows that need to walk
// every wiki page. Yields (subdir, filename, rel) tuples. Skips silently
// when `wiki/` is absent (fresh vault, mid-init).
//
// Implementation note: uses `Bun.Glob` with pattern `*/*.md` to match the
// `wiki/<subdir>/<filename>.md` shape directly — i.e. one level of subdir,
// then the markdown file. Nested deeper paths under `wiki/<subdir>/` are
// intentionally NOT walked (matches the original two-level readdir loop).

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Vault } from "../../../vault";

export async function* walkWikiPages(
  vault: Vault,
): AsyncGenerator<{ subdir: string; filename: string; rel: string }> {
  const wikiRoot = join(vault.path, "wiki");
  if (!existsSync(wikiRoot)) return;
  const glob = new Bun.Glob("*/*.md");
  for await (const rel of glob.scan({ cwd: wikiRoot, dot: true })) {
    // rel is `<subdir>/<filename>.md` with POSIX separator (Bun.Glob output).
    const slash = rel.indexOf("/");
    if (slash === -1) continue;
    const subdir = rel.slice(0, slash);
    const filename = rel.slice(slash + 1);
    yield { subdir, filename, rel: `wiki/${rel}` };
  }
}
