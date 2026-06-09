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
]);

export function makeBriefTools(opts: {
  readonly reader: VaultReader;
}): ReadonlyArray<AgentTool> {
  const { reader } = opts;
  return [
    readPageTool(reader),
    listPagesTool(reader),
    searchVaultTool(reader),
    writePageTool(BRIEF_WRITABLE_PATHS),
    appendToPageTool(reader, BRIEF_WRITABLE_PATHS),
    askOwnerTool("dome.agent.brief:"),
  ];
}
