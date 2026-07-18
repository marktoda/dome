// One cached Bun.Glob implementation for every vault-relative policy.
//
// This module is deliberately neutral: capabilities, content scope, triggers,
// and write policy all consume the same matching language without depending on
// one another. The cache is an implementation detail; callers get one pure
// predicate and cannot mutate or flush shared state.

const globCache = new Map<string, Bun.Glob>();

/** Match one non-empty POSIX-style path against one non-empty Bun glob. */
export function globMatch(pattern: string, path: string): boolean {
  if (pattern.length === 0 || path.length === 0) return false;
  if (pattern === path) return true;

  let glob = globCache.get(pattern);
  if (glob === undefined) {
    glob = new Bun.Glob(pattern);
    globCache.set(pattern, glob);
  }
  return glob.match(path);
}
