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
