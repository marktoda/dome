// `dome init` is a deliberately narrow compatibility alias. It may construct
// a new/empty vault through the revision-bound setup Module, or confirm that
// an already-complete Dome vault needs no work. Existing owner vaults and
// migrations require the public preview/retained-plan/apply consent grammar.

import { resolve } from "node:path";

import { discoverInitProduct } from "../../setup/init-product";
import {
  renderSetupApplyResultHuman,
  renderSetupApplyResultJson,
} from "../../setup/render";
import { adaptVault } from "../../setup/vault-adaptation";

export type RunInitOptions = {
  readonly path?: string | undefined;
  readonly json?: boolean | undefined;
};

/** Compatibility entrypoint; all vault mutation remains in adaptVault. */
export async function runInit(options: RunInitOptions = {}): Promise<number> {
  const vaultPath = resolve(options.path ?? ".");
  try {
    const adaptation = await adaptVault({
      mode: "compatibility-init",
      targetPath: vaultPath,
    }, { discoverProduct: discoverInitProduct });
    if (adaptation.mode !== "compatibility-init") {
      throw new Error("init received an invalid vault-adaptation result");
    }
    console.log(options.json === true
      ? renderSetupApplyResultJson(adaptation.result)
      : renderSetupApplyResultHuman(adaptation.result));
    return adaptation.result.status === "completed" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json === true) console.log(JSON.stringify({ status: "error", error: "runtime", message }, null, 2));
    else console.error(`dome init: failed: ${message}`);
    return 1;
  }
}
