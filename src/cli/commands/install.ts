// cli/commands/install: `dome install` / `dome uninstall` / `dome restart` —
// Phase 1 of the product wedge (docs/wedge.md §"Phase 1 — Ambient daemon").
//
// Per docs/wiki/specs/cli.md §"dome install" / §"dome uninstall" /
// §"dome restart", this makes the local compiler host ambient on macOS:
// `dome install` generates a launchd LaunchAgent that runs `dome serve` for
// the vault (RunAtLoad + KeepAlive, logs to `.dome/state/serve.log`) and
// loads and starts it via `launchctl bootstrap gui/<uid>` followed by
// `launchctl kickstart -k`; `dome uninstall` boots it out and removes the
// plist; `dome restart` boots it out and activates it again from the existing
// plist on disk (never re-rendered — that would drop user `--env` entries).
//
// Design constraints carried from the spec:
//
//   - The service label `com.dome.serve.<slug>` is deterministic from the
//     resolved vault path (sanitized basename + 8-hex SHA-256 prefix), so the
//     same vault always maps to the same LaunchAgent and distinct vaults
//     never collide.
//   - Idempotency via bootout-first: `launchctl bootout` before every
//     `bootstrap` (failure ignored when the service isn't loaded), so a
//     re-run cleanly replaces the loaded definition. Uninstall is a no-error
//     no-op when nothing is installed.
//   - Host dispatch: this file owns the launchd (macOS) backend; on Linux
//     the verbs dispatch to the systemd --user backend in
//     install-systemd.ts behind the same ServiceDeps boundary. Other
//     platforms refuse with a clear message instead of pretending;
//     `dome serve` under the user's own service manager remains the
//     portable path.
//   - Testability is part of the contract: every host boundary (platform,
//     uid, LaunchAgents dir, the launchctl runner, executable paths) is
//     injectable via a deps parameter defaulting to the real environment and
//     a real `Bun.spawn` runner. Tests use temp dirs + a recording fake and
//     never touch `~/Library` or run real `launchctl`.
//
// Mutation-boundary note: like `src/cli/commands/init.ts`, this is host-level
// scaffolding at the compiler boundary (a plist under the user's home dir +
// the gitignored `.dome/state/` log dir), not an engine write path. The file
// is whitelisted in `tests/integration/no-direct-mutation-outside-boundaries
// .test.ts` `ALLOWED_FILES`, matching init.ts.
//
// House-style notes (matches src/cli/commands/init.ts / serve.ts):
//   - `type X = { ... }` aliases, every field `readonly`.
//   - The handler returns the exit code; the dispatcher calls
//     `process.exit(code)`.
//   - Console output goes through `console.log` / `console.error`.

import { existsSync } from "node:fs";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { findGitRoot } from "../../git";
import {
  activateLaunchAgent,
  publishLaunchAgentPlist,
  renderLaunchAgentPlist,
  waitForLaunchAgentDrain,
} from "../../platform/launchd";
import { formatJson } from "../../surface/format";
import {
  footer,
  headline,
  kv,
  resolveCaps,
  section,
  type KvRow,
  type Status,
} from "../presenter";

import { resolveVaultPath } from "../../surface/resolve-vault";
import {
  resolveServiceDeps,
  serviceLabelForVault,
  type LaunchctlRunner,
  type ResolvedServiceDeps,
  type ServiceDeps,
} from "../../surface/service-probe";
import { EX_USAGE } from "../exit-codes";
// ----- Constants ------------------------------------------------------------

/**
 * Standard PATH entries for the launchd service environment. launchd gui
 * agents get a bare `/usr/bin:/bin:/usr/sbin:/sbin`, which cannot resolve a
 * Homebrew/`~/.bun` `bun` — and the scaffolded model provider command is
 * `["bun", ".dome/model-provider.ts"]`, so the serve host would be unable to
 * spawn it. The rendered plist prepends the directory of the bun runtime
 * that performed the install.
 */
const SERVICE_PATH_STANDARD_DIRS = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
] as const;

const unsupportedMessage = (verb: "install" | "uninstall" | "restart"): string =>
  `service ${verb} is supported on macOS (launchd) and Linux (systemd --user); ` +
  `run \`dome serve\` under your own service manager elsewhere`;

// ----- Public types ---------------------------------------------------------

export type RunInstallOptions = {
  readonly vault?: string | undefined;
  readonly status?: boolean | undefined;
  /** Repeatable `--env KEY=VALUE` entries for the service environment. */
  readonly env?: ReadonlyArray<string> | undefined;
  /** `--env-file <path>`: KEY=VALUE lines (blank lines and `#` comments skipped). */
  readonly envFile?: string | undefined;
  readonly json?: boolean | undefined;
};

