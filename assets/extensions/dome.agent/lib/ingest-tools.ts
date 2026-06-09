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

/**
 * Bundle-local mirror of the `dome.agent.ingest` manifest `patch.auto`
 * grant. Pinned to manifest.yaml by the grant-aware-tools manifest-sync
 * test — edit both together.
 */
export const INGEST_WRITABLE_PATHS: ReadonlyArray<string> = Object.freeze([
  "wiki/**/*.md",
  "notes/**/*.md",
  "index.md",
  "log.md",
  "inbox/processed/*.md",
  "inbox/raw/*.md",
]);

export function makeIngestTools(opts: {
  readonly reader: VaultReader;
}): ReadonlyArray<AgentTool> {
  const { reader } = opts;
  return [
    readPageTool(reader),
    listPagesTool(reader),
    searchVaultTool(reader),
    writePageTool(INGEST_WRITABLE_PATHS),
    appendToPageTool(reader, INGEST_WRITABLE_PATHS),
    archiveSourceTool(reader, INGEST_WRITABLE_PATHS),
    askOwnerTool("dome.agent.ingest:"),
  ];
}
