// cli/commands/install-systemd: the Linux (systemd --user) backend for
// `dome install` / `dome uninstall` / `dome restart`.
//
// Mirrors the launchd backend in install.ts behind the same ServiceDeps
// boundary: a deterministic per-vault unit name, idempotent install
// (write unit → daemon-reload → enable → restart), uninstall that is a
// clean no-op when nothing is installed, restart-from-existing-unit.
// The unit runs in the user manager (`systemctl --user`); surviving
// logout/boot additionally needs `loginctl enable-linger <user>` — an ops
// step documented in the migration runbook, deliberately not automated
// (it requires root on some distros).

import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { formatJson } from "../../surface/format";
import { resolveVaultPath } from "../../surface/resolve-vault";
import {
  serviceUnitNameForVault,
  type ResolvedServiceDeps,
} from "../../surface/service-probe";
import { EX_USAGE } from "../exit-codes";
import {
  resolveServiceEnvironment,
  servicePath,
  vaultPreconditionError,
  type RunInstallOptions,
  type RunRestartOptions,
  type RunUninstallOptions,
} from "./install";

// ----- Unit rendering (pure, exported for tests) -----------------------------

/**
 * Render the systemd user unit for `dome serve`. Restart=always mirrors
 * launchd KeepAlive; append: log redirection mirrors the plist's
 * StandardOutPath/StandardErrorPath; Environment carries PATH (user
 * managers get a minimal PATH that cannot resolve ~/.bun) plus
 * caller-supplied entries.
 *
 * After=network.target is advisory start-ordering only (user managers get a
 * best-effort network.target); serve tolerates starting before the network
 * is up, and Restart=always covers transient startup failures.
 */
export function renderServeSystemdUnit(input: {
  readonly bunPath: string;
  readonly domeBin: string;
  readonly vaultPath: string;
  readonly logPath: string;
  readonly environment?: ReadonlyMap<string, string>;
}): string {
  // Quoting convention: path-bearing args quoted (systemd's quoted-word
  // syntax), plain verbs/flags (`serve`, `--vault`) bare.
  const quote = (arg: string): string => `"${execEscape(arg)}"`;
  const exec = `${quote(input.bunPath)} ${quote(input.domeBin)} serve --vault ${
    quote(input.vaultPath)
  }`;
  const environment = new Map<string, string>([
    ["PATH", servicePath(input.bunPath)],
    ...(input.environment ?? []),
  ]);
  const envLines = [...environment]
    .map(([key, value]) => `Environment="${key}=${envEscape(value)}"`)
    .join("\n");
  return `[Unit]
Description=Dome compiler host (dome serve) for ${specifierEscape(input.vaultPath)}
After=network.target

[Service]
ExecStart=${exec}
WorkingDirectory=${specifierEscape(input.vaultPath)}
${envLines}
Restart=always
RestartSec=2
StandardOutput=append:${specifierEscape(input.logPath)}
StandardError=append:${specifierEscape(input.logPath)}

[Install]
WantedBy=default.target
`;
}

/** Escape a value for inside Environment="KEY=...": %, ", \. */
function envEscape(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%");
}

/**
 * Double `%` for settings lines that take a bare value (Description=,
 * WorkingDirectory=, append: paths): systemd expands `%` specifiers in
 * these, so a literal `%` in a path must be written `%%`.
 */
function specifierEscape(value: string): string {
  return value.replaceAll("%", "%%");
}

/**
 * Escape an ExecStart quoted argument: \ and " for the quoted-word syntax,
 * `%` specifiers doubled, `$` doubled so systemd does not attempt variable
 * expansion.
 */
function execEscape(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => "$$");
}

// ----- Service flows (dispatched from install.ts on linux) -------------------
//
// Plain console lines here (vs. the launchd presenter cards) are deliberate
// scope control for v1; this keeps the file free of presenter imports.

