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

export function makeBriefTools(opts: {
  readonly reader: VaultReader;
}): ReadonlyArray<AgentTool> {
  const { reader } = opts;
  return [
    readPageTool(reader),
    listPagesTool(reader),
    searchVaultTool(reader),
    writePageTool(),
    appendToPageTool(reader),
    askOwnerTool("dome.agent.brief:"),
  ];
}
