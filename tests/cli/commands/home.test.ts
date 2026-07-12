import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHome } from "../../../src/cli/commands/home";
import { runInit } from "../../../src/cli/commands/init";
import { openDeviceAuthority } from "../../../src/device-authority/device-authority";

const roots: string[] = [];
const originalLog = console.log;
const originalError = console.error;

afterEach(async () => {
  console.log = originalLog;
  console.error = originalError;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("dome home serves the built PWA and stops as one Product Host", async () => {
  console.log = () => {};
  const errors: string[] = [];
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  const vault = mkdtempSync(join(tmpdir(), "dome-home-vault-"));
  const staticDir = mkdtempSync(join(tmpdir(), "dome-home-pwa-"));
  roots.push(vault, staticDir);
  expect(await runInit({ path: vault })).toBe(0);
  await mkdir(join(staticDir, "assets"), { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Dome Home</title>", "utf8");

  const controller = new AbortController();
  let ready!: (value: { readonly url: string }) => void;
  const listening = new Promise<{ readonly url: string }>((resolve) => {
    ready = resolve;
  });
  const running = runHome({
    vault,
    staticDir,
    port: 0,
    signal: controller.signal,
    onReady: (host) => ready({ url: host.url }),
  });
  const started = await listening;
  expect(errors.some((line) => line.includes("dome devices pair"))).toBe(true);
  expect(errors.some((line) => line.includes("local pairing code"))).toBe(false);

  const shell = await fetch(started.url);
  expect(shell.status).toBe(200);
  expect(await shell.text()).toContain("Dome Home");

  const authority = await openDeviceAuthority({
    path: join(vault, ".dome", "state", "device-authority.db"),
  });
  expect(authority.ok).toBe(true);
  if (!authority.ok) throw new Error("device authority did not open");
  const minted = authority.value.authority.mintPairingGrant({
    deviceName: "Home CLI phone",
    capabilities: ["read"],
  });
  authority.value.authority.close();
  expect(minted.kind).toBe("minted");
  if (minted.kind !== "minted") throw new Error("pairing code did not mint");
  const pair = await fetch(`${started.url}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: started.url },
    body: JSON.stringify({ code: minted.pairingCode }),
  });
  expect(pair.status).toBe(200);
  const cookie = pair.headers.getSetCookie()
    .map((value) => value.split(";", 1)[0] ?? "")
    .join("; ");
  expect((await fetch(`${started.url}/readyz`, { headers: { cookie } })).status).toBe(200);

  controller.abort();
  expect(await running).toBe(0);
}, 30_000);

test("dome home refuses to start without built assets", async () => {
  console.error = () => {};
  const missing = join(tmpdir(), `dome-home-missing-${Date.now()}`);
  expect(await runHome({ vault: "/tmp/unused", staticDir: missing })).toBe(64);
});

test("dome home rejects an insecure non-loopback external origin", async () => {
  console.log = () => {};
  console.error = () => {};
  const vault = mkdtempSync(join(tmpdir(), "dome-home-origin-vault-"));
  const staticDir = mkdtempSync(join(tmpdir(), "dome-home-origin-pwa-"));
  roots.push(vault, staticDir);
  expect(await runInit({ path: vault })).toBe(0);
  await writeFile(join(staticDir, "index.html"), "<!doctype html>", "utf8");
  expect(await runHome({
    vault,
    staticDir,
    port: 0,
    externalOrigin: "http://dome.tail.example",
    signal: AbortSignal.abort(),
  })).toBe(1);
});
