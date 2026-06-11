// tests/cli/install-systemd.test.ts
// systemd backend for `dome install` — same testability contract as
// tests/cli/install.test.ts: every host boundary injected; recording fake
// systemctl; temp dirs; never touches ~/.config or real systemd.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderServeSystemdUnit } from "../../src/cli/commands/install-systemd";
import {
  runInstall,
  runRestart,
  runUninstall,
} from "../../src/cli/commands/install";
import {
  probeServiceState,
  serviceUnitNameForVault,
  vaultServiceSlug,
  type LaunchctlResult,
  type LaunchctlRunner,
} from "../../src/surface/service-probe";
import { initRepo } from "../../src/git";

// ----- Console capture (same shape as tests/cli/install.test.ts) -------------

let logs: string[] = [];
let errors: string[] = [];
const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  logs = [];
  errors = [];
  console.log = (...parts: unknown[]) => {
    logs.push(parts.map((p) => String(p)).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    errors.push(parts.map((p) => String(p)).join(" "));
  };
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

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
    calls.push([...args]);
    const sub = args[0] ?? "";
    return overrides[sub] ?? { exitCode: 0, stdout: "", stderr: "" };
  };
  return { calls, runner };
}

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

describe("probeServiceState on linux", () => {
  test("reports installed+active from the unit file and is-active", async () => {
    const userDir = mkdtempSync(join(tmpdir(), "dome-systemd-user-"));
    const vault = mkdtempSync(join(tmpdir(), "dome-probe-vault-"));
    const unit = serviceUnitNameForVault(vault);
    await writeFile(join(userDir, unit), "[Unit]\n", "utf8");
    const ctl = fakeSystemctl({
      "is-active": { exitCode: 0, stdout: "active\n", stderr: "" },
    });

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
    expect(state).toMatchObject({
      supported: true,
      installed: false,
      loaded: null,
    });
    expect(ctl.calls).toEqual([]);
  });
});

// ----- install/uninstall/restart dispatch on linux ----------------------------

/**
 * Minimal initialized vault: a git repo with `.dome/config.yaml` (same
 * precondition gate as the launchd backend).
 */
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
    const ctl = fakeSystemctl({
      enable: { exitCode: 1, stdout: "", stderr: "Failed to enable" },
    });
    expect(await runInstall({ vault }, LINUX_DEPS(userDir, ctl))).toBe(1);
  });

  test("refuses an uninitialized vault with exit 64", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dome-not-a-vault-"));
    const userDir = mkdtempSync(join(tmpdir(), "dome-systemd-user-"));
    expect(
      await runInstall({ vault: dir }, LINUX_DEPS(userDir, fakeSystemctl())),
    ).toBe(64);
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
    expect(
      await runUninstall({ vault }, LINUX_DEPS(userDir, fakeSystemctl())),
    ).toBe(0);
  });
});

describe("dome restart on linux", () => {
  test("restarts from the existing unit; exit 64 when not installed", async () => {
    const vault = await vaultDir();
    const userDir = mkdtempSync(join(tmpdir(), "dome-systemd-user-"));
    expect(
      await runRestart({ vault }, LINUX_DEPS(userDir, fakeSystemctl())),
    ).toBe(64);

    expect(
      await runInstall({ vault }, LINUX_DEPS(userDir, fakeSystemctl())),
    ).toBe(0);
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
