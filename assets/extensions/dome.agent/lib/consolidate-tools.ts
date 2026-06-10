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

/**
 * Bundle-local mirror of the `dome.agent.consolidate` manifest `patch.auto`
 * grant. Pinned to manifest.yaml by the grant-aware-tools manifest-sync
 * test — edit both together.
 */
export const CONSOLIDATE_WRITABLE_PATHS: ReadonlyArray<string> = Object.freeze([
  "wiki/**/*.md",
  "index.md",
  "log.md",
  "consolidation-ledger.md",
  "preferences/signals.md",
]);

export function makeConsolidatorTools(opts: {
  readonly reader: VaultReader;
  /**
   * The resolved consolidation ledger path. The manifest grant covers only
   * the default `consolidation-ledger.md`; a config-overridden path needs a
   * matching vault grant for the broker, and threading it here keeps the
   * tool-time boundary in step with that grant.
   */
  readonly ledgerPath: string;
}): ReadonlyArray<AgentTool> {
  const { reader, ledgerPath } = opts;
  const writable = CONSOLIDATE_WRITABLE_PATHS.includes(ledgerPath)
    ? CONSOLIDATE_WRITABLE_PATHS
    : [...CONSOLIDATE_WRITABLE_PATHS, ledgerPath];
  return [
    readPageTool(reader),
    listPagesTool(reader),
    searchVaultTool(reader),
    writePageTool(writable),
    deletePageTool(writable),
    askOwnerTool("dome.agent.consolidate:"),
  ];
}