export async function runInstallSystemd(
  options: RunInstallOptions,
  d: ResolvedServiceDeps,
): Promise<number> {
  const vaultPath = resolveVaultPath(options.vault);
  const json = options.json === true;
  const unit = serviceUnitNameForVault(vaultPath);
  const unitPath = join(d.systemdUserDir, unit);

  if (options.status === true) {
    const installed = existsSync(unitPath);
    const active = installed
      ? (await d.systemctl(["is-active", unit])).exitCode === 0
      : null;
    // JSON payloads carry the unit path under both `unit` (the natural
    // systemd name) and `plist` (the field name ServiceState consumers
    // already read; see probeServiceState).
    console.log(
      json
        ? formatJson({
            schema: "dome.install/v1",
            status: "status",
            vault: vaultPath,
            label: unit,
            unit: unitPath,
            plist: unitPath,
            installed,
            loaded: active,
          })
        : `dome install: ${unit} — installed: ${installed ? "yes" : "no"}, active: ${
            active === null ? "n/a" : active ? "yes" : "no"
          }`,
    );
    return 0;
  }

  const precondition = await vaultPreconditionError(vaultPath);
  if (precondition !== null) return usage(json, vaultPath, precondition);

  let environment: ReadonlyMap<string, string>;
  try {
    environment = await resolveServiceEnvironment(options);
  } catch (e) {
    return usage(json, vaultPath, e instanceof Error ? e.message : String(e));
  }

  // systemd Environment= values are single-line: a literal newline would
  // corrupt the unit file (the remainder parses as new directives), so a
  // malformed entry is a usage error, not a render-time surprise.
  for (const [key, value] of environment) {
    if (/[\n\r]/.test(value)) {
      return usage(
        json,
        vaultPath,
        `environment value for ${key} contains a newline; ` +
          `systemd Environment= values must be single-line`,
      );
    }
  }

  const logPath = join(vaultPath, ".dome", "state", "serve.log");
  try {
    await mkdir(join(vaultPath, ".dome", "state"), { recursive: true });
    await mkdir(d.systemdUserDir, { recursive: true });
    const replaced = existsSync(unitPath);
    await writeFile(
      unitPath,
      renderServeSystemdUnit({
        bunPath: d.bunPath,
        domeBin: d.domeBin,
        vaultPath,
        logPath,
        environment,
      }),
      "utf8",
    );

    for (const args of [
      ["daemon-reload"],
      ["enable", unit],
      ["restart", unit],
    ] as const) {
      const result = await d.systemctl([...args]);
      if (result.exitCode !== 0) {
        const detail =
          result.stderr.trim() || result.stdout.trim() ||
          `exit ${result.exitCode}`;
        return fail(
          json,
          "install",
          vaultPath,
          unit,
          unitPath,
          `systemctl --user ${args.join(" ")} failed: ${detail} (unit left at ${unitPath})`,
        );
      }
    }

    console.log(
      json
        ? formatJson({
            schema: "dome.install/v1",
            status: "installed",
            vault: vaultPath,
            label: unit,
            unit: unitPath,
            plist: unitPath,
            log: logPath,
            replaced,
          })
        : `dome install: ${replaced ? "replaced" : "installed"} ${unit}\n` +
          `  unit: ${unitPath}\n  log: ${logPath}\n` +
          `  note: run \`loginctl enable-linger $USER\` once so the service survives logout/boot`,
    );
    return 0;
  } catch (e) {
    return fail(
      json,
      "install",
      vaultPath,
      unit,
      unitPath,
      e instanceof Error ? e.message : String(e),
    );
  }
}

export async function runUninstallSystemd(
  options: RunUninstallOptions,
  d: ResolvedServiceDeps,
): Promise<number> {
  const vaultPath = resolveVaultPath(options.vault);
  const json = options.json === true;
  const unit = serviceUnitNameForVault(vaultPath);
  const unitPath = join(d.systemdUserDir, unit);
  try {
    const installed = existsSync(unitPath);
    // Unconditional disable --now: covers the deleted-unit-but-still-running
    // edge (unit file removed by hand while the service stays active).
    // Failure just means nothing was loaded; fine.
    await d.systemctl(["disable", "--now", unit]);
    if (installed) {
      await unlink(unitPath);
      await d.systemctl(["daemon-reload"]);
    }
    console.log(
      json
        ? formatJson({
            schema: "dome.uninstall/v1",
            status: installed ? "uninstalled" : "not-installed",
            vault: vaultPath,
            label: unit,
            unit: unitPath,
            plist: unitPath,
          })
        : installed
          ? `dome uninstall: removed ${unit}`
          : `dome uninstall: not installed (no unit at ${unitPath}); nothing to do`,
    );
    return 0;
  } catch (e) {
    return fail(
      json,
      "uninstall",
      vaultPath,
      unit,
      unitPath,
      e instanceof Error ? e.message : String(e),
    );
  }
}

export async function runRestartSystemd(
  options: RunRestartOptions,
  d: ResolvedServiceDeps,
): Promise<number> {
  const vaultPath = resolveVaultPath(options.vault);
  const json = options.json === true;
  const unit = serviceUnitNameForVault(vaultPath);
  const unitPath = join(d.systemdUserDir, unit);
  if (!existsSync(unitPath)) {
    const error = `not installed (no unit at ${unitPath}); run \`dome install\` first`;
    if (json) {
      console.log(
        formatJson({
          schema: "dome.restart/v1",
          status: "error",
          vault: vaultPath,
          label: unit,
          unit: unitPath,
          plist: unitPath,
          error,
        }),
      );
    } else {
      console.error(`dome restart: ${error}`);
    }
    return EX_USAGE;
  }
  const result = await d.systemctl(["restart", unit]);
  if (result.exitCode !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    return fail(
      json,
      "restart",
      vaultPath,
      unit,
      unitPath,
      `systemctl --user restart failed: ${detail}`,
    );
  }
  console.log(
    json
      ? formatJson({
          schema: "dome.restart/v1",
          status: "restarted",
          vault: vaultPath,
          label: unit,
          unit: unitPath,
          plist: unitPath,
        })
      : `dome restart: restarted ${unit}`,
  );
  return 0;
}

// ----- internals --------------------------------------------------------------

function usage(json: boolean, vault: string, error: string): number {
  if (json) {
    console.log(
      formatJson({ schema: "dome.install/v1", status: "error", vault, error }),
    );
  } else {
    console.error(`dome install: ${error}`);
  }
  return EX_USAGE;
}

function fail(
  json: boolean,
  verb: "install" | "uninstall" | "restart",
  vault: string,
  label: string,
  unitPath: string,
  message: string,
): number {
  if (json) {
    console.log(
      formatJson({
        schema: `dome.${verb}/v1`,
        status: "error",
        vault,
        label,
        unit: unitPath,
        plist: unitPath,
        error: message,
      }),
    );
  } else {
    console.error(`dome ${verb}: failed: ${message}`);
  }
  return 1;
}