export type RunUninstallOptions = {
  readonly vault?: string | undefined;
  readonly json?: boolean | undefined;
};

export type RunRestartOptions = {
  readonly vault?: string | undefined;
  readonly json?: boolean | undefined;
};

// ----- Label / plist derivation (pure, exported for tests) ------------------

/**
 * The launchd service PATH: the directory of the installing bun runtime
 * first (launchd's default PATH cannot resolve Homebrew/`~/.bun` binaries,
 * and the serve host must spawn provider commands like `["bun",
 * ".dome/model-provider.ts"]`), then the standard dirs.
 */
export function servicePath(bunPath: string): string {
  const bunDir = dirname(bunPath);
  const dirs = [bunDir, ...SERVICE_PATH_STANDARD_DIRS.filter((d) => d !== bunDir)];
  return dirs.join(":");
}

/**
 * Render the LaunchAgent plist. RunAtLoad starts the host at login;
 * KeepAlive restarts it after crashes; WorkingDirectory pins the vault;
 * stdout/stderr both land in the gitignored `.dome/state/serve.log`;
 * EnvironmentVariables always carries a usable PATH (see `servicePath`)
 * plus any caller-supplied credential entries (`--env` / `--env-file`).
 */
export function renderServePlist(input: {
  readonly label: string;
  readonly bunPath: string;
  readonly domeBin: string;
  readonly vaultPath: string;
  readonly logPath: string;
  readonly environment?: ReadonlyMap<string, string>;
}): string {
  const args = [input.bunPath, input.domeBin, "serve", "--vault", input.vaultPath];
  const environment = new Map<string, string>([
    ["PATH", servicePath(input.bunPath)],
    ...(input.environment ?? []),
  ]);
  return renderLaunchAgentPlist({
    label: input.label,
    programArguments: args,
    workingDirectory: input.vaultPath,
    logPath: input.logPath,
    environment,
  });
}

/**
 * Null when the path is an initialized vault; otherwise the refusal text.
 * Shared by the launchd and systemd install flows: installing a
 * keep-alive serve service against a non-vault directory would scaffold
 * `.dome/state/` there and crashloop forever.
 */
export async function vaultPreconditionError(
  vaultPath: string,
): Promise<string | null> {
  const gitRoot = await findGitRoot(vaultPath);
  if (gitRoot !== null && existsSync(join(vaultPath, ".dome", "config.yaml"))) {
    return null;
  }
  return `not an initialized Dome vault (missing ${
    gitRoot === null ? "git repository" : ".dome/config.yaml"
  }); run \`dome init\` first`;
}

// ----- runInstall -----------------------------------------------------------

/**
 * Execute `dome install` (or `dome install --status`). Returns the exit
 * code: 0 on success (including idempotent re-install and clean status
 * reads); 64 (EX_USAGE) when the target is not an initialized Dome vault or
 * an `--env`/`--env-file` entry is malformed; 1 on non-macOS platform,
 * undeterminable uid, launchctl bootstrap/kickstart failure, or unexpected
 * I/O failure.
 */
