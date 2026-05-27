// Vault filesystem walker. Centralizes the recursive .md walk that several
// Tools and Hooks need (search-index, move-document, auto-cross-reference,
// doctor). Each call-site previously hand-rolled the same generator; this
// module is the single implementation.
//
// Implementation note: uses `Bun.Glob` rather than a manual recursive
// `readdir` walk. Idiomatic for the Bun-only runtime, and surfaces glob
// errors (permission, etc.) rather than swallowing them silently — with
// the one explicit exception: a missing `root` itself yields no entries
// (callers like `rebuildIndex` invoke this for `wiki/` on a fresh vault
// before the directory exists). `{ dot: true }` preserves the original
// behavior of walking dotfile-prefixed directories and files.

import { existsSync } from "node:fs";
import { join } from "node:path";

export interface WalkMdOpts {
  /**
   * Restrict the walk to these top-level subdirectories of `root` (relative
   * names, no leading slash). When omitted, walks every subtree under `root`.
   */
  tops?: ReadonlyArray<string>;
}

/**
 * Recursively yield absolute paths of every .md file under `root`. Silently
 * skips a missing `root` (returns no entries); errors from the glob scan
 * propagate. When `opts.tops` is provided, only walks those named
 * subdirectories of `root`.
 */
export async function* walkMd(root: string, opts: WalkMdOpts = {}): AsyncGenerator<string> {
  if (opts.tops !== undefined) {
    for (const top of opts.tops) {
      yield* walkAll(join(root, top));
    }
    return;
  }
  yield* walkAll(root);
}

async function* walkAll(dir: string): AsyncGenerator<string> {
  if (!existsSync(dir)) return;
  const glob = new Bun.Glob("**/*.md");
  for await (const rel of glob.scan({ cwd: dir, dot: true })) {
    yield join(dir, rel);
  }
}
