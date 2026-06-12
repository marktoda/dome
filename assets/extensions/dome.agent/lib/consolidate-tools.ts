// Tool set for the consolidator agent — composed from the shared vault-tools.
import type { AgentTool } from "./agent-loop";
import {
  askOwnerTool,
  deletePageTool,
  listPagesTool,
  readPageTool,
  searchVaultTool,
  signalsAppendOnlyGuard,
  writePageTool,
  type VaultReader,
} from "./vault-tools";

/**
 * Bundle-local mirror of the `dome.agent.consolidate` manifest `patch.auto`
 * grant. Pinned to manifest.yaml by the grant-aware-tools manifest-sync
 * test — edit both together.
 *
 * `index.md` and `log.md` are deliberately absent (read grant only, like
 * core.md — the core-memory.ts grant shape): the index is generated from
 * page `description:` frontmatter and log.md is frozen history. The broker
 * verdict is per-PatchEffect (all-or-nothing), so a stray write to either
 * must die HERE at the tool — self-correctable mid-loop — not poison the
 * whole batched patch.
 */
export const CONSOLIDATE_WRITABLE_PATHS: ReadonlyArray<string> = Object.freeze([
  "wiki/**/*.md",
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
  // preferences/signals.md is writable but append-only: the guard rejects
  // rewrites/deletions at tool time so the model cannot touch the owner's
  // rejection tombstones (same rule the brief enforces at splice time).
  const guard = signalsAppendOnlyGuard(reader);
  return [
    readPageTool(reader),
    listPagesTool(reader),
    searchVaultTool(reader),
    writePageTool(writable, guard),
    deletePageTool(writable, guard),
    askOwnerTool("dome.agent.consolidate:"),
  ];
}
