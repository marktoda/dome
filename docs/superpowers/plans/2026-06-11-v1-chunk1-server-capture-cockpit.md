# Dome v1 Chunk 1 — Server Migration, Mobile Capture, Cockpit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Dome daemon host-portable (systemd user services alongside launchd), ship the iOS-Shortcut capture recipe (`dome recipe ios`), and ship the cockpit (`dome today` / `dome today --watch` / `GET /today` HTML) — the first executable chunk of the approved v1 plan (`docs/cohesive/brainstorms/2026-06-11-dome-v1-plan.md`).

**Architecture:** Everything is an adapter over existing machinery. systemd support mirrors the launchd backend behind the same injectable `ServiceDeps` boundary (`src/surface/service-probe.ts`), dispatched by platform inside the existing `runInstall`/`runUninstall`/`runRestart`. The cockpit is the shipped `dome.daily.today` view (`FIRST_PARTY_VIEWS.today`) behind two thin renderers: a new `dome today` CLI verb (house pattern: `src/cli/commands/query.ts`) and a `GET /today` HTML route on the HTTP server. `dome recipe ios` is a pure text generator. No engine changes, no new effects, no new processors.

**Tech Stack:** Bun + TypeScript, Commander CLI, `bun:test`. House style: `type X = { readonly ... }`, handlers return exit codes, injectable deps for every host boundary, hermetic tests in temp dirs.

**Vault-facing constraint:** `docs/` is a Dome vault and the specs are normative. Task 10 keeps `docs/wiki/specs/cli.md` and `docs/wiki/specs/http-surface.md` in lockstep with the new verbs/routes. `tests/integration/cli-shell-shape.test.ts` pins the CLI command inventory — it must learn `today` and `recipe`.

---

## File structure

