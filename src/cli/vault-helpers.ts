// cli/vault-helpers: the CLI-side open-use-close ceremony over the shared
// surface adapter. Error MAPPING stays with each command — exit codes and
// message bytes are per-command contracts (sync's open-failure is exit 1 by
// design, not EX_USAGE; see docs/wiki/specs/cli.md).
import { withVault } from "../surface/adapter";
import type { OpenVaultError, Vault } from "../vault";

/**
 * Open the vault, run `fn`, always close — the per-request lifecycle every
 * CLI command shares. Open failures are passed to `onOpenFailed` verbatim
 * (each command owns its own exit-code + message contract). The `run`
 * callback receives an open vault handle; it runs inside the existing
 * try/finally, so callers must not call `vault.close()` themselves.
 */
export async function withVaultCli(opts: {
  readonly path: string;
  readonly bundlesRoot?: string | undefined;
  readonly onOpenFailed: (error: OpenVaultError) => number;
  readonly run: (vault: Vault) => Promise<number>;
}): Promise<number> {
  const outcome = await withVault(
    { path: opts.path, bundlesRoot: opts.bundlesRoot },
    opts.run,
  );
  if (outcome.kind === "open-failed") {
    return opts.onOpenFailed(outcome.error);
  }
  return outcome.value;
}