export async function runInstall(
  options: RunInstallOptions = {},
  deps: ServiceDeps = {},
): Promise<number> {
  const vaultPath = resolveVaultPath(options.vault);
  const d = resolveServiceDeps(deps);
  const json = options.json === true;

  const refusal = refuseUnsupportedHost("install", vaultPath, d, json);
  if (refusal !== null) return refusal;
  if (d.platform === "linux") {
    const { runInstallSystemd } = await import("./install-systemd");
    return runInstallSystemd(options, d);
  }
  const uid = d.uid as number;

  const label = serviceLabelForVault(vaultPath);
  const plistPath = join(d.launchAgentsDir, `${label}.plist`);

  if (options.status === true) {
    return await reportServiceStatus({
      vaultPath,
      label,
      plistPath,
      uid,
      launchctl: d.launchctl,
      json,
    });
  }

  // Vault precondition (same refusal style as `dome capture`): installing a
  // KeepAlive serve service against a non-vault directory would scaffold
  // `.dome/state/` there and crashloop forever.
  const precondition = await vaultPreconditionError(vaultPath);
  if (precondition !== null) {
    return reportUsageError({ vaultPath, json, error: precondition });
  }

  let environment: ReadonlyMap<string, string>;
  try {
    environment = await resolveServiceEnvironment(options);
  } catch (e) {
    return reportUsageError({
      vaultPath,
      json,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const logPath = join(vaultPath, ".dome", "state", "serve.log");
  try {
    // The log dir is the vault's gitignored derived-state dir; launchd
    // creates the log file but not its directory.
    await mkdir(join(vaultPath, ".dome", "state"), { recursive: true });
    await mkdir(d.launchAgentsDir, { recursive: true });

    // Bootout-first for idempotent replacement. Failure is expected when the
    // service isn't currently loaded; launchctl reports it via exit code.
    await d.launchctl(["bootout", `gui/${uid}/${label}`]);
    await waitForLaunchAgentDrain({ launchctl: d.launchctl, uid, label, timeoutMs: d.drainTimeoutMs });

    const replaced = existsSync(plistPath);
    await publishLaunchAgentPlist(
      plistPath,
      renderServePlist({
        label,
        bunPath: d.bunPath,
        domeBin: d.domeBin,
        vaultPath,
        logPath,
        environment,
      }),
    );

    const activationError = await activateLaunchAgent({ launchctl: d.launchctl, uid, label, plistPath });
    if (activationError !== null) {
      if (json) {
        console.log(formatJson({
          schema: "dome.install/v1",
          status: "error",
          vault: vaultPath,
          label,
          plist: plistPath,
          error: activationError,
        }));
      } else {
        console.error(`dome install: ${activationError}`);
      }
      return 1;
    }

    if (json) {
      console.log(formatJson({
        schema: "dome.install/v1",
        status: "installed",
        vault: vaultPath,
        label,
        plist: plistPath,
        log: logPath,
        replaced,
      }));
    } else {
      printInstallSummary({ vaultPath, label, plistPath, logPath, replaced });
    }
    return 0;
  } catch (e) {
    return reportFailure("install", vaultPath, label, plistPath, e, json);
  }
}

// ----- runUninstall ---------------------------------------------------------

/**
 * Execute `dome uninstall`. Boots the service out (ignored when not loaded)
 * and removes the plist. Idempotent: exits 0 with a "not installed" note
 * when no plist is present.
 */
export async function runUninstall(
  options: RunUninstallOptions = {},
  deps: ServiceDeps = {},
): Promise<number> {
  const vaultPath = resolveVaultPath(options.vault);
  const d = resolveServiceDeps(deps);
  const json = options.json === true;

  const refusal = refuseUnsupportedHost("uninstall", vaultPath, d, json);
  if (refusal !== null) return refusal;
  if (d.platform === "linux") {
    const { runUninstallSystemd } = await import("./install-systemd");
    return runUninstallSystemd(options, d);
  }
  const uid = d.uid as number;

  const label = serviceLabelForVault(vaultPath);
  const plistPath = join(d.launchAgentsDir, `${label}.plist`);

  try {
    // Always attempt the bootout: it covers the deleted-plist-but-loaded
    // edge, and failure just means the service wasn't loaded.
    await d.launchctl(["bootout", `gui/${uid}/${label}`]);

    const installed = existsSync(plistPath);
    if (installed) await unlink(plistPath);

    if (json) {
      console.log(formatJson({
        schema: "dome.uninstall/v1",
        status: installed ? "uninstalled" : "not-installed",
        vault: vaultPath,
        label,
        plist: plistPath,
      }));
    } else if (installed) {
      printUninstallSummary({ vaultPath, label, plistPath });
    } else {
      console.log(
        `dome uninstall: not installed (no plist at ${plistPath}); nothing to do`,
      );
    }
    return 0;
  } catch (e) {
    return reportFailure("uninstall", vaultPath, label, plistPath, e, json);
  }
}

// ----- runRestart -----------------------------------------------------------

/**
 * Execute `dome restart`: bootout + bootstrap + kickstart from the **existing
 * plist on disk**. The plist is deliberately NOT rebuilt — re-rendering would
 * drop the user's `--env` / `--env-file` EnvironmentVariables entries, which
 * are only remembered inside the plist itself (see
 * `resolveServiceEnvironment`). `dome install` remains the path that rewrites
 * the plist.
 *
 * Returns the exit code: 0 on a successful restart; 64 (EX_USAGE) when no
 * plist is installed for the vault; 1 on non-macOS platform, undeterminable
 * uid, or `launchctl bootstrap` / `kickstart` failure.
 */
export async function runRestart(
  options: RunRestartOptions = {},
  deps: ServiceDeps = {},
): Promise<number> {
  const vaultPath = resolveVaultPath(options.vault);
  const d = resolveServiceDeps(deps);
  const json = options.json === true;

  const refusal = refuseUnsupportedHost("restart", vaultPath, d, json);
  if (refusal !== null) return refusal;
  if (d.platform === "linux") {
    const { runRestartSystemd } = await import("./install-systemd");
    return runRestartSystemd(options, d);
  }
  const uid = d.uid as number;

  const label = serviceLabelForVault(vaultPath);
  const plistPath = join(d.launchAgentsDir, `${label}.plist`);

  if (!existsSync(plistPath)) {
    const error =
      `not installed (no plist at ${plistPath}); run \`dome install\` first`;
    if (json) {
      console.log(formatJson({
        schema: "dome.restart/v1",
        status: "error",
        vault: vaultPath,
        label,
        plist: plistPath,
        error,
      }));
    } else {
      console.error(`dome restart: ${error}`);
    }
    return EX_USAGE;
  }

  try {
    // Same bootout-first shape as install: failure is expected when the
    // service is not currently loaded (a dead service is exactly why an
    // operator restarts).
    await d.launchctl(["bootout", `gui/${uid}/${label}`]);
    await waitForLaunchAgentDrain({ launchctl: d.launchctl, uid, label, timeoutMs: d.drainTimeoutMs });

    const activationError = await activateLaunchAgent({ launchctl: d.launchctl, uid, label, plistPath });
    if (activationError !== null) {
      if (json) {
        console.log(formatJson({
          schema: "dome.restart/v1",
          status: "error",
          vault: vaultPath,
          label,
          plist: plistPath,
          error: activationError,
        }));
      } else {
        console.error(`dome restart: ${activationError}`);
      }
      return 1;
    }

    if (json) {
      console.log(formatJson({
        schema: "dome.restart/v1",
        status: "restarted",
        vault: vaultPath,
        label,
        plist: plistPath,
      }));
    } else {
      printRestartSummary({ vaultPath, label, plistPath });
    }
    return 0;
  } catch (e) {
    return reportFailure("restart", vaultPath, label, plistPath, e, json);
  }
}

// ----- internals ------------------------------------------------------------

/**
 * Resolve the extra EnvironmentVariables entries from `--env-file` then
 * `--env` (flags win over file entries on the same key). Each entry is
 * `KEY=VALUE`; env-file lines may be blank or `#` comments. Malformed
 * entries throw — the caller surfaces them as usage errors (exit 64).
 *
 * Note: launchd persists these values in the plist in plain text under
 * `~/Library/LaunchAgents/`, and re-running `dome install` rebuilds the
 * plist from the flags passed *that* run — entries are not remembered
 * across re-installs. `launchctl setenv` is the alternative for values
 * that should live outside the plist.
 */
export async function resolveServiceEnvironment(
  options: RunInstallOptions,
): Promise<ReadonlyMap<string, string>> {
  const environment = new Map<string, string>();
  if (options.envFile !== undefined) {
    let body: string;
    try {
      body = await readFile(resolve(options.envFile), "utf8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`cannot read --env-file ${options.envFile}: ${msg}`);
    }
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith("#")) continue;
      const [key, value] = parseEnvEntry(line, `--env-file ${options.envFile}`);
      environment.set(key, value);
    }
  }
  for (const entry of options.env ?? []) {
    const [key, value] = parseEnvEntry(entry, "--env");
    environment.set(key, value);
  }
  return environment;
}

function parseEnvEntry(
  entry: string,
  source: string,
): readonly [string, string] {
  const eq = entry.indexOf("=");
  const key = eq === -1 ? entry : entry.slice(0, eq);
  if (eq === -1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(
      `${source}: expected KEY=VALUE with a valid variable name, got ${JSON.stringify(entry)}`,
    );
  }
  return [key, entry.slice(eq + 1)] as const;
}

function reportUsageError(input: {
  readonly vaultPath: string;
  readonly json: boolean;
  readonly error: string;
}): number {
  if (input.json) {
    console.log(formatJson({
      schema: "dome.install/v1",
      status: "error",
      vault: input.vaultPath,
      error: input.error,
    }));
  } else {
    console.error(`dome install: ${input.error}`);
  }
  return EX_USAGE;
}

/**
 * Refuse unsupported hosts (neither macOS launchd nor Linux systemd --user)
 * and uid-less darwin environments before touching anything. Returns the
 * exit code to surface, or null when the host is usable.
 */
function refuseUnsupportedHost(
  verb: "install" | "uninstall" | "restart",
  vaultPath: string,
  d: ResolvedServiceDeps,
  json: boolean,
): number | null {
  const error =
    d.platform !== "darwin" && d.platform !== "linux"
      ? unsupportedMessage(verb)
      : d.platform === "darwin" && d.uid === null
        ? "cannot determine the current uid for the launchd gui domain"
        : null;
  if (error === null) return null;
  if (json) {
    console.log(formatJson({
      schema: `dome.${verb}/v1`,
      status: "error",
      vault: vaultPath,
      error,
    }));
  } else {
    console.error(`dome ${verb}: ${error}`);
  }
  return 1;
}

async function reportServiceStatus(input: {
  readonly vaultPath: string;
  readonly label: string;
  readonly plistPath: string;
  readonly uid: number;
  readonly launchctl: LaunchctlRunner;
  readonly json: boolean;
}): Promise<number> {
  const installed = existsSync(input.plistPath);
  const print = await input.launchctl([
    "print",
    `gui/${input.uid}/${input.label}`,
  ]);
  const loaded = print.exitCode === 0;

  if (input.json) {
    console.log(formatJson({
      schema: "dome.install/v1",
      status: "status",
      vault: input.vaultPath,
      label: input.label,
      plist: input.plistPath,
      installed,
      loaded,
    }));
    return 0;
  }

  renderServiceCard({
    cmd: "install",
    vaultPath: input.vaultPath,
    tone: loaded
      ? { tone: "ok", label: "service loaded" }
      : installed
        ? { tone: "warn", label: "installed, not loaded" }
        : { tone: "muted", label: "not installed" },
    rows: [
      { label: "label", value: input.label },
      { label: "plist", value: input.plistPath, tone: "muted" },
      { label: "installed", value: installed ? "yes" : "no" },
      { label: "loaded", value: loaded ? "yes" : "no" },
    ],
  });
  return 0;
}

/**
 * The one human-readable card shape every install/uninstall verb prints:
 * headline (verb + vault basename + tone) → one "Service" kv section →
 * footer. Status, install, and uninstall summaries differ only in tone and
 * rows.
 */
function renderServiceCard(input: {
  readonly cmd: "install" | "uninstall";
  readonly vaultPath: string;
  readonly tone: Status;
  readonly rows: ReadonlyArray<KvRow>;
}): void {
  const caps = resolveCaps();
  const lines = [
    headline(
      { cmd: input.cmd, context: basename(input.vaultPath) },
      input.tone,
      caps,
    ),
    ...section("Service", kv(input.rows, caps), caps),
    ...footer(input.tone, caps),
  ];
  console.log(lines.join("\n"));
}

function printInstallSummary(input: {
  readonly vaultPath: string;
  readonly label: string;
  readonly plistPath: string;
  readonly logPath: string;
  readonly replaced: boolean;
}): void {
  renderServiceCard({
    cmd: "install",
    vaultPath: input.vaultPath,
    tone: {
      tone: "ok",
      label: input.replaced ? "service replaced" : "service installed",
    },
    rows: [
      { label: "label", value: input.label },
      { label: "plist", value: input.plistPath, tone: "muted" },
      { label: "log", value: input.logPath, tone: "muted" },
      { label: "vault", value: input.vaultPath, tone: "muted" },
    ],
  });
}

function printRestartSummary(input: {
  readonly vaultPath: string;
  readonly label: string;
  readonly plistPath: string;
}): void {
  const caps = resolveCaps();
  const tone: Status = { tone: "ok", label: "service restarted" };
  const rows: KvRow[] = [
    { label: "label", value: input.label },
    { label: "plist", value: input.plistPath, tone: "muted" },
    { label: "vault", value: input.vaultPath, tone: "muted" },
  ];
  const lines = [
    headline(
      { cmd: "restart", context: basename(input.vaultPath) },
      tone,
      caps,
    ),
    ...section("Service", kv(rows, caps), caps),
    ...footer(tone, caps),
  ];
  console.log(lines.join("\n"));
}

function printUninstallSummary(input: {
  readonly vaultPath: string;
  readonly label: string;
  readonly plistPath: string;
}): void {
  renderServiceCard({
    cmd: "uninstall",
    vaultPath: input.vaultPath,
    tone: { tone: "ok", label: "service removed" },
    rows: [
      { label: "label", value: input.label },
      { label: "plist", value: input.plistPath, tone: "muted" },
    ],
  });
}

function reportFailure(
  verb: "install" | "uninstall" | "restart",
  vaultPath: string,
  label: string,
  plistPath: string,
  e: unknown,
  json: boolean,
): number {
  const message = e instanceof Error ? e.message : String(e);
  if (json) {
    console.log(formatJson({
      schema: `dome.${verb}/v1`,
      status: "error",
      vault: vaultPath,
      label,
      plist: plistPath,
      error: message,
    }));
  } else {
    console.error(`dome ${verb}: failed: ${message}`);
  }
  return 1;
}
