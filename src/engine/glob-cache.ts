// Cached Bun.Glob compilation. Shared between the capability broker
// (path-glob matching for patch.auto / patch.propose / owns.path / read
// grants in `src/engine/capability-broker.ts`) and the processor runtime's
// trigger matcher (path-glob matching for `signal` and `path` triggers in
// `src/processors/triggers.ts`).
//
// No eviction policy in v1 — the pattern set is bounded by the loaded
// bundle set (tens to low hundreds of patterns in practice). A future
// polish pass can add an LRU if the cache grows unbounded under
// multi-vault test runs.
//
// House-style notes (matches src/engine/compile-range.ts,
// src/engine/capability-broker.ts):
//   - Module-private cache; no `clear`-the-cache public surface (v1 does
//     not need it; defer until tests require it).
//   - Guards on empty pattern / empty path return `false` to preserve the
//     prior call-site behavior the two consolidated helpers carried.
//   - Exact-string fast path skips Glob construction for the common case
//     of a literal path in a trigger pattern or an `owns.path` grant.

// Module-private compiled-Glob cache. No eviction — pattern set is bounded
// by the loaded bundle set; ~tens to low hundreds in practice.
const globCache = new Map<string, Bun.Glob>();

/**
 * Path-glob match using Bun's built-in glob matcher. Compiled `Bun.Glob`
 * instances are memoized in the module-private `globCache`.
 *
 * Tolerant of empty patterns / paths (returns `false`). Path strings are
 * POSIX-style vault-relative.
 */
export function globMatch(pattern: string, path: string): boolean {
  if (pattern.length === 0 || path.length === 0) return false;
  // Exact-string fast path — avoids constructing a Glob for the common
  // case of a literal path in an `owns.path` grant or a trigger pattern.
  if (pattern === path) return true;
  let glob = globCache.get(pattern);
  if (glob === undefined) {
    glob = new Bun.Glob(pattern);
    globCache.set(pattern, glob);
  }
  return glob.match(path);
}
