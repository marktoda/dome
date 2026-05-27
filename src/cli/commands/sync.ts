import { openVault } from "../../vault";
import { sync, type SyncResult } from "../../adoption";
import type { Result, ToolError } from "../../types";

/**
 * `dome sync` — run the adoption state machine: compile `adopted..HEAD`,
 * advance `refs/dome/adopted/<branch>` atomically on clean completion.
 * See docs/wiki/specs/adoption.md §"`dome sync`".
 *
 * `--force-advance` accepts a non-fast-forward HEAD (the divergence-recovery
 * path per docs/wiki/gotchas/adopted-ref-divergence.md).
 */
export async function domeSync(
  vaultPath: string,
  opts?: { forceAdvance?: boolean },
): Promise<Result<SyncResult, ToolError>> {
  const openRes = await openVault(vaultPath);
  if (!openRes.ok) return openRes;
  const vault = openRes.value;
  try {
    return await sync(vault, opts);
  } finally {
    // `sync` already drains hooks before advancing; closing the vault is a
    // best-effort cleanup so file handles don't outlive the CLI invocation.
    await vault.close();
  }
}
