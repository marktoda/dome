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
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  renderServePlist,
  runInstall,
  runRestart,
  runUninstall,
  servicePath,
} from "../../src/cli/commands/install";
import {
  serviceLabelForVault,
  vaultServiceSlug,
  type LaunchctlResult,
  type LaunchctlRunner,
  type ServiceDeps,
} from "../../src/surface/service-probe";
import { initRepo } from "../../src/git";

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

/**
 * Minimal initialized vault: a git repo with `.dome/config.yaml`. `dome
 * install` gates on this precondition (a KeepAlive service against a
 * non-vault dir would crashloop forever).
 */
async function vaultDir(): Promise<string> {
  const dir = tempDir("dome-install-vault-");
  await initRepo(dir);
  await mkdir(join(dir, ".dome"), { recursive: true });
  await writeFile(join(dir, ".dome", "config.yaml"), "extensions: {}\n", "utf8");
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
    // Fast drain wait: fakes that report the service as still loaded
    // (`print` exit 0) would otherwise spin out the real 15s default.
    drainTimeoutMs: 250,
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
    const vault = await vaultDir();
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

    // bootout-first idempotency shape, modern gui-domain forms (with the
    // drain probe between bootout and bootstrap).
    expect(launchctl.calls).toEqual([
      ["bootout", `gui/501/${label}`],
      ["print", `gui/501/${label}`],
      ["bootstrap", "gui/501", plistPath],
    ]);
  });

  test("plist carries EnvironmentVariables with a PATH that can resolve bun", async () => {
    // launchd gui agents get PATH=/usr/bin:/bin:/usr/sbin:/sbin, which can't
    // resolve a Homebrew/~/.bun bun — and the serve host must spawn provider
    // commands like ["bun", ".dome/model-provider.ts"].
    const vault = await vaultDir();
    const agents = tempDir("dome-install-agents-");
    const launchctl = fakeLaunchctl();

    expect(
      await runInstall({ vault }, depsFor(agents, launchctl.runner)),
    ).toBe(0);
    const plist = await readFile(
      join(agents, `${serviceLabelForVault(vault)}.plist`),
      "utf8",
    );
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain(
      `<string>/opt/bun/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>`,
    );
  });

  test("--env and --env-file entries land in EnvironmentVariables (flags win), XML-escaped", async () => {
    const vault = await vaultDir();
    const agents = tempDir("dome-install-agents-");
    const launchctl = fakeLaunchctl();
    const envFile = join(tempDir("dome-install-envfile-"), "creds.env");
    await writeFile(
      envFile,
      [
        "# provider credentials",
        "",
        "ANTHROPIC_API_KEY=sk-from-file",
        "OTHER_TOKEN=abc&<def>",
      ].join("\n"),
      "utf8",
    );

    expect(
      await runInstall(
        {
          vault,
          envFile,
          env: ["ANTHROPIC_API_KEY=sk-from-flag", "EXTRA=1"],
        },
        depsFor(agents, launchctl.runner),
      ),
    ).toBe(0);

    const plist = await readFile(
      join(agents, `${serviceLabelForVault(vault)}.plist`),
      "utf8",
    );
    expect(plist).toContain("<key>ANTHROPIC_API_KEY</key>");
    // --env overrides the same key from --env-file.
    expect(plist).toContain("<string>sk-from-flag</string>");
    expect(plist).not.toContain("sk-from-file");
    expect(plist).toContain("<key>EXTRA</key>");
    // XML-significant characters in values are escaped.
    expect(plist).toContain("<key>OTHER_TOKEN</key>");
    expect(plist).toContain("<string>abc&amp;&lt;def&gt;</string>");
    expect(plist).not.toContain("abc&<def>");
  });

  test("malformed --env entries are usage errors (exit 64) and touch nothing", async () => {
    const vault = await vaultDir();
    const agents = tempDir("dome-install-agents-");
    const launchctl = fakeLaunchctl();

    expect(
      await runInstall(
        { vault, env: ["NOT_A_PAIR"] },
        depsFor(agents, launchctl.runner),
      ),
    ).toBe(64);
    expect(errors.join("\n")).toContain("KEY=VALUE");
    expect(launchctl.calls).toEqual([]);
    expect(existsSync(join(agents, `${serviceLabelForVault(vault)}.plist`)))
      .toBe(false);
  });

  test("a non-vault directory is refused with exit 64 before any scaffolding", async () => {
    // Without the gate, install would create .dome/state in an arbitrary
    // directory and load a KeepAlive service that crashloops forever.
    const dir = tempDir("dome-install-novault-");
    const agents = tempDir("dome-install-agents-");
    const launchctl = fakeLaunchctl();

    const code = await runInstall(
      { vault: dir },
      depsFor(agents, launchctl.runner),
    );
    expect(code).toBe(64);
    expect(errors.join("\n")).toContain("not an initialized Dome vault");
    expect(errors.join("\n")).toContain("dome init");
    expect(launchctl.calls).toEqual([]);
    expect(existsSync(join(dir, ".dome"))).toBe(false);
    expect(existsSync(join(agents, `${serviceLabelForVault(dir)}.plist`)))
      .toBe(false);
  });

  test("a git repo without .dome/config.yaml is refused with exit 64", async () => {
    const dir = tempDir("dome-install-noconfig-");
    await initRepo(dir);
    const agents = tempDir("dome-install-agents-");
    const launchctl = fakeLaunchctl();

    expect(
      await runInstall({ vault: dir }, depsFor(agents, launchctl.runner)),
    ).toBe(64);
    expect(errors.join("\n")).toContain(".dome/config.yaml");
    expect(launchctl.calls).toEqual([]);
  });

  test("re-running install cleanly replaces: bootout before each bootstrap, exit 0", async () => {
    const vault = await vaultDir();
    const agents = tempDir("dome-install-agents-");
    const launchctl = fakeLaunchctl();
    const deps = depsFor(agents, launchctl.runner);

    expect(await runInstall({ vault }, deps)).toBe(0);
    expect(await runInstall({ vault }, deps)).toBe(0);

    const label = serviceLabelForVault(vault);
    const plistPath = join(agents, `${label}.plist`);
    expect(launchctl.calls.map((c) => c[0])).toEqual([
      "bootout",
      "print", // drain probe: default fake reports the service gone
      "bootstrap",
      "bootout",
      "print",
      "bootstrap",
    ]);
    expect(existsSync(plistPath)).toBe(true);
    expect(logs.join("\n")).toContain("service replaced");
  });

  test("bootstrap failure exits 1, surfaces stderr, and leaves the plist for inspection", async () => {
    const vault = await vaultDir();
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
    const vault = await vaultDir();
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

  test("unsupported platforms refuse with the service-manager message and touch nothing", async () => {
    const vault = tempDir("dome-install-vault-");
    const agents = tempDir("dome-install-agents-");
    const launchctl = fakeLaunchctl();

    const code = await runInstall(
      { vault },
      depsFor(agents, launchctl.runner, { platform: "win32" }),
    );
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "service install is supported on macOS (launchd) and Linux (systemd --user)",
    );
    expect(launchctl.calls).toEqual([]);
    expect(existsSync(join(agents, `${serviceLabelForVault(vault)}.plist`)))
      .toBe(false);
  });

  test("--status reports installed/loaded via launchctl print, read-only", async () => {
    const vault = await vaultDir();
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
    const vault = await vaultDir();
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

  test("unsupported platforms refuse with the service-manager message", async () => {
    const vault = tempDir("dome-install-vault-");
    const agents = tempDir("dome-install-agents-");
    const launchctl = fakeLaunchctl();

    const code = await runUninstall(
      { vault },
      depsFor(agents, launchctl.runner, { platform: "win32" }),
    );
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "service uninstall is supported on macOS (launchd) and Linux (systemd --user)",
    );
    expect(launchctl.calls).toEqual([]);
  });
});

