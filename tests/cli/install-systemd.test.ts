// tests/cli/install-systemd.test.ts
// systemd backend for `dome install` — same testability contract as
// tests/cli/install.test.ts: every host boundary injected; recording fake
// systemctl; temp dirs; never touches ~/.config or real systemd.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderServeSystemdUnit } from "../../src/cli/commands/install-systemd";
import {
  probeServiceState,
  serviceUnitNameForVault,
  vaultServiceSlug,
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
