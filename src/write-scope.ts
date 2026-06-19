// src/write-scope.ts
//
// Path-scoped write authorization for agent write paths. A configurable layer
// ON TOP OF the unconditional structural floors (`.dome/`, RAW, .md-only) that
// src/agent/write.ts enforces directly. Reuses the engine's single `globMatch`
// matcher — no parallel glob language. Designed as the shared chokepoint both
// the hosted agent (src/agent/write.ts) and, later, the in-engine agents can
// consult (review §3.1 / §4.2).

import { globMatch } from "./engine/core/glob-cache";

export type WriteScope = {
  /** Glob patterns a path must match at least one of (empty = allow all). */
  readonly allow: readonly string[];
  /** Glob patterns that, if any matches, deny the write (wins over allow). */
  readonly deny: readonly string[];
};

/**
 * Default hosted-agent scope: any markdown EXCEPT the generated index, the
 * frozen activity log (NO_ACCRETING_REGISTRIES — writing them is always a bug),
 * and raw inbox captures (RAW_IS_IMMUTABLE — defense-in-depth alongside the
 * unconditional floor in write.ts).
 */
export const DEFAULT_AGENT_WRITE_SCOPE: WriteScope = Object.freeze({
  allow: ["**/*.md"],
  deny: ["index.md", "log.md", "inbox/raw/**"],
});

/** Denial reason if `relPath` is out of `scope`, else null. Deny wins over allow. */
export function writeScopeDenial(relPath: string, scope: WriteScope): string | null {
  for (const pattern of scope.deny) {
    if (globMatch(pattern, relPath)) {
      return `path '${relPath}' is denied by write scope (matches deny '${pattern}')`;
    }
  }
  if (scope.allow.length > 0 && !scope.allow.some((p) => globMatch(p, relPath))) {
    return `path '${relPath}' is outside the write scope (no allow pattern matched)`;
  }
  return null;
}
