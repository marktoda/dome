import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDevices } from "../../../src/cli/commands/devices";
import { runInit } from "../../../src/cli/commands/init";
import { openDeviceAuthority } from "../../../src/device-authority/device-authority";

const roots: string[] = [];
const output: string[] = [];
const errors: string[] = [];
const originalLog = console.log;
const originalError = console.error;

beforeEach(() => {
  output.length = 0;
  errors.length = 0;
  console.log = (...parts: unknown[]) => output.push(parts.join(" "));
  console.error = (...parts: unknown[]) => errors.push(parts.join(" "));
});

afterEach(async () => {
  console.log = originalLog;
  console.error = originalError;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("dome devices", () => {
  test("mints a scoped local pairing grant, then lists and revokes the paired device", async () => {
    const vault = await initializedVault();
    expect(await runDevices({
      action: "pair",
      name: "Work phone",
      grant: "read,capture",
      vault,
      json: true,
    })).toBe(0);
    const pairing = JSON.parse(output.pop() ?? "{}") as {
      readonly pairingCode: string;
      readonly capabilities: string[];
    };
    expect(pairing.capabilities).toEqual(["read", "capture"]);

    const opened = await openDeviceAuthority({
      path: join(vault, ".dome", "state", "device-authority.db"),
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const exchanged = opened.value.authority.exchangePairingCode({
      pairingCode: pairing.pairingCode,
    });
    expect(exchanged.kind).toBe("paired");
    if (exchanged.kind !== "paired") return;
    const deviceId = exchanged.device.id;
    opened.value.authority.close();

    expect(await runDevices({ action: "list", vault, json: true })).toBe(0);
    const listed = JSON.parse(output.pop() ?? "{}") as { readonly devices: Array<{ readonly id: string }> };
    expect(listed.devices).toMatchObject([{ id: deviceId }]);

    expect(await runDevices({ action: "revoke", deviceId, vault, json: true })).toBe(0);
    expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({ status: "revoked" });
  });

  test("validates local-console arguments before minting authority", async () => {
    const vault = await initializedVault();
    expect(await runDevices({ action: "pair", name: "", vault })).toBe(64);
    expect(await runDevices({ action: "pair", name: "phone", grant: "admin", vault })).toBe(64);
    expect(await runDevices({ action: "bogus", vault })).toBe(64);

    const opened = await openDeviceAuthority({
      path: join(vault, ".dome", "state", "device-authority.db"),
    });
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.value.authority.listDevices()).toEqual([]);
      opened.value.authority.close();
    }
  });
});

async function initializedVault(): Promise<string> {
  const vault = mkdtempSync(join(tmpdir(), "dome-devices-cli-"));
  roots.push(vault);
  expect(await runInit({ path: vault })).toBe(0);
  output.length = 0;
  errors.length = 0;
  return vault;
}
