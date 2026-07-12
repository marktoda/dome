import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentRuntime, type AgentRun } from "../../src/assistant/runtime";
import { runInit } from "../../src/cli/commands/init";
import { add, commit } from "../../src/git";
import { startProductHost, type ProductHost } from "../../src/product-host/product-host";

const roots: string[] = [];
const hosts: ProductHost[] = [];
const originalLog = console.log;
const originalError = console.error;

afterEach(async () => {
  console.log = originalLog;
  console.error = originalError;
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P2 Product Host", () => {
  test("owns one vault, reports readiness, releases ownership, and restarts", async () => {
    const vault = await initializedVault();
    const first = await startProductHost({
      vaultPath: vault,
      pairCode: "local-code-123",
      port: 0,
      pollIntervalMs: 25,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    hosts.push(first.value);

    const cookie = await pair(first.value.url);
    const ready = await fetch(`${first.value.url}/readyz`, { headers: { cookie } });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      schema: "dome.product.readiness/v1",
      host: { state: "ready" },
      adoption: { state: "current" },
      vault: { name: vault.split("/").at(-1) },
    });

    const second = await startProductHost({
      vaultPath: vault,
      pairCode: "second-code-123",
      port: 0,
    });
    expect(second).toMatchObject({ ok: false, error: { kind: "busy" } });

    await first.value.close();
    hosts.splice(hosts.indexOf(first.value), 1);
    const restarted = await startProductHost({
      vaultPath: vault,
      pairCode: "restart-code-123",
      port: 0,
    });
    expect(restarted.ok).toBe(true);
    if (restarted.ok) hosts.push(restarted.value);
  }, 30_000);

  test("a slow model turn does not block readiness, adopted reads, or capture", async () => {
    const vault = await initializedVault();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const runtime = createAgentRuntime({
      createId: () => "slow-session",
      runTurn: (): AgentRun => ({
        text: (async function* () {
          yield "working";
          await blocked;
          yield "done";
        })(),
        finished: blocked.then(() => ({ citations: [], changes: [], stopReason: "final" as const })),
      }),
    });
    const started = await startProductHost({
      vaultPath: vault,
      pairCode: "local-code-123",
      port: 0,
      pollIntervalMs: 25,
      agentRuntime: runtime,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    hosts.push(started.value);
    const cookie = await pair(started.value.url);

    const created = await fetch(`${started.value.url}/sessions`, {
      method: "POST",
      headers: { cookie },
    });
    expect(created.status).toBe(201);
    const turn = await fetch(`${started.value.url}/sessions/slow-session/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ message: "wait" }),
    });
    expect(turn.status).toBe(200);

    try {
      const [ready, doc, capture] = await within(Promise.all([
        fetch(`${started.value.url}/readyz`, { headers: { cookie } }),
        fetch(`${started.value.url}/doc?path=wiki/host.md`, { headers: { cookie } }),
        fetch(`${started.value.url}/capture`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ text: "Concurrent owner capture", captureId: "p2-concurrent" }),
        }),
      ]), 2_000);
      expect(ready.status).toBe(200);
      expect(doc.status).toBe(200);
      expect(capture.status).toBe(200);
    } finally {
      release();
      await turn.text();
    }
  }, 30_000);
});

async function initializedVault(): Promise<string> {
  console.log = () => {};
  console.error = () => {};
  const vault = mkdtempSync(join(tmpdir(), "dome-product-host-"));
  roots.push(vault);
  expect(await runInit({ path: vault })).toBe(0);
  await mkdir(join(vault, "wiki"), { recursive: true });
  await writeFile(join(vault, "wiki", "host.md"), "# Product Host\n", "utf8");
  await add(vault, "wiki/host.md");
  await commit({ path: vault, message: "seed product host fixture" });
  return vault;
}

async function pair(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "local-code-123" }),
  });
  expect(response.status).toBe(200);
  return (response.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`operation exceeded ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