| File | Role |
|---|---|
| Create `src/cli/commands/install-systemd.ts` | systemd unit rendering + install/uninstall/restart/status flows (Linux) |
| Modify `src/surface/service-probe.ts` | `systemctl` runner + `systemdUserDir` deps; `probeServiceState` Linux branch; `serviceUnitNameForVault` |
| Modify `src/cli/commands/install.ts` | platform dispatch; export `resolveServiceEnvironment` + `vaultPreconditionError`; unsupported-platform message update |
| Create `src/cli/commands/today.ts` | `dome today` view command + `--watch` loop |
| Create `src/http/today-html.ts` | pure structured-data → HTML renderer |
| Modify `src/http/server.ts` | `GET /today` route; query-param token auth for that route only |
| Create `src/cli/commands/recipe.ts` | `dome recipe ios` text generator |
| Modify `src/cli/index.ts` | register `today` + `recipe`; update `install` description |
| Test `tests/cli/install-systemd.test.ts` | systemd flows (recording fake systemctl, temp dirs) |
| Test `tests/cli/commands/today.test.ts` | today render + watch loop |
| Test `tests/cli/commands/recipe.test.ts` | recipe output |
| Test `tests/http/today-html.test.ts` | HTML renderer |
| Modify `tests/http/http-server.test.ts` | `/today` route + token rules |
| Modify `tests/integration/cli-shell-shape.test.ts` | add `today`, `recipe` to the pinned inventory |
| Modify `docs/wiki/specs/cli.md`, `docs/wiki/specs/http-surface.md`, `docs/wiki/specs/capture.md` | normative spec lockstep |
| Create `docs/cohesive/runbooks/2026-06-server-migration.md` | ops runbook (manual steps for Mark's server) |

Run all tests with `bun test <path>`; full suite `bun test`.

---

### Task 1: systemd unit rendering (pure functions)

**Files:**
- Create: `src/cli/commands/install-systemd.ts`
- Modify: `src/surface/service-probe.ts` (add `serviceUnitNameForVault`)
- Test: `tests/cli/install-systemd.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/cli/install-systemd.test.ts
// systemd backend for `dome install` — same testability contract as
// tests/cli/install.test.ts: every host boundary injected; recording fake
// systemctl; temp dirs; never touches ~/.config or real systemd.

import { describe, expect, test } from "bun:test";

import { renderServeSystemdUnit } from "../../src/cli/commands/install-systemd";
import {
  serviceUnitNameForVault,
  vaultServiceSlug,
} from "../../src/surface/service-probe";

describe("serviceUnitNameForVault", () => {
  test("derives a deterministic .service name from the vault slug", () => {
    const unit = serviceUnitNameForVault("/home/mark/vaults/work");
    expect(unit).toBe(
      `dome-serve-${vaultServiceSlug("/home/mark/vaults/work")}.service`,
    );
    // Same path → same unit; deterministic across calls.
    expect(serviceUnitNameForVault("/home/mark/vaults/work")).toBe(unit);
  });
});

describe("renderServeSystemdUnit", () => {
  const input = {
    bunPath: "/home/mark/.bun/bin/bun",
    domeBin: "/home/mark/dev/dome/bin/dome",
    vaultPath: "/home/mark/vaults/work",
    logPath: "/home/mark/vaults/work/.dome/state/serve.log",
    environment: new Map([["ANTHROPIC_API_KEY", "sk-test"]]),
  };

  test("renders ExecStart, WorkingDirectory, Restart, log redirection", () => {
    const unit = renderServeSystemdUnit(input);
    expect(unit).toContain(
      'ExecStart="/home/mark/.bun/bin/bun" "/home/mark/dev/dome/bin/dome" serve --vault "/home/mark/vaults/work"',
    );
    expect(unit).toContain("WorkingDirectory=/home/mark/vaults/work");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain(
      "StandardOutput=append:/home/mark/vaults/work/.dome/state/serve.log",
    );
    expect(unit).toContain(
      "StandardError=append:/home/mark/vaults/work/.dome/state/serve.log",
    );
    expect(unit).toContain("WantedBy=default.target");
  });

  test("carries PATH plus caller environment entries", () => {
    const unit = renderServeSystemdUnit(input);
    expect(unit).toContain('Environment="PATH=/home/mark/.bun/bin:');
    expect(unit).toContain('Environment="ANTHROPIC_API_KEY=sk-test"');
  });

  test("escapes percent specifiers in environment values", () => {
    const unit = renderServeSystemdUnit({
      ...input,
      environment: new Map([["WEIRD", 'a%b"c']]),
    });
    // systemd expands % specifiers; literal % must be doubled, " escaped.
    expect(unit).toContain('Environment="WEIRD=a%%b\\"c"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/install-systemd.test.ts`
Expected: FAIL — `install-systemd` module does not exist / `serviceUnitNameForVault` not exported.

- [ ] **Step 3: Implement**

Add to `src/surface/service-probe.ts` (below `serviceLabelForVault`):

```typescript
/** systemd user-unit name for a vault's ambient `dome serve` service. */
export function serviceUnitNameForVault(vaultPath: string): string {
  return `dome-serve-${vaultServiceSlug(vaultPath)}.service`;
}
```

Create `src/cli/commands/install-systemd.ts`:

```typescript
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

import { dirname } from "node:path";

import { servicePath } from "./install";

// ----- Unit rendering (pure, exported for tests) -----------------------------

/**
 * Render the systemd user unit for `dome serve`. Restart=always mirrors
 * launchd KeepAlive; append: log redirection mirrors the plist's
 * StandardOutPath/StandardErrorPath; Environment carries PATH (user
 * managers get a minimal PATH that cannot resolve ~/.bun) plus
 * caller-supplied entries.
 */
export function renderServeSystemdUnit(input: {
  readonly bunPath: string;
  readonly domeBin: string;
  readonly vaultPath: string;
  readonly logPath: string;
  readonly environment?: ReadonlyMap<string, string>;
}): string {
  const exec = [input.bunPath, input.domeBin, "serve", "--vault", input.vaultPath]
    .map((arg) => `"${execEscape(arg)}"`)
    .join(" ");
  const environment = new Map<string, string>([
    ["PATH", servicePath(input.bunPath)],
    ...(input.environment ?? []),
  ]);
  const envLines = [...environment]
    .map(([key, value]) => `Environment="${key}=${envEscape(value)}"`)
    .join("\n");
  return `[Unit]
Description=Dome compiler host (dome serve) for ${input.vaultPath}
After=network.target

[Service]
ExecStart=${exec.replace("\"serve\"", "serve").replace("\"--vault\"", "--vault")}
WorkingDirectory=${input.vaultPath}
${envLines}
Restart=always
RestartSec=2
StandardOutput=append:${input.logPath}
StandardError=append:${input.logPath}

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

/** Escape an ExecStart quoted argument: " and \ only. */
function execEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
```

Note the `ExecStart` line: systemd wants the *binary and path-bearing args* quoted but plain words (`serve`, `--vault`) are conventionally unquoted — the small `.replace` calls keep the rendered line matching the test's expected shape. If you prefer, quote everything and update the test to match; pick one and keep test + implementation consistent.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/install-systemd.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/surface/service-probe.ts src/cli/commands/install-systemd.ts tests/cli/install-systemd.test.ts
git commit -m "feat(cli): systemd unit rendering for host-portable install (v1 chunk1)"
```

---

### Task 2: ServiceDeps grows the systemctl boundary; probeServiceState supports Linux

**Files:**
- Modify: `src/surface/service-probe.ts`
- Test: `tests/cli/install-systemd.test.ts` (extend)

- [ ] **Step 1: Write the failing test** (append to `tests/cli/install-systemd.test.ts`)

```typescript
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  probeServiceState,
  type LaunchctlResult,
  type LaunchctlRunner,
} from "../../src/surface/service-probe";

type FakeRunner = {
  readonly calls: Array<ReadonlyArray<string>>;
  readonly runner: LaunchctlRunner;
};

/** Recording systemctl fake; per-subcommand exit codes overridable. */
function fakeSystemctl(
  overrides: Partial<Record<string, LaunchctlResult>> = {},
): FakeRunner {
  const calls: Array<ReadonlyArray<string>> = [];
  const runner: LaunchctlRunner = async (args) => {
    calls.push(args);
    const sub = args[0] ?? "";
    return (
      overrides[sub] ?? { exitCode: 0, stdout: "", stderr: "" }
    );
  };
  return { calls, runner };
}

describe("probeServiceState on linux", () => {
  test("reports installed+active from the unit file and is-active", async () => {
    const userDir = mkdtempSync(join(tmpdir(), "dome-systemd-user-"));
    const vault = mkdtempSync(join(tmpdir(), "dome-probe-vault-"));
    const unit = serviceUnitNameForVault(vault);
    await writeFile(join(userDir, unit), "[Unit]\n", "utf8");
    const ctl = fakeSystemctl({ "is-active": { exitCode: 0, stdout: "active\n", stderr: "" } });

    const state = await probeServiceState(vault, {
      platform: "linux",
      systemdUserDir: userDir,
      systemctl: ctl.runner,
    });
    expect(state).toEqual({
      supported: true,
      label: unit,
      plist: join(userDir, unit),
      installed: true,
      loaded: true,
    });
    expect(ctl.calls).toEqual([["is-active", unit]]);
  });

  test("not installed → loaded probe skipped", async () => {
    const userDir = mkdtempSync(join(tmpdir(), "dome-systemd-user-"));
    const vault = mkdtempSync(join(tmpdir(), "dome-probe-vault-"));
    const ctl = fakeSystemctl();
    const state = await probeServiceState(vault, {
      platform: "linux",
      systemdUserDir: userDir,
      systemctl: ctl.runner,
    });
    expect(state).toMatchObject({ supported: true, installed: false, loaded: null });
    expect(ctl.calls).toEqual([]);
  });
});
```

(The `plist` field name is kept for the unit path — it is the established `ServiceState` shape consumed by `dome status` and the MCP status tool; renaming it would ripple through every consumer. The human-facing renderers label it appropriately per platform in Task 3.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/install-systemd.test.ts`
Expected: FAIL — `systemdUserDir`/`systemctl` not valid `ServiceDeps` fields; linux returns `{ supported: false }`.

- [ ] **Step 3: Implement** in `src/surface/service-probe.ts`:

Extend the deps types (add fields to `ServiceDeps` / `ResolvedServiceDeps`):

```typescript
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
  readonly drainTimeoutMs?: number | undefined;
};
```

Add to `ResolvedServiceDeps`: `readonly systemctl: LaunchctlRunner; readonly systemdUserDir: string;` and to `resolveServiceDeps`:

```typescript
    systemctl: deps.systemctl ?? spawnSystemctl,
    systemdUserDir: deps.systemdUserDir ??
      join(
        process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"),
        "systemd",
        "user",
      ),
```

Add the real runner next to `spawnLaunchctl`:

```typescript
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
```

Replace the `probeServiceState` platform gate with a two-branch body:

```typescript
export async function probeServiceState(
  vaultPath: string,
  deps: ServiceDeps = {},
): Promise<ServiceState> {
  const d = resolveServiceDeps(deps);

  if (d.platform === "linux") {
    const label = serviceUnitNameForVault(resolve(vaultPath));
    const unitPath = join(d.systemdUserDir, label);
    const installed = existsSync(unitPath);
    let loaded: boolean | null = null;
    if (installed) {
      const probe = await d.systemctl(["is-active", label]);
      loaded = probe.exitCode === 0;
    }
    return Object.freeze({ supported: true, label, plist: unitPath, installed, loaded });
  }

  if (d.platform !== "darwin") return Object.freeze({ supported: false });
  // ... existing darwin body unchanged ...
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/cli/install-systemd.test.ts tests/cli/install.test.ts`
Expected: PASS (new linux tests + all existing launchd tests untouched).

- [ ] **Step 5: Commit**

```bash
git add src/surface/service-probe.ts tests/cli/install-systemd.test.ts
git commit -m "feat(surface): systemctl deps boundary + linux probeServiceState"
```

---

### Task 3: install/uninstall/restart dispatch to systemd on Linux

**Files:**
- Modify: `src/cli/commands/install.ts`
- Modify: `src/cli/commands/install-systemd.ts`
- Test: `tests/cli/install-systemd.test.ts` (extend)

- [ ] **Step 1: Write the failing test** (append; reuse `fakeSystemctl` and the `vaultDir` pattern from `tests/cli/install.test.ts` — copy that helper into this file):

```typescript
import { runInstall, runRestart, runUninstall } from "../../src/cli/commands/install";
import { initRepo } from "../../src/git";

async function vaultDir(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dome-systemd-vault-"));
  await initRepo(dir);
  await mkdir(join(dir, ".dome"), { recursive: true });
  await writeFile(join(dir, ".dome", "config.yaml"), "extensions: {}\n", "utf8");
  return dir;
}

const LINUX_DEPS = (userDir: string, ctl: FakeRunner) => ({
  platform: "linux" as const,
  systemdUserDir: userDir,
  systemctl: ctl.runner,
  bunPath: "/usr/bin/bun",
  domeBin: "/opt/dome/bin/dome",
});

describe("dome install on linux", () => {
  test("writes the unit, daemon-reloads, enables, restarts; exit 0", async () => {
    const vault = await vaultDir();
    const userDir = mkdtempSync(join(tmpdir(), "dome-systemd-user-"));
    const ctl = fakeSystemctl();

    const code = await runInstall({ vault }, LINUX_DEPS(userDir, ctl));
    expect(code).toBe(0);

    const unit = serviceUnitNameForVault(vault);
    expect(existsSync(join(userDir, unit))).toBe(true);
    expect(ctl.calls).toEqual([
      ["daemon-reload"],
      ["enable", unit],
      ["restart", unit],
    ]);
  });

  test("enable failure reports error and exits 1", async () => {
    const vault = await vaultDir();
    const userDir = mkdtempSync(join(tmpdir(), "dome-systemd-user-"));
    const ctl = fakeSystemctl({ enable: { exitCode: 1, stdout: "", stderr: "Failed to enable" } });
    expect(await runInstall({ vault }, LINUX_DEPS(userDir, ctl))).toBe(1);
  });

  test("refuses an uninitialized vault with exit 64", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dome-not-a-vault-"));
    const userDir = mkdtempSync(join(tmpdir(), "dome-systemd-user-"));
    expect(await runInstall({ vault: dir }, LINUX_DEPS(userDir, fakeSystemctl()))).toBe(64);
  });
});

describe("dome uninstall on linux", () => {
  test("disables, removes the unit, daemon-reloads; idempotent when absent", async () => {
    const vault = await vaultDir();
    const userDir = mkdtempSync(join(tmpdir(), "dome-systemd-user-"));
    const ctl = fakeSystemctl();
    expect(await runInstall({ vault }, LINUX_DEPS(userDir, ctl))).toBe(0);

    const ctl2 = fakeSystemctl();
    expect(await runUninstall({ vault }, LINUX_DEPS(userDir, ctl2))).toBe(0);
    const unit = serviceUnitNameForVault(vault);
    expect(existsSync(join(userDir, unit))).toBe(false);
    expect(ctl2.calls).toEqual([["disable", "--now", unit], ["daemon-reload"]]);

    // Second uninstall: clean no-op, still exit 0.
    expect(await runUninstall({ vault }, LINUX_DEPS(userDir, fakeSystemctl()))).toBe(0);
  });
});

describe("dome restart on linux", () => {
  test("restarts from the existing unit; exit 64 when not installed", async () => {
    const vault = await vaultDir();
    const userDir = mkdtempSync(join(tmpdir(), "dome-systemd-user-"));
    expect(await runRestart({ vault }, LINUX_DEPS(userDir, fakeSystemctl()))).toBe(64);

    expect(await runInstall({ vault }, LINUX_DEPS(userDir, fakeSystemctl()))).toBe(0);
    const ctl = fakeSystemctl();
    expect(await runRestart({ vault }, LINUX_DEPS(userDir, ctl))).toBe(0);
    expect(ctl.calls).toEqual([["restart", serviceUnitNameForVault(vault)]]);
  });
});

describe("unsupported platform", () => {
  test("win32 refuses with exit 1", async () => {
    const vault = await vaultDir();
    expect(await runInstall({ vault }, { platform: "win32" })).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/cli/install-systemd.test.ts`
Expected: FAIL — linux currently refused by `refuseUnsupportedHost` (exit 1, not the expected behavior).

- [ ] **Step 3: Implement**

In `src/cli/commands/install.ts`:

1. Export the two shared helpers (change `function` → `export function` / `async function` → `export async function`): `resolveServiceEnvironment`, and extract the vault precondition into:

```typescript
/** Null when the path is an initialized vault; otherwise the refusal text. */
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
```

(and replace the inline check in the darwin `runInstall` body with a call to it).

2. Update the refusal message and gate:

```typescript
const unsupportedMessage = (verb: "install" | "uninstall" | "restart"): string =>
  `service ${verb} is supported on macOS (launchd) and Linux (systemd --user); ` +
  `run \`dome serve\` under your own service manager elsewhere`;
```

In `refuseUnsupportedHost`, treat linux as supported and only require a uid on darwin:

```typescript
  const error =
    d.platform !== "darwin" && d.platform !== "linux"
      ? unsupportedMessage(verb)
      : d.platform === "darwin" && d.uid === null
        ? "cannot determine the current uid for the launchd gui domain"
        : null;
```

3. Dispatch at the top of each verb, right after the refusal check:

```typescript
  if (d.platform === "linux") {
    const { runInstallSystemd } = await import("./install-systemd");
    return runInstallSystemd(options, d);
  }
```

(and the analogous `runUninstallSystemd` / `runRestartSystemd` dispatches in `runUninstall` / `runRestart`).

4. In `src/cli/commands/install-systemd.ts`, add the three flows (below the renderer):

```typescript
import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { formatJson } from "../../surface/format";
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
import { resolveVaultPath } from "../../surface/resolve-vault";

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
    console.log(
      json
        ? formatJson({
            schema: "dome.install/v1",
            status: "status",
            vault: vaultPath,
            label: unit,
            unit: unitPath,
            installed,
            loaded: active,
          })
        : `dome install: ${unit} — installed: ${installed ? "yes" : "no"}, active: ${active === null ? "n/a" : active ? "yes" : "no"}`,
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

    for (const args of [["daemon-reload"], ["enable", unit], ["restart", unit]] as const) {
      const result = await d.systemctl([...args]);
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
        return fail(json, "install", vaultPath, unit, unitPath,
          `systemctl --user ${args.join(" ")} failed: ${detail} (unit left at ${unitPath})`);
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
            log: logPath,
            replaced,
          })
        : `dome install: ${replaced ? "replaced" : "installed"} ${unit}\n` +
          `  unit: ${unitPath}\n  log: ${logPath}\n` +
          `  note: run \`loginctl enable-linger $USER\` once so the service survives logout/boot`,
    );
    return 0;
  } catch (e) {
    return fail(json, "install", vaultPath, unit, unitPath,
      e instanceof Error ? e.message : String(e));
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
    if (installed) {
      await d.systemctl(["disable", "--now", unit]); // failure = not loaded; fine
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
          })
        : installed
          ? `dome uninstall: removed ${unit}`
          : `dome uninstall: not installed (no unit at ${unitPath}); nothing to do`,
    );
    return 0;
  } catch (e) {
    return fail(json, "uninstall", vaultPath, unit, unitPath,
      e instanceof Error ? e.message : String(e));
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
    console[json ? "log" : "error"](
      json
        ? formatJson({ schema: "dome.restart/v1", status: "error", vault: vaultPath, label: unit, unit: unitPath, error })
        : `dome restart: ${error}`,
    );
    return EX_USAGE;
  }
  const result = await d.systemctl(["restart", unit]);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    return fail(json, "restart", vaultPath, unit, unitPath, `systemctl --user restart failed: ${detail}`);
  }
  console.log(
    json
      ? formatJson({ schema: "dome.restart/v1", status: "restarted", vault: vaultPath, label: unit, unit: unitPath })
      : `dome restart: restarted ${unit}`,
  );
  return 0;
}

