// cli/commands/home-lifecycle: presentation Adapter over manageHome.

import { formatJson } from "../../surface/format";
import { resolveVaultPath } from "../../surface/resolve-vault";
import {
  manageHome,
  type HomeLifecycleAction,
  type HomeLifecycleDeps,
} from "../../product-host/home-lifecycle";
import { resolveServiceEnvironment } from "./install";

export type RunHomeLifecycleOptions = {
  readonly vault?: string;
  readonly env?: ReadonlyArray<string>;
  readonly envFile?: string;
  readonly json?: boolean;
};

export async function runHomeLifecycle(
  action: HomeLifecycleAction,
  options: RunHomeLifecycleOptions = {},
  deps: HomeLifecycleDeps = {},
): Promise<number> {
  let environment: ReadonlyMap<string, string> | undefined;
  if (action === "install") {
    try {
      environment = await resolveHomeLifecycleEnvironment(action, options);
    } catch (error) {
      console.error(`dome home install: ${error instanceof Error ? error.message : String(error)}`);
      return 64;
    }
  }
  const result = await manageHome({
    action,
    vaultPath: resolveVaultPath(options.vault),
    ...(environment === undefined ? {} : { environment }),
  }, deps);
  if (options.json === true) console.log(formatJson(result));
  else if (result.error !== undefined) {
    console.error(`dome home ${action}: ${result.error}`);
    if (result.lifecycle !== undefined) console.error(`  lifecycle: ${formatLifecycle(result.lifecycle)}`);
  }
  else {
    console.log(
      `dome home ${action}: ${result.status}\n` +
      `  service: ${result.label}\n  plist: ${result.plist}\n  log: ${result.log}\n` +
      `  installation: ${result.installation}\n` +
      `  artifact: ${result.artifactId ?? "none"}${result.productVersion === null ? "" : ` (${result.productVersion})`}\n` +
      `  release: ${result.release ?? "none"}\n  program: ${result.program || "none"}\n  installed: ${result.installed === null ? "unknown" : result.installed ? "yes" : "no"}\n` +
      `  loaded: ${result.loaded === null ? "unknown" : result.loaded ? "yes" : "no"}\n` +
      `  ready: ${result.ready === null ? "n/a" : result.ready ? "yes" : "no"}` +
      (result.lifecycle === undefined ? "" : `\n  lifecycle: ${formatLifecycle(result.lifecycle)}`),
    );
  }
  return result.exitCode;
}

function formatLifecycle(lifecycle: NonNullable<Awaited<ReturnType<typeof manageHome>>["lifecycle"]>): string {
  if (lifecycle.state === "inactive") return "inactive";
  if (lifecycle.state === "active") {
    return `${lifecycle.phase} (${lifecycle.purpose}, operation ${lifecycle.operationId}, last error: ${lifecycle.lastError ?? "none"})`;
  }
  return `${lifecycle.state} (${lifecycle.error})`;
}

/** Undefined means preserve the selected installation record's environment. */
export async function resolveHomeLifecycleEnvironment(
  action: HomeLifecycleAction,
  options: RunHomeLifecycleOptions,
): Promise<ReadonlyMap<string, string> | undefined> {
  if (action !== "install" || (options.env === undefined && options.envFile === undefined)) return undefined;
  return resolveServiceEnvironment(options);
}
