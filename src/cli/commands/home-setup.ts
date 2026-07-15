// cli/commands/home-setup: presentation Adapter over model-only Home setup.

import { manageHomeSetup, type HomeSetupAction, type HomeSetupDeps } from "../../product-host/home-setup";
import {
  cleanupHomeCredentialResidue,
  HOME_CREDENTIAL_CLEANUP_AUTHORIZATION,
  type HomeCredentialResidueCleanupDeps,
} from "../../product-host/home-credential-residue";
import { formatJson } from "../../surface/format";
import { resolveVaultPath } from "../../surface/resolve-vault";

export type RunHomeSetupOptions = Readonly<{ vault?: string; json?: boolean; apply?: boolean }>;

export async function runHomeSetup(
  action: HomeSetupAction,
  options: RunHomeSetupOptions = {},
  deps: HomeSetupDeps = {},
): Promise<number> {
  const result = await manageHomeSetup({ action, vaultPath: resolveVaultPath(options.vault) }, deps);
  if (options.json === true) console.log(formatJson(result));
  else {
    const write = result.exitCode === 0 ? console.log : console.error;
    write(`dome home setup ${action}: ${result.status}\n` +
      `  model configuration: ${result.model.configuration}\n` +
      `  model credential: ${result.model.credential}\n` +
      `  model runtime: ${result.model.runtime}\n` +
      `  credential residue: ${result.residue.state}\n` +
      `  next: ${formatNext(result.nextAction)}`);
  }
  return result.exitCode;
}

export async function runHomeSetupCleanup(
  options: RunHomeSetupOptions = {},
  deps: HomeCredentialResidueCleanupDeps & Readonly<{
    cleanup?: typeof cleanupHomeCredentialResidue;
  }> = {},
): Promise<number> {
  const result = await (deps.cleanup ?? cleanupHomeCredentialResidue)({
    vaultPath: resolveVaultPath(options.vault),
    ...(options.apply === true ? { authorization: HOME_CREDENTIAL_CLEANUP_AUTHORIZATION } : {}),
  }, deps);
  if (options.json === true) console.log(formatJson(result));
  else {
    const write = result.exitCode === 0 ? console.log : console.error;
    write(`dome home setup cleanup: ${result.status}\n` +
      `  plaintext cleanup: ${result.cleanup}\n` +
      `  Home resume: ${result.home}\n` +
      `  ${result.message}\n` +
      `  next: ${cleanupNext(result.nextAction)}`);
  }
  return result.exitCode;
}

function cleanupNext(action: Awaited<ReturnType<typeof cleanupHomeCredentialResidue>>["nextAction"]): string {
  if (action === "none") return "none";
  if (action === "rerun-with-apply") return "dome home setup cleanup --apply";
  if (action === "configure-model") return "dome home setup configure";
  if (action === "recover-upgrade") return "dome home upgrade";
  if (action === "retry-cleanup") return "dome home setup cleanup --apply";
  return "dome home setup status";
}

function formatNext(action: Awaited<ReturnType<typeof manageHomeSetup>>["nextAction"]): string {
  if (action === "none") return "none";
  if (action === "configure-model") return "dome home setup configure";
  if (action === "initialize-model-provider") return "dome init --with-model-provider anthropic";
  if (action === "configure-model-provider") return "configure model_provider in .dome/config.yaml";
  if (action === "unlock-keychain") return "unlock the login Keychain and retry";
  return "inspect legacy credential residue before migration";
}