// ----- runRestart ---------------------------------------------------------------

describe("runRestart", () => {
  test("boots out then bootstraps from the existing plist, preserving --env entries", async () => {
    const vault = await vaultDir();
    const agents = tempDir("dome-install-agents-");
    const installCtl = fakeLaunchctl();

    // Install with a credential entry — the restart must keep it, which is
    // only possible if the plist is NOT re-rendered.
    expect(
      await runInstall(
        { vault, env: ["ANTHROPIC_API_KEY=sk-keep-me"] },
        depsFor(agents, installCtl.runner),
      ),
    ).toBe(0);
    const label = serviceLabelForVault(vault);
    const plistPath = join(agents, `${label}.plist`);
    const installedPlist = await readFile(plistPath, "utf8");
    expect(installedPlist).toContain("<string>sk-keep-me</string>");

    const restartCtl = fakeLaunchctl();
    expect(
      await runRestart({ vault }, depsFor(agents, restartCtl.runner)),
    ).toBe(0);

    // Exact restart sequence: bootout (failure tolerated), drain probe,
    // then bootstrap pointing at the on-disk plist.
    expect(restartCtl.calls).toEqual([
      ["bootout", `gui/501/${label}`],
      ["print", `gui/501/${label}`],
      ["bootstrap", "gui/501", plistPath],
    ]);
    // The plist is byte-identical — restart never rewrites it.
    expect(await readFile(plistPath, "utf8")).toBe(installedPlist);
    expect(logs.join("\n")).toContain("service restarted");
  });

  test("waits for the old service to drain before bootstrapping (mid-agent-run restart)", async () => {
    const vault = await vaultDir();
    const agents = tempDir("dome-install-agents-");
    const installCtl = fakeLaunchctl();
    expect(await runInstall({ vault }, depsFor(agents, installCtl.runner))).toBe(0);

    // A serve mid-agent-run drains slowly: bootout returns immediately but
    // the service stays registered for a while. Bootstrapping during the
    // drain fails (the production first-try `dome restart` error on
    // 2026-06-10); after the drain it succeeds.
    let printCalls = 0;
    let drained = false;
    const calls: Array<ReadonlyArray<string>> = [];
    const runner: LaunchctlRunner = async (args) => {
      calls.push([...args]);
      const sub = args[0] ?? "";
      if (sub === "bootout") return { exitCode: 0, stdout: "", stderr: "" };
      if (sub === "print") {
        printCalls += 1;
        if (printCalls >= 3) {
          drained = true;
          return { exitCode: 113, stdout: "", stderr: "Could not find service" };
        }
        return { exitCode: 0, stdout: "state = running", stderr: "" };
      }
      if (sub === "bootstrap") {
        if (!drained) {
          return {
            exitCode: 5,
            stdout: "",
            stderr: "Bootstrap failed: 5: Input/output error",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    expect(await runRestart({ vault }, depsFor(agents, runner))).toBe(0);
    // The drain wait polled `print` until the service disappeared, and
    // bootstrap was only attempted after that.
    expect(printCalls).toBeGreaterThanOrEqual(3);
    const bootstrapIndex = calls.findIndex((c) => c[0] === "bootstrap");
    const lastPrintIndex = calls.map((c) => c[0]).lastIndexOf("print");
    expect(bootstrapIndex).toBeGreaterThan(lastPrintIndex - 1);
    expect(logs.join("\n")).toContain("service restarted");
  });

  test("refuses with exit 64 when no plist is installed, touching nothing", async () => {
    const vault = await vaultDir();
    const agents = tempDir("dome-install-agents-");
    const launchctl = fakeLaunchctl();

    const code = await runRestart(
      { vault },
      depsFor(agents, launchctl.runner),
    );
    expect(code).toBe(64);
    expect(errors.join("\n")).toContain("not installed");
    expect(errors.join("\n")).toContain("dome install");
    expect(launchctl.calls).toEqual([]);
  });

  test("unsupported platforms refuse with the service-manager message", async () => {
    const vault = await vaultDir();
    const agents = tempDir("dome-install-agents-");
    const launchctl = fakeLaunchctl();

    const code = await runRestart(
      { vault },
      depsFor(agents, launchctl.runner, { platform: "win32" }),
    );
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "service restart is supported on macOS (launchd) and Linux (systemd --user)",
    );
    expect(launchctl.calls).toEqual([]);
  });

  test("bootstrap failure exits 1, surfaces stderr, and leaves the plist for inspection", async () => {
    const vault = await vaultDir();
    const agents = tempDir("dome-install-agents-");
    const deps = depsFor(agents, fakeLaunchctl().runner);
    expect(await runInstall({ vault }, deps)).toBe(0);

    const failing = fakeLaunchctl({
      bootstrap: {
        exitCode: 5,
        stdout: "",
        stderr: "Bootstrap failed: 5: Input/output error",
      },
    });
    const code = await runRestart(
      { vault },
      depsFor(agents, failing.runner),
    );
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("Bootstrap failed: 5");
    expect(
      existsSync(join(agents, `${serviceLabelForVault(vault)}.plist`)),
    ).toBe(true);
  });

  test("--json emits the dome.restart/v1 payload on success and refusal", async () => {
    const vault = await vaultDir();
    const agents = tempDir("dome-install-agents-");
    const deps = depsFor(agents, fakeLaunchctl().runner);

    // Refusal first (not installed).
    expect(await runRestart({ vault, json: true }, deps)).toBe(64);
    let payload = JSON.parse(logs.join("\n")) as Record<string, unknown>;
    expect(payload["schema"]).toBe("dome.restart/v1");
    expect(payload["status"]).toBe("error");
    expect(String(payload["error"])).toContain("not installed");

    logs = [];
    expect(await runInstall({ vault }, deps)).toBe(0);
    logs = [];
    expect(await runRestart({ vault, json: true }, deps)).toBe(0);
    payload = JSON.parse(logs.join("\n")) as Record<string, unknown>;
    expect(payload["schema"]).toBe("dome.restart/v1");
    expect(payload["status"]).toBe("restarted");
    expect(payload["vault"]).toBe(vault);
    expect(payload["label"]).toBe(serviceLabelForVault(vault));
    expect(payload["plist"]).toBe(
      join(agents, `${serviceLabelForVault(vault)}.plist`),
    );
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

  test("servicePath dedupes a bun dir that is already a standard dir", () => {
    expect(servicePath("/usr/local/bin/bun")).toBe(
      "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    );
    expect(servicePath("/Users/me/.bun/bin/bun")).toBe(
      "/Users/me/.bun/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    );
  });
});
