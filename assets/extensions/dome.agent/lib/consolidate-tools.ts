// Tool set for the consolidator agent — composed from the shared vault-tools.
import type { AgentTool } from "./agent-loop";
import {
  validateSplitProposal,
  type SplitProposalInput,
} from "./split-proposal";
import {
  askOwnerTool,
  deletePageTool,
  flagIntegrityTool,
  listPagesTool,
  objectSchema,
  readPageTool,
  searchVaultTool,
  signalsAppendOnlyGuard,
  writePageTool,
  type VaultReader,
} from "./vault-tools";

const STRING = { type: "string" } as const;

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
  "meta/consolidation-ledger.md",
  "preferences/signals.md",
]);

export function makeConsolidatorTools(opts: {
  readonly reader: VaultReader;
  /**
   * The resolved consolidation ledger path. The manifest grant covers only
   * the default `meta/consolidation-ledger.md`; a config-overridden path needs a
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
    // Integrity review (folded in from the retired dome.warden.integrity):
    // findings surface as self-clearing diagnostics, never facts or edits.
    flagIntegrityTool(),
  ];
}

/**
 * The `proposeSplit` tool: PREPARE a hub + sub-pages split and hand it to
 * `validateSplitProposal` for deterministic lossless-accounting review; on
 * success it lands in `state.splitProposal` for `finishAgentRun` to emit as
 * a second, `mode: "propose"` PatchEffect the owner reviews via
 * `dome apply` — the model itself never applies a split (never via
 * `writePage`).
 *
 * NOT wired into {@link makeConsolidatorTools} yet — a later task adds it to
 * the consolidate charter + tool set once the charter teaches the operation.
 * Exported standalone so it can be composed and tested independently.
 *
 * Existence is checked here (against the injected reader), not inside the
 * pure validator: the hub page must already exist (that's what's being
 * split) and no sub-page path may already exist (a split creates NEW
 * pages only — an existing path is a naming collision, not a split
 * target). A second `proposeSplit` call in the same run is rejected: "one
 * split proposal per run" keeps the emitted propose-patch singular and the
 * model's rationale (`reason`) unambiguous.
 */
export function proposeSplitTool(reader: VaultReader): AgentTool {
  return {
    schema: {
      name: "proposeSplit",
      description:
        "Propose splitting an oversized/multi-topic page into a hub (rewritten original) + 2-6 new sub-pages, for the owner to review and apply with `dome apply`. Never applies directly — do not also writePage the hub or sub-pages. Every line of the original page must land in the hub or a sub-page (lossless); the hub must link every sub-page as a [[wikilink]]; every sub-page needs frontmatter with a description:. One split proposal per run.",
      inputSchema: objectSchema(
        {
          hubPath: STRING,
          hubContent: STRING,
          subPages: {
            type: "array",
            items: objectSchema(
              { path: STRING, content: STRING },
              ["path", "content"],
            ),
          },
          reason: STRING,
        },
        ["hubPath", "hubContent", "subPages", "reason"],
      ),
    },
    execute: async (input, state) => {
      if (state.splitProposal !== undefined && state.splitProposal !== null) {
        return "error: one split proposal per run — a split was already proposed this run.";
      }
      const parsed = input as SplitProposalInput;
      const original = await reader.readFile(parsed.hubPath);
      if (original === null) {
        return `error: ${parsed.hubPath} does not exist; proposeSplit only splits an existing page.`;
      }
      for (const sub of parsed.subPages) {
        const existing = await reader.readFile(sub.path);
        if (existing !== null) {
          return `error: ${sub.path} already exists; sub-pages must be new pages, not overwrites.`;
        }
      }
      const invalid = validateSplitProposal(parsed, original);
      if (invalid !== null) {
        return `error: ${invalid.message}`;
      }
      state.splitProposal = parsed;
      return `proposed split of ${parsed.hubPath} into ${parsed.subPages.length} sub-page(s): ${parsed.subPages.map((s) => s.path).join(", ")}`;
    },
  };
}
