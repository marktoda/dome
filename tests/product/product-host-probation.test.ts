import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { dirname, join, relative } from "node:path";

import { runInit } from "../../src/cli/commands/init";
import { add, commit } from "../../src/git";
import {
  startProductHost,
  type ProductHost,
} from "../../src/product-host/product-host";
import { externalProductHostLockPath } from "../../src/product-host/host-ownership";
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

describe("Product Host upgrade probation", () => {
  test("boots an exact candidate without changing Git or any vault state", async () => {
    const vault = await initializedProductVault();
    await seedAdmittedReceipt(vault);
    const before = await treeFingerprint(vault);
    const artifactId = "a".repeat(64);

    const started = await startProductHost({
      vaultPath: vault,
      port: 0,
      pollIntervalMs: 5,
      launch: {
        kind: "upgrade-probation",
        artifact: { id: artifactId, version: "0.2.0-candidate" },
      },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    hosts.push(started.value);

    expect(await started.value.readiness()).toMatchObject({
      schema: "dome.product.readiness/v1",
      productVersion: "0.2.0-candidate",
      artifactId,
      writesAdmitted: false,
      host: { state: "probation" },
      adoption: { state: "current" },
      device: { id: "local-upgrade-probe", capabilities: [] },
      nextActions: [{ code: "upgrade-probation" }],
    });
    const health = await fetch(`${started.value.url}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      state: "probation",
      writesAdmitted: false,
    });
    const ready = await fetch(`${started.value.url}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      productVersion: "0.2.0-candidate",
      artifactId,
      writesAdmitted: false,
    });

    for (const [path, init] of mutationRequests(started.value.url)) {
      const response = await fetch(path, init);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "write-admission-closed" });
    }
    // There is no scheduler/tick in probation. Waiting beyond many configured
    // poll intervals must not adopt, recover, interrupt, or drain anything.
    await Bun.sleep(50);
    expect(await treeFingerprint(vault)).toEqual(before);

    await started.value.close();
    hosts.splice(hosts.indexOf(started.value), 1);
    expect(await treeFingerprint(vault)).toEqual(before);
    expect(readReceiptState(vault, "prior-operation")).toBe("admitted");
  }, 30_000);

  test("unknown mode and missing exact vault identity fail closed before state opens", async () => {
    const vault = await initializedProductVault();
    const before = await treeFingerprint(vault);
    const unknown = await startProductHost({
      vaultPath: vault,
      port: 0,
      launch: { kind: "committed" } as never,
    });
    expect(unknown).toMatchObject({
      ok: false,
      error: { kind: "startup-failed", message: "Product Host launch mode is unknown" },
    });
    expect(await treeFingerprint(vault)).toEqual(before);

    await rm(join(vault, ".dome", "state", "product-host-id"));
    const withoutIdentity = await treeFingerprint(vault);
    const missing = await startProductHost({
      vaultPath: vault,
      port: 0,
      launch: {
        kind: "upgrade-probation",
        artifact: { id: "b".repeat(64), version: "0.2.0" },
      },
    });
    expect(missing).toMatchObject({ ok: false, error: { kind: "startup-failed" } });
    expect(await treeFingerprint(vault)).toEqual(withoutIdentity);

    const nonexistent = join(tmpdir(), `dome-product-missing-${randomUUID()}`);
    expect(await startProductHost({ vaultPath: nonexistent, port: 0 })).toEqual({
      ok: false,
      error: {
        kind: "open-failed",
        message: "vault path does not exist or cannot be canonicalized",
      },
    });
    expect(await pathPresent(nonexistent)).toBe(false);
  }, 30_000);

  test("normal and probation hosts exclude each other and recover a stale external lock", async () => {
    const vault = await initializedProductVault();
    const launch = {
      kind: "upgrade-probation" as const,
      artifact: { id: "d".repeat(64), version: "0.2.0" },
    };
    const alias = `${vault}-alias`;
    await symlink(vault, alias, "dir");
    roots.push(alias);
    const normal = await startProductHost({ vaultPath: vault, port: 0 });
    expect(normal.ok).toBe(true);
    if (!normal.ok) return;
    hosts.push(normal.value);
    expect(await startProductHost({ vaultPath: alias, port: 0, launch })).toMatchObject({
      ok: false,
      error: { kind: "busy" },
    });
    await normal.value.close();
    hosts.splice(hosts.indexOf(normal.value), 1);

    const probation = await startProductHost({ vaultPath: alias, port: 0, launch });
    expect(probation.ok).toBe(true);
    if (!probation.ok) return;
    hosts.push(probation.value);
    expect(await startProductHost({ vaultPath: vault, port: 0 })).toMatchObject({
      ok: false,
      error: { kind: "busy" },
    });
    await probation.value.close();
    hosts.splice(hosts.indexOf(probation.value), 1);

    const lock = externalProductHostLockPath(await realpath(vault));
    await mkdir(dirname(lock), { recursive: true });
    await writeFile(lock, `${JSON.stringify({
      token: "stale",
      pid: 2_147_483_647,
      hostname: hostname(),
      command: "dead-product-host",
      acquiredAt: new Date().toISOString(),
    })}\n`, "utf8");
    const recovered = await startProductHost({ vaultPath: vault, port: 0, launch });
    expect(recovered.ok).toBe(true);
    if (recovered.ok) await recovered.value.close();
  }, 30_000);

  test("ignores but never mutates a definitely stale vault-local lock", async () => {
    const vault = await initializedProductVault();
    const lock = join(vault, ".dome", "state", "locks", "product-host.lock");
    const stale = `${JSON.stringify({
      token: randomUUID(),
      pid: 2_147_483_647,
      hostname: hostname(),
      command: "dead-product-host",
      acquiredAt: new Date().toISOString(),
    })}\n`;
    await writeFile(lock, stale, "utf8");
    const launch = {
      kind: "upgrade-probation" as const,
      artifact: { id: "e".repeat(64), version: "0.2.0" },
    };
    const started = await startProductHost({ vaultPath: vault, port: 0, launch });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    hosts.push(started.value);
    expect(await readFile(lock, "utf8")).toBe(stale);
    await started.value.close();
    hosts.splice(hosts.indexOf(started.value), 1);
    expect(await readFile(lock, "utf8")).toBe(stale);

    await writeFile(lock, "{}\n", "utf8");
    expect(await startProductHost({ vaultPath: vault, port: 0, launch })).toMatchObject({
      ok: false,
      error: { kind: "busy" },
    });
    expect(await readFile(lock, "utf8")).toBe("{}\n");
  }, 30_000);
});