function usage(json: boolean, vault: string, error: string): number {
  if (json) {
    console.log(formatJson({ schema: "dome.install/v1", status: "error", vault, error }));
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
    console.log(formatJson({ schema: `dome.${verb}/v1`, status: "error", vault, label, unit: unitPath, error: message }));
  } else {
    console.error(`dome ${verb}: failed: ${message}`);
  }
  return 1;
}
```

Note: the simple `console.log` human output here (vs. the launchd presenter cards) is deliberate scope control; if the presenter-card shape is desired, mirror `renderServiceCard` from install.ts — but plain lines are acceptable for v1 and keep this file free of presenter imports.

- [ ] **Step 4: Run tests**

Run: `bun test tests/cli/install-systemd.test.ts tests/cli/install.test.ts tests/cli/serve.test.ts`
Expected: PASS. The existing `install.test.ts` "refuses non-darwin platform" test (if it asserts linux refusal) must be updated to use `win32` — check it and adjust that one assertion.

- [ ] **Step 5: Update the CLI description** in `src/cli/index.ts` (`.command("install")` block):

```typescript
    .description("Install dome serve as a background service (launchd on macOS, systemd --user on Linux).")
```

- [ ] **Step 6: Run the full CLI test slice + commit**

Run: `bun test tests/cli tests/integration/cli-shell-shape.test.ts`
Expected: PASS (if cli-shell-shape pins the install description string, update it there too).

```bash
git add src/cli/commands/install.ts src/cli/commands/install-systemd.ts src/cli/index.ts tests/cli/install-systemd.test.ts tests/cli/install.test.ts
git commit -m "feat(cli): dome install/uninstall/restart dispatch to systemd --user on Linux"
```

---

### Task 4: `dome today` — the cockpit CLI verb

**Files:**
- Create: `src/cli/commands/today.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/cli/commands/today.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/cli/commands/today.test.ts
// `dome today` — CLI wrapper over the dome.daily.today view. Hermetic:
// real temp vault, real sync, captured console (pattern from tests/http).

import { afterAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../../../src/cli/commands/init";
import { runSync } from "../../../src/cli/commands/sync";
import { runToday } from "../../../src/cli/commands/today";
import { add, commit } from "../../../src/git";

let logs: string[] = [];
let errors: string[] = [];
const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  logs = [];
  errors = [];
  console.log = (...p: unknown[]) => { logs.push(p.map(String).join(" ")); };
  console.error = (...p: unknown[]) => { errors.push(p.map(String).join(" ")); };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

function localDateString(date: Date = new Date()): string {
  const yyyy = String(date.getFullYear()).padStart(4, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

let vault: string | null = null;

async function fixtureVault(): Promise<string> {
  if (vault !== null) return vault;
  vault = mkdtempSync(join(tmpdir(), "dome-today-vault-"));
  expect(await runInit({ path: vault })).toBe(0);
  const TODAY = localDateString();
  await mkdir(join(vault, "wiki", "dailies"), { recursive: true });
  await writeFile(
    join(vault, "wiki", "dailies", `${TODAY}.md`),
    `# ${TODAY}\n\n## Tasks\n\n- [ ] review the cockpit plan\n`,
    "utf8",
  );
  await add(vault, `wiki/dailies/${TODAY}.md`);
  await commit({ path: vault, message: "seed daily" });
  expect(await runSync({ vault, quiet: true })).toBe(0);
  return vault;
}

afterAll(async () => {
  if (vault !== null) await rm(vault, { recursive: true, force: true });
});

describe("dome today", () => {
  test("renders the open-task surface", async () => {
    const v = await fixtureVault();
    logs = [];
    expect(await runToday({ vault: v })).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("review the cockpit plan");
  }, 120_000);

  test("--json emits the dome.daily.today/v1 document", async () => {
    const v = await fixtureVault();
    logs = [];
    expect(await runToday({ vault: v, json: true })).toBe(0);
    const doc = JSON.parse(logs.join("\n"));
    expect(doc.schema).toBe("dome.daily.today/v1");
    expect(Array.isArray(doc.openTasks)).toBe(true);
  }, 120_000);

  test("--watch with --json is a usage error", async () => {
    expect(await runToday({ vault: await fixtureVault(), json: true, watch: true })).toBe(64);
  }, 120_000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/cli/commands/today.test.ts`
Expected: FAIL — `src/cli/commands/today.ts` does not exist.

- [ ] **Step 3: Implement** `src/cli/commands/today.ts` (render-only first; `--watch` is Task 5 but the option is accepted now so the usage-error test passes):

```typescript
// cli/commands/today: the cockpit — `dome today [--watch]`.
//
// A typed wrapper around the command-triggered view-phase processor named
// `today` (dome.daily bundle), exactly the `dome query` posture: the
// processor owns the action surface; this file owns CLI ergonomics and
// rendering. `--watch` re-renders on an interval (v1 cockpit: dumb polling,
// per the v1 plan's open-questions resolution).

import { basename } from "node:path";

import {
  firstPartyViewNotFoundMessage,
  runStructuredViewCommand,
  structuredViewBrokerMessages,
} from "../../surface/view";
import { FIRST_PARTY_VIEWS } from "../../surface/view-catalog";
import { printViewCommandError, printViewCommandMessages } from "./view-shared";
import { formatJson } from "../../surface/format";
import { footer, headline, kv, paint, resolveCaps, section, type Caps } from "../presenter";
import { resolveVaultPath } from "../../surface/resolve-vault";
import { EX_USAGE } from "../exit-codes";

export type TodayCommandOptions = {
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly date?: string | undefined;
  readonly limit?: number | undefined;
  readonly json?: boolean | undefined;
  readonly watch?: boolean | undefined;
  /** Watch re-render interval in seconds (default 5, min 1). */
  readonly interval?: number | undefined;
};

/** Injectable watch-loop boundaries (tests). */
export type WatchDeps = {
  readonly sleep?: (ms: number) => Promise<void>;
  /** Stop after N renders (tests); default: until SIGINT. */
  readonly iterations?: number;
  readonly clearScreen?: () => void;
};

export async function runToday(
  options: TodayCommandOptions = {},
  watchDeps: WatchDeps = {},
): Promise<number> {
  if (options.watch === true && options.json === true) {
    printViewCommandError({
      commandLabel: "dome today",
      json: true,
      error: "today-usage",
      messages: ["dome today: --watch and --json are mutually exclusive."],
    });
    return EX_USAGE;
  }
  if (options.watch === true) return watchLoop(options, watchDeps);

  const render = await renderTodayOnce(options);
  if (render.kind === "error") return render.exitCode;
  console.log(render.text);
  return 0;
}

type RenderOutcome =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "error"; readonly exitCode: number };

async function renderTodayOnce(
  options: TodayCommandOptions,
): Promise<RenderOutcome> {
  const vaultPath = resolveVaultPath(options.vault);
  try {
    const run = await runStructuredViewCommand({
      commandLabel: "dome today",
      commandName: FIRST_PARTY_VIEWS.today.command,
      expectedViewName: FIRST_PARTY_VIEWS.today.viewName,
      expectedSchema: FIRST_PARTY_VIEWS.today.schema,
      commandArgs: Object.freeze({
        ...(options.date !== undefined ? { date: options.date } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      }),
      vault: options.vault,
      bundlesRoot: options.bundlesRoot,
      notFoundMessage: firstPartyViewNotFoundMessage({
        commandLabel: "dome today",
        bundleId: FIRST_PARTY_VIEWS.today.bundleId,
        processorName: FIRST_PARTY_VIEWS.today.processorName,
      }),
      noStructuredResultMessage:
        "dome today: today processor returned no structured result.",
    });
    if (run.kind === "error") {
      printViewCommandError({
        commandLabel: "dome today",
        json: options.json === true,
        messages: run.messages,
      });
      return { kind: "error", exitCode: run.exitCode };
    }
    printViewCommandMessages(
      structuredViewBrokerMessages("dome today", run.brokerDiagnostics),
    );
    if (options.json === true) {
      return { kind: "ok", text: formatJson(run.data) };
    }
    return {
      kind: "ok",
      text: formatTodayResult(run.data, resolveCaps(), vaultPath),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    printViewCommandError({
      commandLabel: "dome today",
      json: options.json === true,
      error: "today-failed",
      messages: [`dome today: failed: ${msg}`],
    });
    return { kind: "error", exitCode: 1 };
  }
}

// ----- watch loop (Task 5 wires the real loop; see below) --------------------

async function watchLoop(
  options: TodayCommandOptions,
  deps: WatchDeps,
): Promise<number> {
  const intervalMs = Math.max(1, options.interval ?? 5) * 1000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clear = deps.clearScreen ?? (() => { process.stdout.write("\x1b[2J\x1b[H"); });

  let stopped = false;
  const stop = () => { stopped = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let last: string | null = null;
  let renders = 0;
  try {
    for (;;) {
      const render = await renderTodayOnce(options);
      renders += 1;
      if (render.kind === "error") return render.exitCode;
      if (render.text !== last) {
        clear();
        console.log(render.text);
        console.log(
          paint(`(watch: refreshes every ${intervalMs / 1000}s — ctrl-c to exit)`, "muted", resolveCaps()),
        );
        last = render.text;
      }
      if (deps.iterations !== undefined && renders >= deps.iterations) return 0;
      if (stopped) return 0;
      await sleep(intervalMs);
      if (stopped) return 0;
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

// ----- rendering --------------------------------------------------------------

type TodayTaskRow = {
  readonly text: string;
  readonly path: string;
  readonly line: number | null;
  readonly dueDate: string | null;
  readonly followup: boolean;
};

type TodayQuestionRow = {
  readonly id: number;
  readonly question: string;
  readonly resolveCommand: string;
};

function formatTodayResult(data: unknown, caps: Caps, vault: string): string {
  const record = isRecord(data) ? data : {};
  const date = typeof record.date === "string" ? record.date : "today";
  const openTasks = parseTaskRows(record.openTasks);
  const followups = parseTaskRows(record.followups);
  const questions = parseQuestionRows(record.questions);
  const counts = isRecord(record.counts) ? record.counts : {};
  const total =
    (numberOr(counts.openTasks, openTasks.length)) +
    (numberOr(counts.followups, followups.length)) +
    (numberOr(counts.questions, questions.length));

  const lines: string[] = [
    headline(
      { cmd: "today", context: basename(vault) },
      total === 0
        ? { tone: "ok", label: "all clear" }
        : { tone: "ok", label: `${total} open` },
      caps,
    ),
  ];
  lines.push(
    ...section(
      "Day",
      kv([{ label: "date", value: date, tone: "plain" }], caps),
      caps,
    ),
  );
  if (openTasks.length > 0) {
    lines.push(...section("Open tasks", openTasks.map((t) => taskLine(t, caps)), caps));
  }
  if (followups.length > 0) {
    lines.push(...section("Follow-ups", followups.map((t) => taskLine(t, caps)), caps));
  }
  if (questions.length > 0) {
    lines.push(
      ...section(
        "Questions",
        questions.flatMap((q) => [
          `[#${q.id}] ${q.question}`,
          `   ${paint("resolve:", "muted", caps)} ${q.resolveCommand}`,
        ]),
        caps,
      ),
    );
  }
  lines.push(...footer(
    total === 0 ? { tone: "ok", label: "all clear" } : { tone: "ok", label: `${total} open` },
    caps,
  ));
  return lines.join("\n");
}

function taskLine(t: TodayTaskRow, caps: Caps): string {
  const where = t.line === null ? t.path : `${t.path}:${t.line}`;
  const due = t.dueDate === null ? "" : ` ${paint(`due ${t.dueDate}`, "muted", caps)}`;
  return `- [ ] ${t.text}${due}  ${paint(where, "muted", caps)}`;
}

function parseTaskRows(raw: unknown): ReadonlyArray<TodayTaskRow> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const r = isRecord(item) ? item : {};
      const text = typeof r.text === "string" ? r.text : "";
      if (text.length === 0) return null;
      return Object.freeze({
        text,
        path: typeof r.path === "string" ? r.path : "",
        line: typeof r.line === "number" ? r.line : null,
        dueDate: typeof r.dueDate === "string" ? r.dueDate : null,
        followup: r.followup === true,
      });
    })
    .filter((row): row is TodayTaskRow => row !== null);
}

function parseQuestionRows(raw: unknown): ReadonlyArray<TodayQuestionRow> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const r = isRecord(item) ? item : {};
      const question = typeof r.question === "string" ? r.question : "";
      if (question.length === 0) return null;
      return Object.freeze({
        id: typeof r.id === "number" ? r.id : 0,
        question,
        resolveCommand: typeof r.resolveCommand === "string"
          ? r.resolveCommand
          : `dome resolve <id> <value>`,
      });
    })
    .filter((row): row is TodayQuestionRow => row !== null);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
```

Check the actual `DailyQuestionItem` shape in `assets/extensions/dome.daily/processors/action-state.ts` while implementing — if its rows expose different field names (e.g. `resolveCommand` is absent), adjust `parseQuestionRows` to the real fields; the parser is deliberately tolerant so this is a rendering-fidelity concern, not a correctness one.

- [ ] **Step 4: Register the command** in `src/cli/index.ts` (after the `query` block; reuse `parsePositiveIntegerOption`):

```typescript
  program
    .command("today")
    .description("Render today's action surface (open tasks, follow-ups, questions).")
    .option("--date <yyyy-mm-dd>", "Render a specific day (default: today).")
    .option("--limit <n>", "Max rows per section.", parsePositiveIntegerOption)
    .option("--watch", "Re-render on an interval until ctrl-c (the cockpit).")
    .option("--interval <seconds>", "Watch refresh interval (default 5).", parsePositiveIntegerOption)
    .option("--json", "Emit JSON.")
    .option("--vault <path>", "Vault path (defaults to current directory).")
    .option("--bundles-root <path>", "Extension bundles root.")
    .action(async (options: TodayCliOptions) => {
      const { runToday } = await import("./commands/today");
      setExitCode(
        await runToday({
          vault: options.vault,
          bundlesRoot: options.bundlesRoot,
          date: options.date,
          limit: options.limit,
          json: options.json,
          watch: options.watch,
          interval: options.interval,
        }),
      );
    });
```

And the options type with the others at the bottom of the file:

```typescript
type TodayCliOptions = {
  readonly date?: string;
  readonly limit?: number;
  readonly watch?: boolean;
  readonly interval?: number;
  readonly json?: boolean;
  readonly vault?: string;
  readonly bundlesRoot?: string;
};
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/cli/commands/today.test.ts tests/integration/cli-shell-shape.test.ts`
Expected: today tests PASS; if cli-shell-shape fails on the new command, add `today` to its pinned inventory (read that test's expectations and extend them — it exists precisely to force this conscious step).

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/today.ts src/cli/index.ts tests/cli/commands/today.test.ts tests/integration/cli-shell-shape.test.ts
git commit -m "feat(cli): dome today — the cockpit view verb (render + json)"
```

---

### Task 5: `dome today --watch` loop behavior

**Files:**
- Modify: `src/cli/commands/today.ts` (already implemented in Task 4 — this task pins behavior with tests)
- Test: `tests/cli/commands/today.test.ts` (extend)

- [ ] **Step 1: Write the failing/behavior test** (append):

```typescript
describe("dome today --watch", () => {
  test("renders, then skips re-print when output is unchanged", async () => {
    const v = await fixtureVault();
    logs = [];
    let clears = 0;
    const sleeps: number[] = [];
    const code = await runToday(
      { vault: v, watch: true, interval: 1 },
      {
        iterations: 3,
        sleep: async (ms) => { sleeps.push(ms); },
        clearScreen: () => { clears += 1; },
      },
    );
    expect(code).toBe(0);
    // Three renders, identical output → exactly one clear+print cycle.
    expect(clears).toBe(1);
    expect(sleeps).toEqual([1000, 1000]);
    expect(logs.join("\n")).toContain("review the cockpit plan");
  }, 120_000);
});
```

- [ ] **Step 2: Run** `bun test tests/cli/commands/today.test.ts`
Expected: PASS if Task 4's `watchLoop` is correct; if the clear/sleep counts differ, fix `watchLoop` (the contract: render → print only on change → honor `iterations` → sleep between renders, not after the last).

- [ ] **Step 3: Commit**

```bash
git add tests/cli/commands/today.test.ts src/cli/commands/today.ts
git commit -m "test(cli): pin dome today --watch render/clear/sleep contract"
```

---

### Task 6: today HTML renderer (pure)

**Files:**
- Create: `src/http/today-html.ts`
- Test: `tests/http/today-html.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/http/today-html.test.ts
import { describe, expect, test } from "bun:test";

import { renderTodayHtml } from "../../src/http/today-html";

const DATA = {
  schema: "dome.daily.today/v1",
  date: "2026-06-11",
  counts: { openTasks: 1, followups: 0, questions: 1 },
  openTasks: [
    { text: "ship <the> cockpit", path: "wiki/dailies/2026-06-11.md", line: 5, dueDate: null, followup: false },
  ],
  followups: [],
  questions: [
    { id: 7, question: "Merge A into B?", resolveCommand: "dome resolve 7 yes" },
  ],
};

describe("renderTodayHtml", () => {
  test("renders sections, escapes HTML, includes meta refresh", () => {
    const html = renderTodayHtml(DATA, { refreshSeconds: 15 });
    expect(html).toContain('<meta http-equiv="refresh" content="15">');
    expect(html).toContain("ship &lt;the&gt; cockpit");      // escaped
    expect(html).toContain("2026-06-11");
    expect(html).toContain("Merge A into B?");
    expect(html).toContain("dome resolve 7 yes");
    expect(html).not.toContain("<the>");                      // no raw injection
  });

  test("tolerates malformed data with an empty-state page", () => {
    const html = renderTodayHtml(null, { refreshSeconds: 15 });
    expect(html).toContain("All clear");
  });
});
```

- [ ] **Step 2: Run** `bun test tests/http/today-html.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `src/http/today-html.ts`:

```typescript
// http/today-html: pure renderer — dome.daily.today/v1 structured data →
// a self-refreshing HTML cockpit page. No imports from the engine; consumed
// only by the HTTP adapter's GET /today route. Auto-refresh is a plain
// meta-refresh (the v1 plan's "dumb polling is acceptable" resolution); the
// page reloads its own URL, so a ?token= query parameter survives reloads.

export type TodayHtmlOptions = {
  readonly refreshSeconds: number;
};

export function renderTodayHtml(data: unknown, opts: TodayHtmlOptions): string {
  const record = isRecord(data) ? data : {};
  const date = typeof record.date === "string" ? esc(record.date) : "today";
  const openTasks = rows(record.openTasks);
  const followups = rows(record.followups);
  const questions = questionRows(record.questions);
  const total = openTasks.length + followups.length + questions.length;

  const body = total === 0
    ? `<p class="clear">All clear — nothing open.</p>`
    : [
        sectionHtml("Open tasks", openTasks.map(taskHtml)),
        sectionHtml("Follow-ups", followups.map(taskHtml)),
        sectionHtml(
          "Questions",
          questions.map(
            (q) =>
              `<li><span class="qid">#${q.id}</span> ${esc(q.question)}` +
              `<br><code>${esc(q.resolveCommand)}</code></li>`,
          ),
        ),
      ].join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="${Math.max(1, Math.floor(opts.refreshSeconds))}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dome today — ${date}</title>
<style>
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; margin: 1.5rem auto; max-width: 42rem; padding: 0 1rem; background: #111; color: #eee; }
  h1 { font-size: 1.2rem; } h2 { font-size: 1rem; margin-top: 1.5rem; color: #9ad; }
  ul { padding-left: 1.2rem; } li { margin: .4rem 0; }
  code { background: #222; padding: .1rem .3rem; border-radius: 4px; font-size: .85em; }
  .muted { color: #888; font-size: .85em; } .qid { color: #fa6; }
  .clear { color: #6c6; font-size: 1.1rem; }
</style>
</head>
<body>
<h1>dome today <span class="muted">${date} · ${total} open</span></h1>
${body}
<p class="muted">auto-refreshes every ${Math.max(1, Math.floor(opts.refreshSeconds))}s</p>
</body>
</html>
`;
}

type TaskRow = {
  readonly text: string;
  readonly path: string;
  readonly line: number | null;
  readonly dueDate: string | null;
};
type QuestionRow = { readonly id: number; readonly question: string; readonly resolveCommand: string };

function sectionHtml(title: string, items: ReadonlyArray<string>): string {
  if (items.length === 0) return "";
  return `<h2>${esc(title)} (${items.length})</h2>\n<ul>\n${items.join("\n")}\n</ul>`;
}

function taskHtml(t: TaskRow): string {
  const where = t.line === null ? t.path : `${t.path}:${t.line}`;
  const due = t.dueDate === null ? "" : ` <span class="muted">due ${esc(t.dueDate)}</span>`;
  return `<li>${esc(t.text)}${due} <span class="muted">${esc(where)}</span></li>`;
}

function rows(raw: unknown): ReadonlyArray<TaskRow> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const r = isRecord(item) ? item : {};
    const text = typeof r.text === "string" ? r.text : "";
    if (text.length === 0) return [];
    return [{
      text,
      path: typeof r.path === "string" ? r.path : "",
      line: typeof r.line === "number" ? r.line : null,
      dueDate: typeof r.dueDate === "string" ? r.dueDate : null,
    }];
  });
}

function questionRows(raw: unknown): ReadonlyArray<QuestionRow> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const r = isRecord(item) ? item : {};
    const question = typeof r.question === "string" ? r.question : "";
    if (question.length === 0) return [];
    return [{
      id: typeof r.id === "number" ? r.id : 0,
      question,
      resolveCommand: typeof r.resolveCommand === "string" ? r.resolveCommand : "dome resolve <id> <value>",
    }];
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
```

- [ ] **Step 4: Run** `bun test tests/http/today-html.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http/today-html.ts tests/http/today-html.test.ts
git commit -m "feat(http): pure today→HTML cockpit renderer"
```

---

### Task 7: `GET /today` route with query-param token

**Files:**
- Modify: `src/http/server.ts`
- Test: `tests/http/http-server.test.ts` (extend)

**Design note (record in the spec in Task 9):** browsers cannot attach an `Authorization` header to a plain navigation, so `GET /today` — and only that route — additionally accepts `?token=<bearer>` compared against the same digest in constant time. The trust domain is unchanged (loopback/Tailscale); the tradeoff is the token appearing in the URL bar and server logs of *your own daemon*. Every other route remains header-only.

- [ ] **Step 1: Write the failing tests** (append to `tests/http/http-server.test.ts`):

```typescript
describe("GET /today", () => {
  test("renders the HTML cockpit with bearer header", async () => {
    const f = await fixture();
    const res = await fetch(`${f.baseUrl}/today`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("ship the http surface");
    expect(html).toContain('http-equiv="refresh"');
  }, TEST_TIMEOUT_MS);

  test("accepts ?token= on /today only", async () => {
    const f = await fixture();
    const ok = await fetch(`${f.baseUrl}/today?token=${TOKEN}`);
    expect(ok.status).toBe(200);

    const wrong = await fetch(`${f.baseUrl}/today?token=nope`);
    expect(wrong.status).toBe(401);

    // Query-param token must NOT authorize other routes.
    const other = await fetch(`${f.baseUrl}/tasks?token=${TOKEN}`);
    expect(other.status).toBe(401);
  }, TEST_TIMEOUT_MS);

  test("honors ?refresh= seconds", async () => {
    const f = await fixture();
    const res = await fetch(`${f.baseUrl}/today?token=${TOKEN}&refresh=30`);
    expect(await res.text()).toContain('content="30"');
  }, TEST_TIMEOUT_MS);
});
```

- [ ] **Step 2: Run** `bun test tests/http/http-server.test.ts` — Expected: FAIL (404 / 401).

- [ ] **Step 3: Implement** in `src/http/server.ts`:

1. Import the renderer and the today catalog entry is already imported via `FIRST_PARTY_VIEWS`:

```typescript
import { renderTodayHtml } from "./today-html";
```

2. Add the route inside `routes` (next to `GET /tasks`):

```typescript
      case "GET /today": {
        const refresh = positiveInt(url.searchParams.get("refresh")) ?? 15;
        const outcome = await withVaultShared({ path: vault, bundlesRoot }, (v) =>
          runCatalogView(v, FIRST_PARTY_VIEWS.today, Object.freeze({})),
        );
        if (outcome.kind === "open-failed") {
          return commandErrorResponse("GET /today", openVaultErrorKind(outcome.error));
        }
        const run = outcome.value;
        if (run.kind === "problem") {
          return errorResponse(
            viewProblemHttpStatus(run.problem),
            run.problem.kind,
            catalogViewProblemMessage("GET /today", FIRST_PARTY_VIEWS.today, run.problem),
          );
        }
        return new Response(renderTodayHtml(run.data, { refreshSeconds: refresh }), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
```

3. Extend the auth gate in `handle` — replace the single `authorized(...)` call:

```typescript
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (!authorized(request, tokenDigest) && !queryTokenAuthorized(request, url, tokenDigest)) {
      return errorResponse(401, "unauthorized", "missing or invalid bearer token.");
    }
    try {
      return await enqueue(() => routes(request));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResponse(500, "internal", msg);
    }
  };
```

and add next to `authorized`:

```typescript
/**
 * Browser-navigation escape hatch for the HTML cockpit ONLY: `GET /today`
 * may carry the bearer as `?token=` (browsers cannot set Authorization on a
 * plain navigation). Same digest, same constant-time comparison; every
 * other route stays header-only.
 */
function queryTokenAuthorized(
  request: Request,
  url: URL,
  tokenDigest: Buffer,
): boolean {
  if (request.method !== "GET" || url.pathname !== "/today") return false;
  const token = url.searchParams.get("token");
  if (token === null || token.length === 0) return false;
  return timingSafeEqual(sha256(token), tokenDigest);
}
```

(`routes` already constructs its own `URL`; leaving that as-is is fine, or pass the one from `handle` through — either way, keep the change minimal.)

- [ ] **Step 4: Run** `bun test tests/http` — Expected: PASS (new + existing routes).

- [ ] **Step 5: Commit**

```bash
git add src/http/server.ts tests/http/http-server.test.ts
git commit -m "feat(http): GET /today HTML cockpit with scoped query-token auth"
```

---

### Task 8: `dome recipe ios`

**Files:**
- Create: `src/cli/commands/recipe.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/cli/commands/recipe.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/cli/commands/recipe.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runRecipe } from "../../../src/cli/commands/recipe";

let logs: string[] = [];
let errors: string[] = [];
const origLog = console.log;
const origErr = console.error;
beforeEach(() => {
  logs = []; errors = [];
  console.log = (...p: unknown[]) => { logs.push(p.map(String).join(" ")); };
  console.error = (...p: unknown[]) => { errors.push(p.map(String).join(" ")); };
});
afterEach(() => { console.log = origLog; console.error = origErr; });

describe("dome recipe ios", () => {
  test("prints Shortcut steps targeting the capture endpoint", async () => {
    expect(await runRecipe({ kind: "ios", url: "http://dome-server:3663" })).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("POST");
    expect(out).toContain("http://dome-server:3663/capture");
    expect(out).toContain("Authorization");
    expect(out).toContain("Dictate Text");
    expect(out).toContain("curl");                 // the verification step
    expect(out).toContain("/today?token=");        // the cockpit pointer
  });

  test("defaults the base URL to the default port", async () => {
    expect(await runRecipe({ kind: "ios" })).toBe(0);
    expect(logs.join("\n")).toContain(":3663/capture");
  });

  test("unknown kind is a usage error", async () => {
    expect(await runRecipe({ kind: "android" })).toBe(64);
    expect(errors.join("\n")).toContain("unknown recipe");
  });
});
```

- [ ] **Step 2: Run** `bun test tests/cli/commands/recipe.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `src/cli/commands/recipe.ts`:

```typescript
// cli/commands/recipe: `dome recipe <kind>` — client setup recipes.
//
// v1 ships one recipe: `ios` — the iOS Shortcut that voice-captures into
// POST /capture (the WS3-capture deliverable of the v1 plan). The recipe is
// plain text by design: it changes when the HTTP surface changes, so it
// lives next to the CLI rather than in a doc that can drift.

import { EX_USAGE } from "../exit-codes";

export type RecipeOptions = {
  readonly kind: string;
  /** Base URL of the dome http server (default http://<your-server>:3663). */
  readonly url?: string | undefined;
};

export async function runRecipe(options: RecipeOptions): Promise<number> {
  if (options.kind !== "ios") {
    console.error(
      `dome recipe: unknown recipe '${options.kind}' (available: ios)`,
    );
    return EX_USAGE;
  }
  const base = (options.url ?? "http://<your-server>:3663").replace(/\/+$/, "");
  console.log(iosRecipe(base));
  return 0;
}

function iosRecipe(base: string): string {
  return `dome recipe: iOS voice capture → ${base}/capture

Prerequisites
  1. The dome http surface is running on your server:
       DOME_HTTP_TOKEN=<token> dome http --vault <vault> --host 0.0.0.0
     (bind a Tailscale interface, never a public one — see
      docs/wiki/specs/http-surface.md "Trust domain")
  2. Your phone is on the same Tailscale network.

Build the Shortcut (Shortcuts app → + → rename to "Dome Capture")
  1. Add action: "Dictate Text"
  2. Add action: "Get Contents of URL"
       URL:     ${base}/capture
       Method:  POST
       Headers: Authorization → Bearer <token>
       Request Body: JSON
         text      → Dictated Text   (the variable from step 1)
         captureId → Shortcut Input? No — add a "UUID" action before this
                     step and bind captureId → UUID (makes retries idempotent)
  3. Add action: "Show Notification" → "Captured ✓"
  4. (Optional) Settings → Action Button → assign "Dome Capture".
     The same Shortcut works from the Apple Watch Shortcuts complication.

Verify from any shell on the Tailscale network
  curl -s -X POST ${base}/capture \\
    -H "Authorization: Bearer <token>" \\
    -H "content-type: application/json" \\
    -d '{"text":"recipe smoke test","captureId":"recipe-test-1"}'
  → {"status":"captured", ...}   (compile_pending until the daemon adopts)

The cockpit
  Open ${base}/today?token=<token> on any device in the trust domain for the
  self-refreshing today view (add it to the iPhone home screen via Safari →
  Share → Add to Home Screen).
`;
}
```

- [ ] **Step 4: Register** in `src/cli/index.ts`:

```typescript
  program
    .command("recipe <kind>")
    .description("Print a client setup recipe (available: ios — voice capture via Shortcuts).")
    .option("--url <base>", "Base URL of your dome http server (default http://<your-server>:3663).")
    .action(async (kind: string, options: { readonly url?: string }) => {
      const { runRecipe } = await import("./commands/recipe");
      setExitCode(await runRecipe({ kind, url: options.url }));
    });
```

- [ ] **Step 5: Run** `bun test tests/cli/commands/recipe.test.ts tests/integration/cli-shell-shape.test.ts` — Expected: PASS (extend cli-shell-shape's inventory with `recipe` if pinned).

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/recipe.ts src/cli/index.ts tests/cli/commands/recipe.test.ts tests/integration/cli-shell-shape.test.ts
git commit -m "feat(cli): dome recipe ios — Shortcut voice-capture recipe"
```

---

### Task 9: Normative spec lockstep

**Files:**
- Modify: `docs/wiki/specs/cli.md` — add §"dome today" and §"dome recipe"; update §"dome install" (+ uninstall/restart) for the Linux backend.
- Modify: `docs/wiki/specs/http-surface.md` — add the `GET /today` route row and a §"Query-token escape hatch (GET /today)" paragraph.
- Modify: `docs/wiki/specs/capture.md` — replace the SSH/synced-folder phone recipe with the HTTP Shortcut recipe (pointing at `dome recipe ios`).

- [ ] **Step 1: Read each spec's existing section structure first** (`docs/wiki/specs/cli.md` already has one section per verb — match the house format exactly: contract, options, exit codes, test pointers).

- [ ] **Step 2: Write the sections.** Content requirements (adapt wording to each spec's voice):

For `cli.md` §"dome today": the verb is a typed wrapper over the command-triggered `today` view (`dome.daily.today/v1`); options `--date`, `--limit`, `--json`, `--watch` (mutually exclusive with `--json`, exit 64), `--interval <seconds>` (default 5); watch is poll-based re-render that repaints only on change; tests at `tests/cli/commands/today.test.ts`.

For `cli.md` §"dome recipe": prints client setup text; `ios` is the only v1 kind; unknown kind exits 64; `--url` overrides the base URL; tests at `tests/cli/commands/recipe.test.ts`.

For `cli.md` §"dome install" update: platform dispatch table — darwin → launchd LaunchAgent (existing contract unchanged), linux → systemd user unit `dome-serve-<slug>.service` under `~/.config/systemd/user` (install = write unit → `daemon-reload` → `enable` → `restart`; uninstall = `disable --now` → remove → `daemon-reload`; restart = `restart` from existing unit, exit 64 when absent); other platforms refuse with exit 1; `loginctl enable-linger` is the operator's responsibility (documented in install output and the migration runbook); tests at `tests/cli/install-systemd.test.ts`.

For `http-surface.md`: add `GET /today → dome.daily.today view → text/html (renderTodayHtml)` to the route table; document `?refresh=<seconds>` (default 15); document the query-token rule verbatim: *`GET /today` and only `GET /today` additionally accepts `?token=<bearer>` (constant-time digest comparison) because browser navigations cannot carry an Authorization header; the token appears in the URL — acceptable inside the loopback/Tailscale trust domain, and the reason this escape hatch never widens to other routes.* Tests at `tests/http/http-server.test.ts`.

For `capture.md`: the phone recipe section now reads: dictation → iOS Shortcut → `POST /capture` with `captureId` idempotency; `dome recipe ios` prints the full setup; the SSH/synced-folder paths remain as fallbacks for vaults without the HTTP surface.

- [ ] **Step 3: Run the docs-coupled integration tests**

Run: `bun test tests/integration`
Expected: PASS — in particular `docs-vault-config`, `gotcha-coverage`, `cli-shell-shape`, and any spec-lockstep tests. Fix whatever a lockstep test demands (that is the point of running it here).

- [ ] **Step 4: Commit**

```bash
git add docs/wiki/specs/cli.md docs/wiki/specs/http-surface.md docs/wiki/specs/capture.md
git commit -m "docs(specs): today/recipe verbs, systemd install backend, GET /today route"
```

---

### Task 10: Server migration runbook

**Files:**
- Create: `docs/cohesive/runbooks/2026-06-server-migration.md`

- [ ] **Step 1: Write the runbook** (ops doc — no code, but every command exact):

```markdown
---
type: runbook
tags: [v1, deployment, server]
created: 2026-06-11
status: ready
sources:
  - "[[cohesive/brainstorms/2026-06-11-dome-v1-plan]]"
---

# Runbook — move the Dome daemon from the MacBook to the home server

Decision of record: vault is single-residency on the server; laptop sessions
SSH in. (v1 plan §"Deployment topology", §open-questions "laptop write path".)

## 1. Prepare the server (once)
- Install bun: `curl -fsSL https://bun.sh/install | bash`
- Clone + build dome: `git clone <dome-repo> ~/dome && cd ~/dome && bun install`
- Confirm Tailscale is up: `tailscale status` (note the server's MagicDNS name).
- Allow user services to outlive logins: `loginctl enable-linger $USER`

## 2. Move the vault
- On the laptop: ensure clean state — `dome status` (no pending), then stop the
  old daemon: `dome uninstall --vault ~/vaults/work`
- Push/clone the vault to the server (one-time copy; git history travels):
  `git clone ~/vaults/work` → server `~/vaults/work` (scp/rsync the `.dome/`
  state dirs too — answers.db/runs.db/outbox.db are durable-but-not-rebuildable).
- On the server: `cd ~/vaults/work && ~/dome/bin/dome doctor` — model provider
  + projection probes must pass before installing anything.

## 3. Install the services
- Serve daemon:
  `dome install --vault ~/vaults/work --env ANTHROPIC_API_KEY=<key>`
  → systemd unit `dome-serve-<slug>.service`; check `dome install --status`.
- HTTP surface (manual unit for now — v1 scope cut, see plan):
  `~/.config/systemd/user/dome-http.service`:

      [Unit]
      Description=Dome HTTP surface (work vault)
      After=network.target
      [Service]
      ExecStart=<bun> <dome>/bin/dome http --vault %h/vaults/work --host <tailscale-ip>
      Environment="DOME_HTTP_TOKEN=<token>"
      Restart=always
      [Install]
      WantedBy=default.target

  `systemctl --user daemon-reload && systemctl --user enable --now dome-http`

## 4. Wire the phone
- `dome recipe ios --url http://<server-magicdns>:3663` and follow it.
- Smoke: the curl from the recipe; then open `/today?token=…` and add to
  home screen.

## 5. Switch the laptop workflow
- Daily driver: `ssh <server>` → tmux → Claude Code in `~/vaults/work`.
- Feeding in laptop-local files: `curl POST /capture` or `scp` into `inbox/raw/`.
- Retire the old launchd plist if step 2's uninstall was skipped.

## Rollback
- The laptop vault clone is untouched; `dome install` there restores the old
  topology in one command. Copy back the server's `.dome/` state dirs first.
```

- [ ] **Step 2: Commit**

```bash
git add docs/cohesive/runbooks/2026-06-server-migration.md
git commit -m "docs(runbook): MacBook→home-server migration steps"
```

---

### Task 11: Full-suite verification

- [ ] **Step 1:** Run: `bun test`
Expected: full suite PASS (invariants, integration, processors, CLI, http, mcp).

- [ ] **Step 2:** Run the three new surfaces end-to-end against a scratch vault:

```bash
DIR=$(mktemp -d) && bin/dome init "$DIR" >/dev/null
bin/dome today --vault "$DIR"                       # renders "all clear"
bin/dome recipe ios --url http://example:3663 | head -5
DOME_HTTP_TOKEN=t bin/dome http --vault "$DIR" --port 3970 &
sleep 1 && curl -s "http://127.0.0.1:3970/today?token=t" | grep -c "dome today"
kill %1 && rm -rf "$DIR"
```

Expected: today renders, recipe prints, curl returns ≥1.

- [ ] **Step 3:** Final commit if any fixups; then merge per repo flow (worktree → `<topic>/build` → `--no-ff` merge to main, per the project's branch conventions).

---

## Self-review notes (already applied)

- **Spec coverage:** systemd install (plan WS3 topology prerequisite) → Tasks 1–3; `dome recipe ios` (WS3-capture) → Task 8; cockpit terminal + HTML (WS4) → Tasks 4–7; spec lockstep → Task 9; migration ops → Task 10. The v1 plan's open question "`GET /today` refresh mechanism" is resolved here as meta-refresh polling (the plan explicitly allows it).
- **Known soft spots an executor must verify against reality:** (a) `DailyQuestionItem` field names in `action-state.ts` (Task 4 parser is tolerant; fix rendering to real fields); (b) whether `tests/cli/install.test.ts` asserts linux refusal (Task 3 Step 4); (c) whether `cli-shell-shape.test.ts` pins command inventory/descriptions (Tasks 4, 8); (d) `runStructuredViewCommand`'s exact success-variant name (`kind`) — mirror `query.ts` verbatim. These are listed once here instead of hedged inline.
- **Type consistency:** `LaunchctlRunner`/`LaunchctlResult` deliberately reused for systemctl (same shape, one boundary type); `ServiceState.plist` carries the unit path on Linux (documented in Task 2).
```
