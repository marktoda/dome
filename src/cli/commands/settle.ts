// cli/commands/settle: `dome settle` — the CLI binding for the settle verb.
// The data core (block-anchor lookup, disposition application, the
// commit-or-nothing write) lives in src/surface/settle.ts and is shared
// with the MCP `settle` tool and the HTTP `POST /settle` route; this module
// owns terminal rendering only (mirrors src/cli/commands/capture.ts).

import {
  performSettle,
  settleResultJson,
  type SettleDeps,
  type SettleDisposition,
  type SettleRequest,
  type SettleResult,
} from "../../surface/settle";
import { formatJson } from "../../surface/format";
import { resolveVaultPath } from "../../surface/resolve-vault";

export type { SettleDeps } from "../../surface/settle";

export type RunSettleOptions = {
  readonly blockId?: string | undefined;
  /** Raw CLI text; performSettle owns validating it against the disposition union. */
  readonly disposition?: string | undefined;
  /** YYYY-MM-DD; passed through untouched — performSettle owns the format check. */
  readonly until?: string | undefined;
  readonly vault?: string | undefined;
  readonly json?: boolean | undefined;
};

/**
 * Execute `dome settle`. Returns the exit code: 0 on `settled`; 64
 * (EX_USAGE) on `not-found` or `invalid`. All disposition/deferUntil
 * semantics live in `performSettle` — this handler only parses CLI input
 * and renders the outcome.
 */
export async function runSettle(
  options: RunSettleOptions = {},
  deps: SettleDeps = {},
): Promise<number> {
  const json = options.json === true;
  const vaultPath = resolveVaultPath(options.vault);
  const req: SettleRequest = {
    blockId: options.blockId ?? "",
    disposition: (options.disposition ?? "") as SettleDisposition,
    deferUntil: options.until,
  };

  const result = await performSettle(vaultPath, req, deps);

  if (json) {
    console.log(formatJson(settleResultJson(result)));
    return result.status === "settled" ? 0 : 64;
  }

  if (result.status === "settled") {
    console.log(formatSettledLine(result));
    return 0;
  }
  console.error(`dome settle: ${result.message}`);
  return 64;
}

// ----- internals -------------------------------------------------------------

function formatSettledLine(
  result: Extract<SettleResult, { status: "settled" }>,
): string {
  const suffix = result.commit !== undefined ? ` (${result.commit.slice(0, 7)})` : "";
  return `dome settle: ${result.disposition} ^${result.blockId}${suffix}`;
}
