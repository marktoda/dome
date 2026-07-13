// product-host/home-lifecycle: one deep lifecycle Module for the supervised
// macOS Dome Home product. It owns lifecycle state/results; launchd is an
// Adapter and the CLI is presentation only.

import { existsSync } from "node:fs";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { findGitRoot } from "../git";
import { readServeHeartbeatStatus } from "../engine/host/compiler-host-heartbeat";
import {
  activateLaunchAgent,
  publishLaunchAgentPlist,
  renderLaunchAgentPlist,
  waitForLaunchAgentDrain,
} from "../platform/launchd";
import {
  resolveServiceDeps,
  serviceLabelForVault,
  vaultServiceSlug,
  type ServiceDeps,
} from "../surface/service-probe";

export const HOME_LIFECYCLE_SCHEMA = "dome.home.lifecycle/v1" as const;
const HOME_HOST = "127.0.0.1";
const HOME_PORT = 3663;
const PINNED_BUN_VERSION = "1.2.13";

export type HomeLifecycleAction = "install" | "start" | "restart" | "status" | "uninstall";
export type HomeLifecycleStatus =
  | "installed"
  | "started"
  | "restarted"
  | "ready"
  | "loaded-unreachable"
  | "broken-program"
  | "installed-stopped"
  | "not-installed"
  | "loaded-without-plist"
  | "uninstalled"
  | "error";

export type HomeLifecycleResult = {
  readonly schema: typeof HOME_LIFECYCLE_SCHEMA;
  readonly action: HomeLifecycleAction;
  readonly status: HomeLifecycleStatus;
  readonly vault: string;
  readonly label: string;
  readonly plist: string;
  readonly log: string;
  readonly program: string;
  readonly exitCode: 0 | 1 | 64;
  readonly installed: boolean;
  readonly loaded: boolean | null;
  readonly ready: boolean | null;
  readonly replaced?: boolean;
  readonly legacyServeConflict?: boolean;
  readonly error?: string;
};

export type HomeLifecycleDeps = ServiceDeps & {
  readonly artifactRoot?: string;
  readonly runtimePath?: string;
  readonly programPath?: string;
  readonly pwaDir?: string;
  readonly readiness?: (() => Promise<boolean>) | undefined;
  readonly readinessTimeoutMs?: number;
  readonly legacyServeRunning?: (() => Promise<boolean>) | undefined;
  readonly publishPlist?: ((path: string, contents: string) => Promise<void>) | undefined;
  readonly unlinkPlist?: ((path: string) => Promise<void>) | undefined;
};

export function homeServiceLabelForVault(vaultPath: string): string {
  return `com.dome.home.${vaultServiceSlug(vaultPath)}`;
}

