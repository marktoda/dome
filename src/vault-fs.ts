// Vault filesystem walker. Centralizes the recursive .md walk that several
// Tools and Hooks need (search-index, move-document, auto-cross-reference,
// doctor). Each call-site previously hand-rolled the same generator; this
// module is the single implementation.

import { readdir } from "node:fs/promises";
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
 * swallows ENOENT on `root` itself (returns no entries); errors on
 * subdirectories propagate. When `opts.tops` is provided, only walks those
 * named subdirectories of `root`.
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
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkAll(p);
    else if (e.isFile() && e.name.endsWith(".md")) yield p;
  }
}
