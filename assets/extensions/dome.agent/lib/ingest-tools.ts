// Tool bindings for the ingest agent — composed from the shared vault-tools.
import type { AgentTool } from "./agent-loop";
import {
  appendToPageTool,
  archiveSourceTool,
  askOwnerTool,
  listPagesTool,
  readPageTool,
  searchVaultTool,
  writePageTool,
  type VaultReader,
} from "./vault-tools";

export type { VaultReader } from "./vault-tools";

export function makeIngestTools(opts: {
  readonly reader: VaultReader;
}): ReadonlyArray<AgentTool> {
  const { reader } = opts;
  return [
    readPageTool(reader),
    listPagesTool(reader),
    searchVaultTool(reader),
    writePageTool(),
    appendToPageTool(reader),
    archiveSourceTool(reader),
    askOwnerTool("dome.agent.ingest:"),
  ];
}