export async function manageHome(input: {
  readonly action: HomeLifecycleAction;
  readonly vaultPath: string;
  readonly environment?: ReadonlyMap<string, string>;
}, deps: HomeLifecycleDeps = {}): Promise<HomeLifecycleResult> {
  try {
    return await manageHomeInner(input, deps);
  } catch (error) {
    const vault = resolve(input.vaultPath);
    const d = resolveServiceDeps(deps);
    const label = homeServiceLabelForVault(vault);
    const plist = join(d.launchAgentsDir, `${label}.plist`);
    return result({
      schema: HOME_LIFECYCLE_SCHEMA,
      action: input.action,
      vault,
      label,
      plist,
      log: join(vault, ".dome", "state", "home.log"),
      program: homeProgramPaths(deps).programPath,
    }, "error", existsSync(plist), d.platform === "darwin" && d.uid !== null
      ? await probeLoaded(d, d.uid, label)
      : null, null, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function manageHomeInner(input: {
  readonly action: HomeLifecycleAction;
  readonly vaultPath: string;
  readonly environment?: ReadonlyMap<string, string>;
}, deps: HomeLifecycleDeps = {}): Promise<HomeLifecycleResult> {
  const vault = resolve(input.vaultPath);
  const d = resolveServiceDeps(deps);
  const label = homeServiceLabelForVault(vault);
  const plist = join(d.launchAgentsDir, `${label}.plist`);
  const log = join(vault, ".dome", "state", "home.log");
  const paths = homeProgramPaths(deps);
  const base = { schema: HOME_LIFECYCLE_SCHEMA, action: input.action, vault, label, plist, log, program: paths.programPath } as const;

  if (d.platform !== "darwin" || d.uid === null) {
    return result(base, "error", false, false, null, {
      error: d.platform !== "darwin"
        ? "Dome Home lifecycle is supported on macOS launchd only"
        : "cannot determine the current uid for the launchd gui domain",
    });
  }
  const uid = d.uid;
  const target = `gui/${uid}/${label}`;
  const installed = existsSync(plist);

  if (input.action === "uninstall") {
    const loaded = (await d.launchctl(["print", target])).exitCode === 0;
    await d.launchctl(["bootout", target]);
    const drained = await waitForLaunchAgentDrain({ launchctl: d.launchctl, uid, label, timeoutMs: d.drainTimeoutMs });
    if (!drained) return result(base, "error", installed, true, null, { error: "Dome Home did not stop before the launchd drain timeout; plist preserved for retry" });
    if (installed) await (deps.unlinkPlist ?? unlink)(plist);
    return result(base, installed || loaded ? "uninstalled" : "not-installed", false, false, null);
  }

  if (input.action === "install") {
    const preflight = await homePreflight(vault, deps);
    if (preflight !== null) return result(base, "error", installed, false, null, {
      error: preflight.message,
      exitCode: preflight.exitCode,
    });
    const loaded = (await d.launchctl(["print", target])).exitCode === 0;
    const readyNow = await probeHomeReadiness(deps);
    if (await hasLegacyServeConflict(vault, d, uid, deps.legacyServeRunning)) {
      return legacyConflict(base, installed, loaded);
    }
    if (!loaded && readyNow) return foregroundConflict(base, installed);
    await mkdir(join(vault, ".dome", "state"), { recursive: true });
    await mkdir(d.launchAgentsDir, { recursive: true });
    await d.launchctl(["bootout", target]);
    const drained = await waitForLaunchAgentDrain({ launchctl: d.launchctl, uid, label, timeoutMs: d.drainTimeoutMs });
    if (!drained) return result(base, "error", installed, true, null, { error: "Dome Home did not stop before the launchd drain timeout" });
    const environment = new Map<string, string>(input.environment ?? []);
    environment.set("PATH", homeServicePath(paths.runtimePath));
    await (deps.publishPlist ?? publishLaunchAgentPlist)(plist, renderLaunchAgentPlist({
      label,
      programArguments: homeProgramArguments(vault, paths),
      workingDirectory: vault,
      logPath: log,
      environment,
    }));
    const activation = await activateLaunchAgent({ launchctl: d.launchctl, uid, label, plistPath: plist });
    if (activation !== null) {
      return result(base, "error", existsSync(plist), await probeLoaded(d, uid, label), false, {
        error: activation,
        replaced: installed,
      });
    }
    const ready = await waitForHomeReadiness(deps);
    if (!ready) {
      return result(base, "error", existsSync(plist), await probeLoaded(d, uid, label), false, {
        error: `Dome Home did not become ready at http://${HOME_HOST}:${HOME_PORT}/pair/status`,
        replaced: installed,
      });
    }
    return result(base, "installed", true, true, true, { replaced: installed });
  }

  const loaded = (await d.launchctl(["print", target])).exitCode === 0;
  if (input.action === "status") {
    if (!installed && !loaded) {
      return result(base, "not-installed", false, false, null, {
        legacyServeConflict: await hasLegacyServeConflict(vault, d, uid, deps.legacyServeRunning),
      });
    }
    if (installed) {
      const preflight = await homePreflight(vault, deps);
      if (preflight !== null) return result(base, "broken-program", true, loaded, null, { error: preflight.message });
    }
    const ready = loaded ? await probeHomeReadiness(deps) : null;
    return result(
      base,
      !installed ? "loaded-without-plist" : loaded ? ready ? "ready" : "loaded-unreachable" : "installed-stopped",
      installed,
      loaded,
      ready,
      { legacyServeConflict: await hasLegacyServeConflict(vault, d, uid, deps.legacyServeRunning) },
    );
  }

  if (!installed) {
    return result(base, "error", false, loaded, null, {
      error: `not installed (no plist at ${plist}); run \`dome home install\` first`,
      exitCode: 64,
    });
  }
  const preflight = await homePreflight(vault, deps);
  if (preflight !== null) return result(base, "error", true, loaded, null, { error: preflight.message });
  if (await hasLegacyServeConflict(vault, d, uid, deps.legacyServeRunning)) {
    return legacyConflict(base, true, loaded);
  }
  const readyNow = await probeHomeReadiness(deps);
  if (!loaded && readyNow) return foregroundConflict(base, true);

  if (input.action === "restart") {
    await d.launchctl(["bootout", target]);
    const drained = await waitForLaunchAgentDrain({ launchctl: d.launchctl, uid, label, timeoutMs: d.drainTimeoutMs });
    if (!drained) return result(base, "error", true, true, null, { error: "Dome Home did not stop before the launchd drain timeout" });
  } else if (loaded) {
    const ready = await waitForHomeReadiness(deps);
    return ready
      ? result(base, "started", true, true, true)
      : result(base, "error", true, true, false, { error: "Dome Home is loaded but not ready" });
  }
  const activation = await activateLaunchAgent({ launchctl: d.launchctl, uid, label, plistPath: plist });
  if (activation !== null) {
    return result(base, "error", true, await probeLoaded(d, uid, label), false, { error: activation });
  }
  const ready = await waitForHomeReadiness(deps);
  if (!ready) return result(base, "error", true, await probeLoaded(d, uid, label), false, { error: "Dome Home did not become ready" });
  return result(base, input.action === "restart" ? "restarted" : "started", true, true, true);
}

function legacyConflict(
  base: Pick<HomeLifecycleResult, "schema" | "action" | "vault" | "label" | "plist" | "log" | "program">,
  installed: boolean,
  loaded: boolean | null,
): HomeLifecycleResult {
  return result(base, "error", installed, loaded, null, {
    legacyServeConflict: true,
    error: "legacy dome serve service is installed, loaded, or running; run `dome uninstall --vault <vault>` before `dome home install`",
  });
}

function foregroundConflict(
  base: Pick<HomeLifecycleResult, "schema" | "action" | "vault" | "label" | "plist" | "log" | "program">,
  installed: boolean,
): HomeLifecycleResult {
  return result(base, "error", installed, false, true, {
    error: "Dome Home is already ready on 127.0.0.1:3663 but its LaunchAgent is not loaded; stop the foreground host before continuing",
  });
}

function result(
  base: Pick<HomeLifecycleResult, "schema" | "action" | "vault" | "label" | "plist" | "log" | "program">,
  status: HomeLifecycleStatus,
  installed: boolean,
  loaded: boolean | null,
  ready: boolean | null,
  extra: Partial<Pick<HomeLifecycleResult, "replaced" | "legacyServeConflict" | "error" | "exitCode">> = {},
): HomeLifecycleResult {
  return Object.freeze({
    ...base,
    status,
    installed,
    loaded,
    ready,
    exitCode: extra.exitCode ?? (status === "error" || status === "broken-program" || status === "loaded-unreachable" ? 1 : 0),
    ...extra,
  });
}

async function hasLegacyServeConflict(
  vault: string,
  d: ReturnType<typeof resolveServiceDeps>,
  uid: number,
  injected?: (() => Promise<boolean>) | undefined,
): Promise<boolean> {
  const legacyLabel = serviceLabelForVault(vault);
  const legacyPlist = join(d.launchAgentsDir, `${legacyLabel}.plist`);
  if (existsSync(legacyPlist)) return true;
  const heartbeatRunning = injected === undefined
    ? (await readServeHeartbeatStatus({ vaultPath: vault })).status === "running"
    : await injected();
  if (heartbeatRunning) return true;
  return (await d.launchctl(["print", `gui/${uid}/${legacyLabel}`])).exitCode === 0;
}

async function probeLoaded(
  d: ReturnType<typeof resolveServiceDeps>,
  uid: number,
  label: string,
): Promise<boolean | null> {
  try {
    return (await d.launchctl(["print", `gui/${uid}/${label}`])).exitCode === 0;
  } catch {
    return null;
  }
}

type HomeProgramPaths = { readonly artifactRoot: string; readonly runtimePath: string; readonly programPath: string; readonly pwaDir: string };

function homeProgramPaths(deps: HomeLifecycleDeps): HomeProgramPaths {
  const artifactRoot = resolve(deps.artifactRoot ?? resolve(import.meta.dir, "../../.."));
  return {
    artifactRoot,
    runtimePath: resolve(deps.runtimePath ?? join(artifactRoot, "runtime", "bun")),
    programPath: resolve(deps.programPath ?? join(artifactRoot, "app", "bin", "dome")),
    pwaDir: resolve(deps.pwaDir ?? join(artifactRoot, "app", "pwa", "dist")),
  };
}

function homeProgramArguments(vault: string, paths: HomeProgramPaths): string[] {
  return [
    paths.runtimePath,
    paths.programPath,
    "home",
    "--vault",
    vault,
    "--host",
    HOME_HOST,
    "--port",
    String(HOME_PORT),
    "--static-dir",
    paths.pwaDir,
  ];
}

type HomePreflightFailure = { readonly message: string; readonly exitCode: 1 | 64 };

async function homePreflight(vault: string, deps: HomeLifecycleDeps): Promise<HomePreflightFailure | null> {
  const gitRoot = await findGitRoot(vault);
  if (gitRoot === null || !existsSync(join(vault, ".dome", "config.yaml"))) {
    return { message: "not an initialized Dome vault; run `dome init` first", exitCode: 64 };
  }
  const paths = homeProgramPaths(deps);
  for (const [label, path] of [["pinned runtime", paths.runtimePath], ["Dome program", paths.programPath]] as const) {
    if (!existsSync(path)) return { message: `${label} is missing at ${path}`, exitCode: 1 };
    if (((await stat(path)).mode & 0o111) === 0) return { message: `${label} is not executable at ${path}`, exitCode: 1 };
  }
  if (!existsSync(join(paths.pwaDir, "index.html"))) return { message: `built PWA is missing at ${paths.pwaDir}`, exitCode: 1 };

  const explicitSourcePaths = deps.runtimePath !== undefined && deps.programPath !== undefined && deps.pwaDir !== undefined;
  if (!explicitSourcePaths) {
    const manifestPath = join(paths.artifactRoot, "manifest.json");
    if (!existsSync(manifestPath)) return { message: `Dome Home artifact manifest is missing at ${manifestPath}`, exitCode: 1 };
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      const runtime = manifest["runtime"] as Record<string, unknown> | undefined;
      if (
        manifest["schema"] !== "dome.home-artifact/v1" ||
        (manifest["product"] as Record<string, unknown> | undefined)?.["name"] !== "Dome Home" ||
        runtime?.["name"] !== "bun" || runtime["version"] !== PINNED_BUN_VERSION ||
        manifest["pwa"] !== "app/pwa/dist"
      ) return { message: "Dome Home artifact manifest does not describe the pinned product layout", exitCode: 1 };
    } catch {
      return { message: `Dome Home artifact manifest is invalid at ${manifestPath}`, exitCode: 1 };
    }
  }
  return null;
}

function homeServicePath(runtimePath: string): string {
  return [
    dirname(runtimePath),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter((value, index, all) => all.indexOf(value) === index).join(":");
}

async function waitForHomeReadiness(deps: HomeLifecycleDeps): Promise<boolean> {
  const deadline = Date.now() + (deps.readinessTimeoutMs ?? 10_000);
  do {
    if (await probeHomeReadiness(deps)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  return false;
}

async function probeHomeReadiness(deps: HomeLifecycleDeps): Promise<boolean> {
  if (deps.readiness !== undefined) return deps.readiness();
  try {
    const response = await fetch(`http://${HOME_HOST}:${HOME_PORT}/pair/status`);
    return await isHomePairingReadiness(response);
  } catch {
    return false;
  }
}

export async function isHomePairingReadiness(response: Response): Promise<boolean> {
  if (response.status !== 200) return false;
  try {
    const payload = await response.json() as {
      readonly schema?: unknown;
      readonly available?: unknown;
      readonly paired?: unknown;
    };
    return payload.schema === "dome.device.pairing/v1" &&
      payload.available === true && typeof payload.paired === "boolean";
  } catch {
    return false;
  }
}
