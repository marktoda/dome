// cli/commands/reject: `dome reject <id> [note...]` — the CLI binding for
// rejecting a pending proposal. The data core (the CAS decide, no working-
// tree write) lives in src/surface/proposals.ts and is shared with the MCP
// `reject_proposal` tool and the HTTP `POST /reject` route (Task 7); this
// module owns terminal rendering only (mirrors src/cli/commands/settle.ts).
// The optional trailing note words mirror `dome resolve`'s variadic value.

import {
  performReject,
  rejectResultJson,
  type RejectResult,
} from "../../surface/proposals";
import { formatJson } from "../../surface/format";
import { resolveVaultPath } from "../../surface/resolve-vault";
import { parseProposalId } from "./proposal-id";

export type RunRejectOptions = {
  readonly id?: string | undefined;
  readonly note?: string | undefined;
  readonly vault?: string | undefined;
  readonly json?: boolean | undefined;
};

/**
 * Execute `dome reject`. Returns the exit code: 0 on `rejected`; 64
 * (EX_USAGE) on `not-found`, `not-pending`, or `invalid`. All CAS semantics
 * live in `performReject` — this handler only parses CLI input and renders
 * the outcome.
 */
export async function runReject(options: RunRejectOptions = {}): Promise<number> {
  const json = options.json === true;
  const vaultPath = resolveVaultPath(options.vault);
  const id = parseProposalId(options.id);

  const result: RejectResult =
    id === null
      ? { status: "invalid", message: invalidIdMessage(options.id) }
      : await performReject(vaultPath, id, options.note);

  if (json) {
    console.log(formatJson(rejectResultJson(result)));
    return result.status === "rejected" ? 0 : 64;
  }

  if (result.status === "rejected") {
    console.log(`dome reject: rejected P${result.id}`);
    return 0;
  }
  console.error(`dome reject: ${result.message}`);
  return 64;
}

// ----- internals -------------------------------------------------------------

function invalidIdMessage(raw: string | undefined): string {
  return `"${raw ?? ""}" is not a valid proposal id`;
}
