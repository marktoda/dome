// Tool adapter for the semantic-gardening executor. Navigation is direct
// markdown access; writes accumulate in AgentRunState and leave the module as
// a proposal, never as an automatic edit.

import type { AgentTool } from "./agent-loop";
import { validateSplitProposal, type SplitProposalInput } from "./split-proposal";
import {
  askOwnerTool,
  deletePageTool,
  flagIntegrityTool,
  listPagesTool,
  objectSchema,
  readPageTool,
  searchVaultTool,
  writePageTool,
  type VaultReader,
} from "./vault-tools";

const STRING = { type: "string" } as const;

/** Mirror of dome.agent.garden's patch.propose declaration. */
export const GARDEN_WRITABLE_PATHS: ReadonlyArray<string> = Object.freeze([
  "wiki/**/*.md",
]);

export function makeGardenTools(reader: VaultReader): ReadonlyArray<AgentTool> {
  return [
    readPageTool(reader),
    listPagesTool(reader),
    searchVaultTool(reader),
    writePageTool(GARDEN_WRITABLE_PATHS),
    deletePageTool(GARDEN_WRITABLE_PATHS),
    proposeSplitTool(reader),
    askOwnerTool("dome.agent.garden:"),
    flagIntegrityTool(),
  ];
}

/**
 * A lossless split stays a first-class validated proposal. The garden charter
 * limits a run to one opportunity, so this remains the run's one semantic
 * change set rather than a secondary maintenance stream.
 */
export function proposeSplitTool(reader: VaultReader): AgentTool {
  return {
    schema: {
      name: "proposeSplit",
      description:
        "Propose a lossless split of one existing page into its rewritten hub and 2-6 new sibling pages. Every original line must remain in the hub or one sub-page; every sub-page needs description frontmatter and the hub must link each full path. Do not also writePage these paths.",
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
        return "error: one split proposal per garden run.";
      }
      const parsed = input as SplitProposalInput;
      const original = await reader.readFile(parsed.hubPath);
      if (original === null) return `error: ${parsed.hubPath} does not exist.`;
      for (const sub of parsed.subPages) {
        if ((await reader.readFile(sub.path)) !== null) {
          return `error: ${sub.path} already exists; split sub-pages must be new.`;
        }
      }
      const invalid = validateSplitProposal(parsed, original);
      if (invalid !== null) return `error: ${invalid.message}`;
      state.splitProposal = parsed;
      return `proposed split of ${parsed.hubPath} into ${parsed.subPages.length} sub-page(s)`;
    },
  };
}
