// Active-projects block renderer — the pure core of the second gated core.md
// writer (v1 chunk 3b; two-gated-writers contract in
// docs/wiki/specs/preferences.md): the dome.agent.active-projects processor
// derives per-page open-loop tallies from the dailies and splices the
// rendered list into core.md's `dome.agent:active-projects` generated block,
// under the `## Active projects` heading the init skeleton scaffolds.
//
// Everything here is a pure function of its inputs — no clock, no I/O — so
// the block body is byte-deterministic per item set (diff-before-emit in the
// processor relies on this).

import { compareStrings } from "../../../../src/core/compare";
import { generatedBlockMarkers } from "../../../../src/core/generated-block";

/** One candidate project: a wiki page that current open loops point at. */
export type ActiveProjectItem = {
  /** Vault path of the project page (with or without the `.md` suffix). */
  readonly page: string;
  /** Distinct open loops currently attributed to the page. */
  readonly openLoops: number;
  /** YYYY-MM-DD of the newest daily that surfaced one of those loops. */
  readonly lastTouched: string;
};

const BLOCK_OWNER = "dome.agent";
const BLOCK_NAME = "active-projects";
const BLOCK_MARKERS = generatedBlockMarkers(BLOCK_OWNER, BLOCK_NAME);
export const ACTIVE_PROJECTS_START = BLOCK_MARKERS.start;
export const ACTIVE_PROJECTS_END = BLOCK_MARKERS.end;

/**
 * The block as an `(owner, block)` anomaly-scan target — what the processor
 * feeds `generatedBlockAnomalyDiagnostics` so marker damage in core.md
 * surfaces as an info diagnostic instead of staying invisible (the same shape
 * as `PROMOTED_PREFERENCES_BLOCK` in preferences-shared.ts).
 */
export const ACTIVE_PROJECTS_BLOCK: {
  readonly owner: string;
  readonly block: string;
} = Object.freeze({
  owner: BLOCK_OWNER,
  block: BLOCK_NAME,
});

/** Rendered when no open loop points at any wiki page. */
export const ACTIVE_PROJECTS_EMPTY_STATE =
  "_(no active projects detected — open loops feed this block)_";

/**
 * Render the block body: one `- [[<page>]] — <n> open loop(s), last touched
 * <date>` line per project, sorted by (openLoops desc, lastTouched desc,
 * page asc), capped at `opts.limit`. Empty input renders the fixed
 * empty-state line. Deterministic — never reads the clock, never mutates
 * `items`.
 */
export function renderActiveProjects(
  items: ReadonlyArray<ActiveProjectItem>,
  opts: { readonly limit: number },
): string {
  if (items.length === 0) return ACTIVE_PROJECTS_EMPTY_STATE;
  return [...items]
    .sort(compareActiveProjects)
    .slice(0, Math.max(0, opts.limit))
    .map(renderActiveProjectLine)
    .join("\n");
}

function compareActiveProjects(
  a: ActiveProjectItem,
  b: ActiveProjectItem,
): number {
  const loopsCmp = b.openLoops - a.openLoops;
  if (loopsCmp !== 0) return loopsCmp;
  const touchedCmp = compareStrings(b.lastTouched, a.lastTouched);
  if (touchedCmp !== 0) return touchedCmp;
  return compareStrings(a.page, b.page);
}

function renderActiveProjectLine(item: ActiveProjectItem): string {
  const target = item.page.replace(/\.md$/, "");
  const noun = item.openLoops === 1 ? "open loop" : "open loops";
  return `- [[${target}]] — ${item.openLoops} ${noun}, last touched ${item.lastTouched}`;
}
