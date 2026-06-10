// Tool bindings for the ingest agent — composed from the shared vault-tools.
import type { AgentTool } from "./agent-loop";
import {
  appendToPageTool,
  archiveSourceTool,
  askOwnerTool,
  listPagesTool,
  readPageTool,
  searchVaultTool,
  signalsAppendOnlyGuard,
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
  "preferences/signals.md",
]);

export function makeIngestTools(opts: {
  readonly reader: VaultReader;
}): ReadonlyArray<AgentTool> {
  const { reader } = opts;
  // preferences/signals.md is writable but append-only: the guard rejects
  // rewrites/deletions at tool time so the model cannot touch the owner's
  // rejection tombstones (same rule the brief enforces at splice time).
  const guard = signalsAppendOnlyGuard(reader);
  return [
    readPageTool(reader),
    listPagesTool(reader),
    searchVaultTool(reader),
    writePageTool(INGEST_WRITABLE_PATHS, guard),
    appendToPageTool(reader, INGEST_WRITABLE_PATHS, guard),
    archiveSourceTool(reader, INGEST_WRITABLE_PATHS),
    askOwnerTool("dome.agent.ingest:"),
  ];
}
