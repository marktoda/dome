// cli/commands/proposals: `dome proposals` — list pending garden
// propose-mode patches awaiting review. The data core (`collectProposals`)
// lives in src/surface/proposals.ts and is shared with the MCP `proposals`
// tool and the HTTP `GET /proposals` route (Task 7); this module owns
// terminal rendering only (mirrors src/cli/commands/settle.ts).

import {
  collectProposals,
  proposalsJson,
  type ProposalView,
} from "../../surface/proposals";
import { formatJson } from "../../surface/format";
import { resolveVaultPath } from "../../surface/resolve-vault";

export type RunProposalsOptions = {
  readonly all?: boolean | undefined;
  readonly vault?: string | undefined;
  readonly json?: boolean | undefined;
};

/**
 * Execute `dome proposals`. Always exits 0 — this is a read-only list view,
 * like `dome query`; there is no error state beyond an empty result.
 */
export async function runProposals(
  options: RunProposalsOptions = {},
): Promise<number> {
  const json = options.json === true;
  const vaultPath = resolveVaultPath(options.vault);
  const result = await collectProposals(vaultPath, {
    all: options.all === true,
  });

  if (json) {
    console.log(formatJson(proposalsJson(result)));
    return 0;
  }

  if (result.proposals.length === 0) {
    console.log("dome proposals: nothing awaiting review.");
    return 0;
  }

  console.log(result.proposals.map(formatProposalBlock).join("\n\n"));
  return 0;
}

// ----- internals -------------------------------------------------------------

/**
 * Render one proposal as a three-line block:
 *   P<id>  <processorId>  <age>  <path> (+added -removed)[ +N more][ [stale ...]]
 *        <reason>
 *        apply: dome apply <id>   ·   reject: dome reject <id>
 */
function formatProposalBlock(p: ProposalView): string {
  const firstPath = p.paths[0] ?? "(no paths)";
  const diffSuffix = diffStatSuffix(p, firstPath);
  const moreSuffix = p.paths.length > 1 ? ` +${p.paths.length - 1} more` : "";
  const staleSuffix = p.stale
    ? " [stale — regenerates on next garden pass]"
    : "";
  const header =
    `P${p.id}  ${p.processorId}  ${ageLabel(p.createdAt)}  ${firstPath}` +
    `${diffSuffix}${moreSuffix}${staleSuffix}`;
  return [
    header,
    `     ${p.reason}`,
    `     apply: dome apply ${p.id}   ·   reject: dome reject ${p.id}`,
  ].join("\n");
}

function diffStatSuffix(p: ProposalView, path: string): string {
  const stat = p.diffStat.find((d) => d.path === path);
  if (stat === undefined) return "";
  return ` (+${stat.added} −${stat.removed})`;
}

function ageLabel(createdAt: string): string {
  const createdMs = new Date(createdAt).getTime();
  if (Number.isNaN(createdMs)) return "?d";
  const days = Math.max(0, Math.floor((Date.now() - createdMs) / 86_400_000));
  return `${days}d`;
}
