// cli/commands/apply: `dome apply <id>` — the CLI binding for applying a
// pending proposal. The data core (staleness check, working-tree write, the
// commit-or-nothing write) lives in src/surface/proposals.ts and is shared
// with the MCP `apply_proposal` tool and the HTTP `POST /apply` route (Task
// 7); this module owns terminal rendering only (mirrors
// src/cli/commands/settle.ts).

import {
  applyResultJson,
  performApply,
  type ApplyResult,
} from "../../surface/proposals";
import { formatJson } from "../../surface/format";
import { resolveVaultPath } from "../../surface/resolve-vault";
import { parseProposalId } from "./proposal-id";

export type RunApplyOptions = {
  readonly id?: string | undefined;
  readonly vault?: string | undefined;
  readonly json?: boolean | undefined;
};

/**
 * Execute `dome apply`. Returns the exit code: 0 on `applied`; 64
 * (EX_USAGE) on every other outcome (`stale`, `not-found`, `not-pending`,
 * `invalid`). All staleness/write/CAS semantics live in `performApply` —
 * this handler only parses CLI input and renders the outcome.
 */
export async function runApply(options: RunApplyOptions = {}): Promise<number> {
  const json = options.json === true;
  const vaultPath = resolveVaultPath(options.vault);
  const id = parseProposalId(options.id);

  const result: ApplyResult =
    id === null
      ? { status: "invalid", message: invalidIdMessage(options.id) }
      : await performApply(vaultPath, id);

  if (json) {
    console.log(formatJson(applyResultJson(result)));
    return result.status === "applied" ? 0 : 64;
  }

  if (result.status === "applied") {
    const suffix = result.commit !== undefined ? ` (${result.commit.slice(0, 7)})` : "";
    console.log(`dome apply: applied P${result.id}${suffix}`);
    return 0;
  }
  console.error(`dome apply: ${result.message}`);
  return 64;
}

// ----- internals -------------------------------------------------------------

function invalidIdMessage(raw: string | undefined): string {
  return `"${raw ?? ""}" is not a valid proposal id`;
}
