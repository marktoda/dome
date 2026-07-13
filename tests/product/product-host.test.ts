import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentRuntime, type AgentRun } from "../../src/assistant/runtime";
import { runInit } from "../../src/cli/commands/init";
import { openDeviceAuthority } from "../../src/device-authority/device-authority";
import { add, commit } from "../../src/git";
import { startProductHost, type ProductHost } from "../../src/product-host/product-host";
import { openRequestReceiptsDb } from "../../src/request-receipts/db";
import { createRequestReceipts } from "../../src/request-receipts/request-receipts";

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

describe("P3 Product Host", () => {
  test("owns one vault, reports readiness, releases ownership, and restarts", async () => {
    const vault = await initializedVault();
    const pairingCode = await mintPairingCode(vault, "Product test phone", [
      "capture", "converse", "read", "resolve",
    ]);
    const first = await startProductHost({
      vaultPath: vault,
      port: 0,
      pollIntervalMs: 25,
      externalOrigin: "http://localhost:5173",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    hosts.push(first.value);

    const auth = await pair(first.value.url, pairingCode);
    const externalPairing = await mintPairingCode(vault, "External origin phone", ["read"]);
    await pair(first.value.url, externalPairing, "http://localhost:5173");
    const ready = await fetch(`${first.value.url}/readyz`, { headers: { cookie: auth.cookie } });
    expect(ready.status).toBe(200);
    const readyDocument = await ready.json() as { readonly vault: { readonly id: string } };
    expect(readyDocument).toMatchObject({
      schema: "dome.product.readiness/v1",
      artifactId: "development",
      writesAdmitted: true,
      host: { state: "ready" },
      adoption: { state: "current" },
      vault: { name: vault.split("/").at(-1) },
      device: {
        name: "Product test phone",
        capabilities: ["capture", "converse", "read", "resolve"],
      },
    });
    expect((await fetch(`${first.value.url}/status`, { headers: { cookie: auth.cookie } })).status).toBe(410);

    const second = await startProductHost({
      vaultPath: vault,
      port: 0,
    });
    expect(second).toMatchObject({ ok: false, error: { kind: "busy" } });

    await first.value.close();
    hosts.splice(hosts.indexOf(first.value), 1);
    const restarted = await startProductHost({
      vaultPath: vault,
      port: 0,
      externalOrigin: "https://dome.tail.example",
    });
    expect(restarted.ok).toBe(true);
    if (restarted.ok) {
      hosts.push(restarted.value);
      expect((await restarted.value.readiness()).vault.id).toBe(readyDocument.vault.id);
      expect((await fetch(`${restarted.value.url}/readyz`, {
        headers: { cookie: auth.cookie },
      })).status).toBe(200);
    }
  }, 30_000);

  test("a slow model turn does not block readiness, adopted reads, or capture", async () => {
    const vault = await initializedVault();
    const pairingCode = await mintPairingCode(vault, "Concurrent phone", [
      "capture", "converse", "read", "resolve",
    ]);
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
      port: 0,
      pollIntervalMs: 25,
      agentRuntime: runtime,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    hosts.push(started.value);
    const auth = await pair(started.value.url, pairingCode);

    const created = await fetch(`${started.value.url}/sessions`, {
      method: "POST",
      headers: mutationHeaders(started.value.url, auth),
    });
    expect(created.status).toBe(201);
    const turn = await fetch(`${started.value.url}/sessions/slow-session/messages`, {
      method: "POST",
      headers: {
        ...mutationHeaders(started.value.url, auth),
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "wait" }),
    });
    expect(turn.status).toBe(200);

    try {
      const [ready, today, doc, capture] = await within(Promise.all([
        fetch(`${started.value.url}/readyz`, { headers: { cookie: auth.cookie } }),
        fetch(`${started.value.url}/tasks`, { headers: { cookie: auth.cookie } }),
        fetch(`${started.value.url}/doc?path=wiki/host.md`, { headers: { cookie: auth.cookie } }),
        fetch(`${started.value.url}/capture`, {
          method: "POST",
          headers: {
            ...mutationHeaders(started.value.url, auth),
            "content-type": "application/json",
          },
          body: JSON.stringify({ text: "Concurrent owner capture", captureId: "p2-concurrent" }),
        }),
      ]), 2_000);
      expect(ready.status).toBe(200);
      expect(today.status).toBe(200);
      expect(doc.status).toBe(200);
      expect(capture.status).toBe(200);
      const captureDocument = await capture.json() as { status: string; commit: string };
      expect(captureDocument).toMatchObject({
        status: "captured",
        adoption_status: "pending",
      });
      const receiptId = capture.headers.get("x-dome-receipt-id");
      const requestId = capture.headers.get("x-dome-request-id");
      expect(receiptId).not.toBeNull();
      expect(requestId).not.toBeNull();
      const receiptDb = await openRequestReceiptsDb({ path: join(vault, ".dome", "state", "request-receipts.db") });
      expect(receiptDb.ok).toBe(true);
      if (receiptDb.ok) {
        const receipts = createRequestReceipts(receiptDb.value.db);
        expect(receipts.list({ requestId: requestId! })).toEqual([
          expect.objectContaining({
            operationId: receiptId,
            requestId,
            operation: "capture",
            operationClass: "workspace-mutation",
            state: "succeeded",
            resultCode: "captured",
            commitOid: captureDocument.commit,
            transport: "cookie",
          }),
        ]);
        receipts.close();
      }
      await eventually(async () => {
        const readiness = await started.value.readiness();
        return readiness.adoption.state === "current" &&
          readiness.adoption.head === readiness.adoption.adopted;
      }, 3_000);
    } finally {
      release();
      await turn.text();
    }
  }, 30_000);

  test("restart persists and interrupts a prior host's admitted mutation", async () => {
    const vault = await initializedVault();
    const path = join(vault, ".dome", "state", "request-receipts.db");
    const opened = await openRequestReceiptsDb({ path });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const seeded = createRequestReceipts(opened.value.db, { createId: () => "prior-operation" });
    seeded.admit({
      requestId: "prior-request",
      actorId: "owner",
      deviceId: "prior-device",
      credentialId: "prior-credential",
      transport: "bearer",
      hostInstanceId: "prior-host",
      executor: "http",
      operation: "capture",
      operationClass: "workspace-mutation",
    });
    seeded.close();

    const started = await startProductHost({ vaultPath: vault, port: 0 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await started.value.close();

    const reopened = await openRequestReceiptsDb({ path });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    const receipts = createRequestReceipts(reopened.value.db);
    expect(receipts.list({ requestId: "prior-request" })).toEqual([
      expect.objectContaining({
        operationId: "prior-operation",
        state: "interrupted",
        resultCode: "host-restarted",
        adoptionState: "unknown",
        recoveryRequired: true,
      }),
    ]);
    receipts.close();
  }, 30_000);

  test("refuses startup when durable request receipts cannot open", async () => {
    const vault = await initializedVault();
    await writeFile(join(vault, ".dome", "state", "request-receipts.db"), "not sqlite", "utf8");
    const started = await startProductHost({ vaultPath: vault, port: 0 });
    expect(started).toMatchObject({
      ok: false,
      error: { kind: "startup-failed" },
    });
    if (!started.ok) expect(started.error.message).toContain("request receipts could not open");
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

type BrowserAuth = { readonly cookie: string; readonly csrf: string };

async function pair(
  baseUrl: string,
  code: string,
  origin: string = baseUrl,
): Promise<BrowserAuth> {
  const response = await fetch(`${baseUrl}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ code }),
  });
  expect(response.status).toBe(200);
  const cookies = response.headers.getSetCookie().map((value) => value.split(";", 1)[0] ?? "");
  const csrfCookie = cookies.find((value) => value.startsWith("dome_csrf="));
  return {
    cookie: cookies.join("; "),
    csrf: decodeURIComponent(csrfCookie?.slice("dome_csrf=".length) ?? ""),
  };
}

function mutationHeaders(baseUrl: string, auth: BrowserAuth): Record<string, string> {
  return { cookie: auth.cookie, origin: baseUrl, "x-dome-csrf": auth.csrf };
}

async function mintPairingCode(
  vault: string,
  deviceName: string,
  capabilities: Array<"capture" | "converse" | "read" | "resolve">,
): Promise<string> {
  const opened = await openDeviceAuthority({
    path: join(vault, ".dome", "state", "device-authority.db"),
  });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error("device authority did not open");
  const minted = opened.value.authority.mintPairingGrant({ deviceName, capabilities });
  opened.value.authority.close();
  expect(minted.kind).toBe("minted");
  if (minted.kind !== "minted") throw new Error("pairing code did not mint");
  return minted.pairingCode;
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

async function eventually(check: () => Promise<boolean>, milliseconds: number): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`condition was not met within ${milliseconds}ms`);
}
