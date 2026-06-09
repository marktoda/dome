// Tool set for the consolidator agent — composed from the shared vault-tools.
import type { AgentTool } from "./agent-loop";
import {
  askOwnerTool,
  deletePageTool,
  listPagesTool,
  readPageTool,
  searchVaultTool,
  writePageTool,
  type VaultReader,
} from "./vault-tools";

export function makeConsolidatorTools(opts: {
  readonly reader: VaultReader;
}): ReadonlyArray<AgentTool> {
  const { reader } = opts;
  return [
    readPageTool(reader),
    listPagesTool(reader),
    searchVaultTool(reader),
    writePageTool(),
    deletePageTool(),
    askOwnerTool("dome.agent.consolidate:"),
  ];
}
