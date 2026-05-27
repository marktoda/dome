// walkUpForAncestor — generic walk-up-parents-until-predicate-matches helper.
//
// Used by `findVaultRoot` (looks for `.dome/config.yaml`) and `findGitRoot`
// (looks for `.git/` with HEAD validation). Names the shared walk-up pattern
// and eliminates off-by-one risks across two previously hand-coded loops.
//
// The predicate is synchronous — both current callers test filesystem
// presence via `existsSync`/`statSync`, so an async predicate would be
// gratuitous. Callers that need async resolution can wrap their predicate
// in a sync existence check and resolve further inside the returned path.
//
// Future v1+ consumers (per-user vault discovery, multi-vault root lookup)
// reuse this helper rather than copying the loop a third time.

import { dirname, resolve } from "node:path";

export function walkUpForAncestor(
  start: string,
  accept: (path: string) => boolean,
): string | null {
  let current = resolve(start);
  for (;;) {
    if (accept(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