function mutationRequests(baseUrl: string): ReadonlyArray<readonly [string, RequestInit]> {
  const json = { "content-type": "application/json" };
  return [
    [`${baseUrl}/capture`, { method: "POST", headers: json, body: JSON.stringify({ text: "must not land" }) }],
    [`${baseUrl}/pair`, { method: "POST", headers: json, body: JSON.stringify({ code: "guess" }) }],
    [`${baseUrl}/sessions`, { method: "POST" }],
    [`${baseUrl}/resolve`, { method: "POST", headers: json, body: "{}" }],
    [`${baseUrl}/settle`, { method: "POST", headers: json, body: "{}" }],
    [`${baseUrl}/apply`, { method: "POST", headers: json, body: "{}" }],
    [`${baseUrl}/reject`, { method: "POST", headers: json, body: "{}" }],
    [`${baseUrl}/views/anything`, { method: "POST", headers: json, body: "{}" }],
    [`${baseUrl}/transcribe`, { method: "POST", body: new Uint8Array([1, 2, 3]) }],
  ];
}

async function initializedProductVault(): Promise<string> {
  console.log = () => {};
  console.error = () => {};
  const vault = mkdtempSync(join(tmpdir(), "dome-product-probation-"));
  roots.push(vault);
  expect(await runInit({ path: vault })).toBe(0);
  await mkdir(join(vault, "wiki"), { recursive: true });
  await writeFile(join(vault, "wiki", "host.md"), "# Product Host\n", "utf8");
  await add(vault, "wiki/host.md");
  await commit({ path: vault, message: "seed probation fixture" });

  // Establish the normal Product Host's complete durable store inventory and
  // stable vault id before taking the candidate's no-write snapshot.
  const normal = await startProductHost({ vaultPath: vault, port: 0 });
  expect(normal.ok).toBe(true);
  if (!normal.ok) throw new Error(normal.error.message);
  await normal.value.close();
  return vault;
}

async function seedAdmittedReceipt(vault: string): Promise<void> {
  const opened = await openRequestReceiptsDb({
    path: join(vault, ".dome", "state", "request-receipts.db"),
  });
  if (!opened.ok) throw new Error(opened.error.kind);
  const receipts = createRequestReceipts(opened.value.db, {
    createId: () => "prior-operation",
  });
  receipts.admit({
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
  receipts.close();
}

function readReceiptState(vault: string, operationId: string): string | null {
  const db = new Database(join(vault, ".dome", "state", "request-receipts.db"), {
    readonly: true,
    create: false,
  });
  try {
    return db.query<{ state: string }, [string]>(
      "SELECT state FROM request_receipts WHERE operation_id = ?",
    ).get(operationId)?.state ?? null;
  } finally {
    db.close();
  }
}

async function treeFingerprint(root: string): Promise<ReadonlyArray<string>> {
  const rows: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute);
      const info = await lstat(absolute);
      const mode = (info.mode & 0o777).toString(8);
      if (info.isDirectory()) {
        rows.push(`d\0${path}\0${mode}`);
        await visit(absolute);
      } else if (info.isSymbolicLink()) {
        rows.push(`l\0${path}\0${await readlink(absolute)}`);
      } else if (info.isFile()) {
        const digest = createHash("sha256").update(await readFile(absolute)).digest("hex");
        rows.push(`f\0${path}\0${mode}\0${info.size}\0${digest}`);
      } else {
        rows.push(`o\0${path}\0${mode}`);
      }
    }
  }
  await visit(root);
  return Object.freeze(rows);
}

async function pathPresent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
