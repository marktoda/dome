// Tool bindings for the morning-brief agent — composed from the shared
// vault-tools. The ingest read set plus the daily-note write; no deletePage
// (the brief never removes pages) and no archiveSource (nothing to consume).
import type { AgentTool } from "./agent-loop";
import {
  appendToPageTool,
  askOwnerTool,
  listPagesTool,
  readPageTool,
  searchVaultTool,
  signalsAppendOnlyGuard,
  writePageTool,
  type VaultReader,
} from "./vault-tools";

/**
 * Bundle-local mirror of the `dome.agent.brief` manifest `patch.auto`
 * grant. Pinned to manifest.yaml by the grant-aware-tools manifest-sync
 * test — edit both together. (The brief processor's splice guard is
 * stricter still: only today's daily note lands.)
 */
export const BRIEF_WRITABLE_PATHS: ReadonlyArray<string> = Object.freeze([
  "wiki/dailies/*.md",
  "notes/*.md",
  // Validated signal-line appends only — enforced at tool time by
  // signalsAppendOnlyGuard (and again by the brief processor's post-run
  // splice guard, which drops anything that slips through).
  "preferences/signals.md",
]);

export function makeBriefTools(opts: {
  readonly reader: VaultReader;
}): ReadonlyArray<AgentTool> {
  const { reader } = opts;
  // preferences/signals.md is writable but append-only: the guard rejects
  // rewrites/deletions at tool time so the model cannot touch the owner's
  // rejection tombstones — self-correctable mid-loop, instead of relying
  // solely on the brief processor's post-run splice guard (silent drop).
  const guard = signalsAppendOnlyGuard(reader);
  return [
    readPageTool(reader),
    listPagesTool(reader),
    searchVaultTool(reader),
    writePageTool(BRIEF_WRITABLE_PATHS, guard),
    appendToPageTool(reader, BRIEF_WRITABLE_PATHS, guard),
    askOwnerTool("dome.agent.brief:"),
  ];
}
