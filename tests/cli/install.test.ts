// Wedge Phase 1 — tests for `dome install` / `dome uninstall`.
//
// Per docs/wiki/specs/cli.md §"dome install" / §"dome uninstall", these
// commands manage a macOS launchd LaunchAgent around `dome serve`. The
// testability contract is part of the spec: every host boundary (platform,
// uid, LaunchAgents dir, launchctl runner, executable paths) is injected, so
// these tests run against temp dirs and a recording fake runner — they never
// touch `~/Library` and never invoke real `launchctl`, on any platform.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  renderServePlist,
  runInstall,
  runUninstall,
  serviceLabelForVault,
  vaultServiceSlug,
  type LaunchctlResult,
  type LaunchctlRunner,
  type ServiceDeps,
} from "../../src/cli/commands/install";

// ----- Console capture ------------------------------------------------------

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

afterEach(async () => {
  console.log = origLog;
  console.error = origErr;
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

// ----- Fixtures ---------------------------------------------------------------

let tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

type FakeLaunchctl = {
  readonly calls: Array<ReadonlyArray<string>>;
  readonly runner: LaunchctlRunner;
};

/**
 * Recording launchctl fake. By default `bootout` fails like the real tool
 * does when the service isn't loaded, `bootstrap` succeeds, and `print`
 * fails (service not loaded). Per-subcommand exit codes are overridable.
 */
function fakeLaunchctl(
  overrides: Partial<Record<string, LaunchctlResult>> = {},
): FakeLaunchctl {
  const calls: Array<ReadonlyArray<string>> = [];
  const defaults: Record<string, LaunchctlResult> = {
    bootout: { exitCode: 3, stdout: "", stderr: "Boot-out failed: 3: No such process" },
    bootstrap: { exitCode: 0, stdout: "", stderr: "" },
    print: { exitCode: 113, stdout: "", stderr: "Could not find service" },
  };
  const runner: LaunchctlRunner = async (args) => {
    calls.push([...args]);
    const sub = args[0] ?? "";
    return overrides[sub] ?? defaults[sub] ??
      { exitCode: 0, stdout: "", stderr: "" };
  };
  return { calls, runner };
}

function depsFor(
  agentsDir: string,
  launchctl: LaunchctlRunner,
  extra: Partial<ServiceDeps> = {},
): ServiceDeps {
  return {
    platform: "darwin",
    uid: 501,
    launchAgentsDir: agentsDir,
    launchctl,
    bunPath: "/opt/bun/bin/bun",
    domeBin: "/opt/dome/bin/dome",
    ...extra,
  };
}

// ----- Label derivation -------------------------------------------------------

describe("service label derivation", () => {
  test("slug is deterministic and collision-resistant across same-basename vaults", () => {
    const a = "/Users/me/vaults/Work Vault";
    const b = "/Users/other/vaults/Work Vault";
    expect(vaultServiceSlug(a)).toBe(vaultServiceSlug(a));
    expect(vaultServiceSlug(a)).not.toBe(vaultServiceSlug(b));
    expect(vaultServiceSlug(a)).toMatch(/^work-vault-[0-9a-f]{8}$/);
    expect(serviceLabelForVault(a)).toBe(
      `com.dome.serve.${vaultServiceSlug(a)}`,
    );
  });

  test("slug falls back to 'vault' when the basename sanitizes to nothing", () => {
    expect(vaultServiceSlug("/tmp/日本語")).toMatch(/^vault-[0-9a-f]{8}$/);
  });
});

// ----- runInstall -------------------------------------------------------------

describe("runInstall", () => {
  test("fresh install writes the plist, boots out first, then bootstraps", async () => {
    const vault = tempDir("dome-install-vault-");
    const agents = join(tempDir("dome-install-agents-"), "LaunchAgents");
    const launchctl = fakeLaunchctl();

    const code = await runInstall(
      { vault },
      depsFor(agents, launchctl.runner),
    );
    expect(code).toBe(0);

    const label = serviceLabelForVault(vault);
    const plistPath = join(agents, `${label}.plist`);
    expect(existsSync(plistPath)).toBe(true);
    // The log dir must exist so launchd can create the log file.
    expect(existsSync(join(vault, ".dome", "state"))).toBe(true);

    const plist = await readFile(plistPath, "utf8");
    expect(plist).toContain(`<string>${label}</string>`);
    expect(plist).toContain("<string>/opt/bun/bin/bun</string>");
    expect(plist).toContain("<string>/opt/dome/bin/dome</string>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<string>--vault</string>");
    expect(plist).toContain(`<string>${vault}</string>`);
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>WorkingDirectory</key>");
    expect(plist).toContain(
      `<string>${join(vault, ".dome", "state", "serve.log")}</string>`,
    );

    // bootout-first idempotency shape, modern gui-domain forms.
    expect(launchctl.calls).toEqual([
      ["bootout", `gui/501/${label}`],
      ["bootstrap", "gui/501", plistPath],
    ]);
  });

  test("re-running install cleanly replaces: bootout before each bootstrap, exit 0", async () => {
    const vault = tempDir("dome-install-vault-");
    const agents = tempDir("dome-install-agents-");
    const launchctl = fakeLaunchctl();
    const deps = depsFor(agents, launchctl.runner);

    expect(await runInstall({ vault }, deps)).toBe(0);
    expect(await runInstall({ vault }, deps)).toBe(0);

    const label = serviceLabelForVault(vault);
    const plistPath = join(agents, `${label}.plist`);
    expect(launchctl.calls.map((c) => c[0])).toEqual([
      "bootout",
      "bootstrap",
      "bootout",
      "bootstrap",
    ]);
    expect(existsSync(plistPath)).toBe(true);
    expect(logs.join("\n")).toContain("service replaced");
  });

  test("bootstrap failure exits 1, surfaces stderr, and leaves the plist for inspection", async () => {
    const vault = tempDir("dome-install-vault-");
    const agents = tempDir("dome-install-agents-");
    const launchctl = fakeLaunchctl({
      bootstrap: {
        exitCode: 5,
        stdout: "",
        stderr: "Bootstrap failed: 5: Input/output error",
      },
    });

    const code = await runInstall(
      { vault },
      depsFor(agents, launchctl.runner),
    );
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("Bootstrap failed: 5");
    const plistPath = join(agents, `${serviceLabelForVault(vault)}.plist`);
    expect(existsSync(plistPath)).toBe(true);
  });

  test("--json emits the dome.install/v1 payload", async () => {
    const vault = tempDir("dome-install-vault-");
    const agents = tempDir("dome-install-agents-");
    const launchctl = fakeLaunchctl();

    const code = await runInstall(
      { vault, json: true },
      depsFor(agents, launchctl.runner),
    );
    expect(code).toBe(0);

    const payload = JSON.parse(logs.join("\n"));
    expect(payload.schema).toBe("dome.install/v1");
    expect(payload.status).toBe("installed");
    expect(payload.vault).toBe(vault);
    expect(payload.label).toBe(serviceLabelForVault(vault));
    expect(payload.plist).toBe(
      join(agents, `${serviceLabelForVault(vault)}.plist`),
    );
    expect(payload.log).toBe(join(vault, ".dome", "state", "serve.log"));
    expect(payload.replaced).toBe(false);
  });

  test("non-macOS platforms refuse with the service-manager message and touch nothing", async () => {
    const vault = tempDir("dome-install-vault-");
    const agents = tempDir("dome-install-agents-");
    const launchctl = fakeLaunchctl();

    const code = await runInstall(
      { vault },
      depsFor(agents, launchctl.runner, { platform: "linux" }),
    );
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "launchd service install is macOS-only; run `dome serve` under your service manager",
    );
    expect(launchctl.calls).toEqual([]);
    expect(existsSync(join(agents, `${serviceLabelForVault(vault)}.plist`)))
      .toBe(false);
  });

  test("--status reports installed/loaded via launchctl print, read-only", async () => {
    const vault = tempDir("dome-install-vault-");
    const agents = tempDir("dome-install-agents-");

    // Not installed, not loaded.
    let launchctl = fakeLaunchctl();
    expect(
      await runInstall(
        { vault, status: true, json: true },
        depsFor(agents, launchctl.runner),
      ),
    ).toBe(0);
    let payload = JSON.parse(logs.join("\n"));
    expect(payload.status).toBe("status");
    expect(payload.installed).toBe(false);
    expect(payload.loaded).toBe(false);
    expect(launchctl.calls).toEqual([
      ["print", `gui/501/${serviceLabelForVault(vault)}`],
    ]);

    // Install, then a loaded print → installed + loaded.
    logs = [];
    launchctl = fakeLaunchctl({
      print: { exitCode: 0, stdout: "state = running", stderr: "" },
    });
    expect(
      await runInstall({ vault }, depsFor(agents, launchctl.runner)),
    ).toBe(0);
    logs = [];
    expect(
      await runInstall(
        { vault, status: true, json: true },
        depsFor(agents, launchctl.runner),
      ),
    ).toBe(0);
    payload = JSON.parse(logs.join("\n"));
    expect(payload.installed).toBe(true);
    expect(payload.loaded).toBe(true);
  });
});

// ----- runUninstall -----------------------------------------------------------

describe("runUninstall", () => {
  test("boots the service out and removes the plist", async () => {
    const vault = tempDir("dome-install-vault-");
    const agents = tempDir("dome-install-agents-");
    const launchctl = fakeLaunchctl();
    const deps = depsFor(agents, launchctl.runner);

    expect(await runInstall({ vault }, deps)).toBe(0);
    const label = serviceLabelForVault(vault);
    const plistPath = join(agents, `${label}.plist`);
    expect(existsSync(plistPath)).toBe(true);

    expect(await runUninstall({ vault }, deps)).toBe(0);
    expect(existsSync(plistPath)).toBe(false);
    expect(launchctl.calls.at(-1)).toEqual(["bootout", `gui/501/${label}`]);
    expect(logs.join("\n")).toContain("service removed");
  });

  test("is idempotent: uninstalling when absent exits 0 and reports not-installed", async () => {
    const vault = tempDir("dome-install-vault-");
    const agents = tempDir("dome-install-agents-");
    const launchctl = fakeLaunchctl();

    const code = await runUninstall(
      { vault, json: true },
      depsFor(agents, launchctl.runner),
    );
    expect(code).toBe(0);
    const payload = JSON.parse(logs.join("\n"));
    expect(payload.schema).toBe("dome.uninstall/v1");
    expect(payload.status).toBe("not-installed");
    // Bootout is still attempted (covers the deleted-plist-but-loaded edge).
    expect(launchctl.calls).toEqual([
      ["bootout", `gui/501/${serviceLabelForVault(vault)}`],
    ]);
  });

  test("non-macOS platforms refuse with the macOS-only message", async () => {
    const vault = tempDir("dome-install-vault-");
    const agents = tempDir("dome-install-agents-");
    const launchctl = fakeLaunchctl();

    const code = await runUninstall(
      { vault },
      depsFor(agents, launchctl.runner, { platform: "linux" }),
    );
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("macOS-only");
    expect(launchctl.calls).toEqual([]);
  });
});

// ----- Plist rendering ----------------------------------------------------------

describe("renderServePlist", () => {
  test("escapes XML-significant characters in paths", () => {
    const plist = renderServePlist({
      label: "com.dome.serve.test-00000000",
      bunPath: "/opt/bun/bin/bun",
      domeBin: "/opt/dome/bin/dome",
      vaultPath: "/tmp/a&b <vault>",
      logPath: "/tmp/a&b <vault>/.dome/state/serve.log",
    });
    expect(plist).toContain("<string>/tmp/a&amp;b &lt;vault&gt;</string>");
    expect(plist).not.toContain("a&b <vault>");
  });
});
