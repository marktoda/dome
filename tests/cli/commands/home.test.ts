import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHome } from "../../../src/cli/commands/home";
import { runInit } from "../../../src/cli/commands/init";

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
  console.error = () => {};
  const vault = mkdtempSync(join(tmpdir(), "dome-home-vault-"));
  const staticDir = mkdtempSync(join(tmpdir(), "dome-home-pwa-"));
  roots.push(vault, staticDir);
  expect(await runInit({ path: vault })).toBe(0);
  await mkdir(join(staticDir, "assets"), { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Dome Home</title>", "utf8");

  const controller = new AbortController();
  let ready!: (value: { readonly url: string; readonly code: string }) => void;
  const listening = new Promise<{ readonly url: string; readonly code: string }>((resolve) => {
    ready = resolve;
  });
  const running = runHome({
    vault,
    staticDir,
    pairCode: "home-code-123",
    port: 0,
    signal: controller.signal,
    onReady: (host, code) => ready({ url: host.url, code }),
  });
  const started = await listening;
  expect(started.code).toBe("home-code-123");

  const shell = await fetch(started.url);
  expect(shell.status).toBe(200);
  expect(await shell.text()).toContain("Dome Home");

  const pair = await fetch(`${started.url}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: started.code }),
  });
  expect(pair.status).toBe(200);
  const cookie = (pair.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
  expect((await fetch(`${started.url}/readyz`, { headers: { cookie } })).status).toBe(200);

  controller.abort();
  expect(await running).toBe(0);
}, 30_000);

test("dome home refuses to start without built assets", async () => {
  console.error = () => {};
  const missing = join(tmpdir(), `dome-home-missing-${Date.now()}`);
  expect(await runHome({ vault: "/tmp/unused", staticDir: missing })).toBe(64);
});
