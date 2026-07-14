// cli/commands/home-upgrade: presentation Adapter over the single upgrade intent.

import {
  manageHomeUpgrade,
  type HomeUpgradeIntentDeps,
  type HomeUpgradeResult,
} from "../../product-host/home-upgrade";
import { formatJson } from "../../surface/format";
import { resolveVaultPath } from "../../surface/resolve-vault";

export type RunHomeUpgradeOptions = {
  readonly vault?: string;
  readonly json?: boolean;
};

export type HomeUpgradeCommandDeps = HomeUpgradeIntentDeps & {
  /** Test-only invocation seam; production always calls manageHomeUpgrade. */
  readonly invokeUpgrade?: typeof manageHomeUpgrade | undefined;
};

export async function runHomeUpgrade(
  options: RunHomeUpgradeOptions = {},
  deps: HomeUpgradeCommandDeps = {},
): Promise<number> {
  const result = await (deps.invokeUpgrade ?? manageHomeUpgrade)({
    action: "run",
    vaultPath: resolveVaultPath(options.vault),
  }, deps);
  present(result, options.json === true);
  return result.exitCode;
}

function present(result: HomeUpgradeResult, json: boolean): void {
  if (json) {
    console.log(formatJson(result));
    return;
  }
  const requested = artifact(result.requestedArtifact);
  const selected = artifact(result.selectedArtifact);
  const transaction = result.transaction === null
    ? "none"
    : `${result.transaction.outcome} (operation ${result.transaction.operationId})`;
  const detail = [
    `Dome Home upgrade: ${result.status}`,
    `  requested: ${requested}`,
    `  selected: ${selected}`,
    `  transaction: ${transaction}`,
    `  service: ${result.service}`,
    `  next: ${result.nextAction}`,
    `  ${result.message}`,
  ].join("\n");
  if (result.exitCode === 0) console.log(detail);
  else console.error(detail);
}

function artifact(value: HomeUpgradeResult["requestedArtifact"]): string {
  return value === null ? "none" : `${value.productVersion} (${value.artifactId})`;
}
