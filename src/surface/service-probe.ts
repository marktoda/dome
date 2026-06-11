// surface/service-probe: launchd service identity + read-only state probe.
//
// The per-vault service slug/label and the read-only `probeServiceState`
// are shared substance: `dome install --status`, the `dome status` service
// line, and the MCP `status` tool all report the same service state. The
// write-side service lifecycle (`dome install` / `uninstall` / `restart`,
// plist rendering) stays in src/cli/commands/install.ts; it imports the
// identity helpers and deps boundary from here.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const SERVICE_LABEL_PREFIX = "com.dome.serve.";

/** Same SDK-entry resolution as `dome serve --daemon` (see serve.ts). */
const DOME_BIN = resolve(import.meta.dir, "../../bin/dome");

export type LaunchctlResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * Runs `launchctl <args>` and reports the outcome. The default is a real
 * `Bun.spawn`; tests inject a recording fake so no real service manager is
 * ever touched from the suite.
 */
export type LaunchctlRunner = (
  args: ReadonlyArray<string>,
) => Promise<LaunchctlResult>;

/**
 * Injectable host boundaries for the service verbs and probes. Every field
 * defaults to the real environment; tests override `platform`, `uid`,
 * `launchAgentsDir`, and `launchctl` to stay hermetic.
 */
export type ServiceDeps = {
  readonly platform?: NodeJS.Platform | undefined;
  readonly uid?: number | undefined;
  readonly launchAgentsDir?: string | undefined;
  readonly launchctl?: LaunchctlRunner | undefined;
  /** systemd --user runner (Linux); same result shape as launchctl. */
  readonly systemctl?: LaunchctlRunner | undefined;
  /** systemd user-unit directory (default ~/.config/systemd/user). */
  readonly systemdUserDir?: string | undefined;
  readonly bunPath?: string | undefined;
  readonly domeBin?: string | undefined;
  /** Bounded wait for a booted-out service to leave launchd (test knob). */
  readonly drainTimeoutMs?: number | undefined;
};

export type ResolvedServiceDeps = {
  readonly platform: NodeJS.Platform;
  readonly uid: number | null;
  readonly launchAgentsDir: string;
  readonly launchctl: LaunchctlRunner;
  readonly systemctl: LaunchctlRunner;
  readonly systemdUserDir: string;
  readonly bunPath: string;
  readonly domeBin: string;
  readonly drainTimeoutMs: number;
};

export function resolveServiceDeps(deps: ServiceDeps): ResolvedServiceDeps {
  return {
    platform: deps.platform ?? process.platform,
    uid: deps.uid ??
      (typeof process.getuid === "function" ? process.getuid() : null),
    launchAgentsDir: deps.launchAgentsDir ??
      join(homedir(), "Library", "LaunchAgents"),
    launchctl: deps.launchctl ?? spawnLaunchctl,
    systemctl: deps.systemctl ?? spawnSystemctl,
    systemdUserDir: deps.systemdUserDir ??
      join(
        process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"),
        "systemd",
        "user",
      ),
    bunPath: deps.bunPath ?? process.execPath,
    domeBin: deps.domeBin ?? DOME_BIN,
    drainTimeoutMs: deps.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
  };
}

/**
 * How long the service verbs wait after `bootout` for the label to leave
 * launchd before bootstrapping. A serve mid-agent-run drains for seconds.
 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;

/** Real launchctl boundary: `Bun.spawn` with captured stdout/stderr. */
async function spawnLaunchctl(
  args: ReadonlyArray<string>,
): Promise<LaunchctlResult> {
  const proc = Bun.spawn(["launchctl", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Real systemctl boundary: `systemctl --user <args>` via Bun.spawn. */
async function spawnSystemctl(
  args: ReadonlyArray<string>,
): Promise<LaunchctlResult> {
  const proc = Bun.spawn(["systemctl", "--user", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

// ----- Label / plist derivation (pure, exported for tests) ------------------

/**
 * Deterministic per-vault service slug: lowercased basename with
 * non-`[a-z0-9-]` runs collapsed to `-`, plus the first 8 hex chars of the
 * SHA-256 of the resolved vault path. Same path → same slug; distinct
 * vaults (even with the same basename) never collide.
 */
export function vaultServiceSlug(vaultPath: string): string {
  const resolved = resolve(vaultPath);
  const base = basename(resolved)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return `${base.length > 0 ? base : "vault"}-${hash}`;
}

/** launchd label for a vault's ambient `dome serve` service. */
export function serviceLabelForVault(vaultPath: string): string {
  return `${SERVICE_LABEL_PREFIX}${vaultServiceSlug(vaultPath)}`;
}

/** systemd user-unit name for a vault's ambient `dome serve` service. */
export function serviceUnitNameForVault(vaultPath: string): string {
  return `dome-serve-${vaultServiceSlug(vaultPath)}.service`;
}

// ----- probeServiceState ----------------------------------------------------

/**
 * Read-only launchd service state for a vault, shared by `dome install
 * --status` and the `dome status` service line. `loaded` is probed via
 * `launchctl print` only when the plist is installed — `dome status` is the
 * cheap session pulse and must not spawn `launchctl` on every invocation of
 * a vault that never installed the service. (The deleted-plist-but-loaded
 * edge therefore reads as `not-installed` here; `dome uninstall` still
 * boots that edge out.)
 */
export type ServiceState =
  | { readonly supported: false }
  | {
      readonly supported: true;
      readonly label: string;
      readonly plist: string;
      readonly installed: boolean;
      /** Null when the loaded probe was skipped (not installed / no uid). */
      readonly loaded: boolean | null;
    };

export async function probeServiceState(
  vaultPath: string,
  deps: ServiceDeps = {},
): Promise<ServiceState> {
  const d = resolveServiceDeps(deps);

  if (d.platform === "linux") {
    // The `plist` field carries the unit path on linux — the field name is
    // the established ServiceState shape consumed by `dome status` and the
    // MCP status tool; renaming it would ripple through every consumer.
    const label = serviceUnitNameForVault(resolve(vaultPath));
    const unitPath = join(d.systemdUserDir, label);
    const installed = existsSync(unitPath);
    let loaded: boolean | null = null;
    if (installed) {
      const probe = await d.systemctl(["is-active", label]);
      loaded = probe.exitCode === 0;
    }
    return Object.freeze({
      supported: true,
      label,
      plist: unitPath,
      installed,
      loaded,
    });
  }

  if (d.platform !== "darwin") return Object.freeze({ supported: false });

  const label = serviceLabelForVault(resolve(vaultPath));
  const plist = join(d.launchAgentsDir, `${label}.plist`);
  const installed = existsSync(plist);
  let loaded: boolean | null = null;
  if (installed && d.uid !== null) {
    const print = await d.launchctl(["print", `gui/${d.uid}/${label}`]);
    loaded = print.exitCode === 0;
  }
  return Object.freeze({ supported: true, label, plist, installed, loaded });
}
