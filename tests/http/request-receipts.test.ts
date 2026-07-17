import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../../src/cli/commands/init";
import { openDeviceAuthority, type DeviceAuthority } from "../../src/device-authority/device-authority";
import { createDomeHttpServer } from "../../src/http/server";
import type { Vault } from "../../src/vault";
import { openRequestReceiptsDb } from "../../src/request-receipts/db";
import {
  bindHttpRequestReceiptRecorder,
  createRequestReceipts,
  type HttpRequestReceiptRecorder,
} from "../../src/request-receipts/request-receipts";

const ORIGIN = "https://dome.example";
const PUBLIC_VAULT_ID = "vault-public-id";
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(): Promise<{ root: string; authority: DeviceAuthority }> {
  const root = mkdtempSync(join(tmpdir(), "dome-http-receipts-"));
  roots.push(root);
  const opened = await openDeviceAuthority({ path: join(root, "authority.db") });
  if (!opened.ok) throw new Error(opened.error.kind);
  return { root, authority: opened.value.authority };
}

async function paired(authority: DeviceAuthority, server: ReturnType<typeof createDomeHttpServer>, capabilities: Array<"capture" | "read" | "resolve" | "converse">) {
  const grant = authority.mintPairingGrant({ deviceName: "phone", capabilities });
  if (grant.kind !== "minted") throw new Error("grant failed");
  const response = await server.fetch(new Request(`${ORIGIN}/pair`, {
    method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ code: grant.pairingCode }),
  }));
  const body = await response.json() as { csrfToken: string };
  return {
    cookie: response.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; "),
    csrf: body.csrfToken,
  };
}

function request(base: string, auth: { cookie: string; csrf: string }, text: string): Request {
  return new Request(`${base}/capture`, {
    method: "POST",
    headers: { cookie: auth.cookie, origin: base, "x-dome-csrf": auth.csrf, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

describe("device mutation request receipts", () => {
  test("paired capture receipts expose only the opaque vault id", async () => {
    const f = await fixture();
    const vault = join(f.root, "private", "work-vault");
    const originalLog = console.log;
    console.log = () => {};
    try { expect(await runInit({ path: vault })).toBe(0); } finally { console.log = originalLog; }
    const server = createDomeHttpServer({
      vaultPath: vault,
      publicVaultId: PUBLIC_VAULT_ID,
      deviceAuth: { authority: f.authority, allowedOrigins: () => [ORIGIN] },
    });
    const auth = await paired(f.authority, server, ["capture"]);
    const response = await server.fetch(new Request(`${ORIGIN}/capture`, {
      method: "POST",
      headers: {
        cookie: auth.cookie,
        origin: ORIGIN,
        "x-dome-csrf": auth.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "private locator regression", captureId: "redacted-vault-1" }),
    }));
    const raw = await response.text();
    expect(response.status).toBe(200);
    expect(raw).not.toContain(vault);
    expect(JSON.parse(raw)).toMatchObject({
      schema: "dome.capture/v1",
      status: "captured",
      vault: PUBLIC_VAULT_ID,
      capture_id: "redacted-vault-1",
    });
    await server.close();
    f.authority.close();
  });

  test("validation and capability denial precede fail-closed admission", async () => {
    const f = await fixture();
    let admissions = 0;
    const recorder: HttpRequestReceiptRecorder = { admit: () => { admissions++; throw new Error("disk full"); } };
    const server = createDomeHttpServer({
      vaultPath: f.root,
      publicVaultId: PUBLIC_VAULT_ID,
      deviceAuth: { authority: f.authority, allowedOrigins: () => [ORIGIN] },
      requestReceiptRecorder: recorder,
    });
    const allowed = await paired(f.authority, server, ["capture"]);
    const invalid = await server.fetch(request(ORIGIN, allowed, ""));
    expect(invalid.status).toBe(400);
    expect(admissions).toBe(0);
    const deniedAuth = await paired(f.authority, server, ["read"]);
    expect((await server.fetch(request(ORIGIN, deniedAuth, "secret prose"))).status).toBe(403);
    expect(admissions).toBe(0);
    const failed = await server.fetch(request(ORIGIN, allowed, "secret prose"));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ error: "mutation-admission-failed" });
    expect(admissions).toBe(1);
    await server.close();
    f.authority.close();
  });

  test("finalization failure returns non-retryable unknown with safe correlation", async () => {
    const f = await fixture();
    const vault = join(f.root, "vault");
    const originalLog = console.log;
    console.log = () => {};
    try { expect(await runInit({ path: vault })).toBe(0); } finally { console.log = originalLog; }
    const admitted: unknown[] = [];
    const recorder: HttpRequestReceiptRecorder = {
      admit: (input) => {
        admitted.push(input);
        return { operationId: "receipt-1", finish: () => { throw new Error("fsync failed"); } };
      },
    };
    const server = createDomeHttpServer({
      vaultPath: vault,
      publicVaultId: PUBLIC_VAULT_ID,
      deviceAuth: { authority: f.authority, allowedOrigins: () => [ORIGIN] },
      requestReceiptRecorder: recorder,
    });
    const auth = await paired(f.authority, server, ["capture"]);
    const response = await server.fetch(request(ORIGIN, auth, "secret prose must not persist"));
    expect(response.status).toBe(500);
    expect(response.headers.get("x-dome-receipt-id")).toBe("receipt-1");
    expect(await response.json()).toMatchObject({
      error: "mutation-outcome-unknown",
      retryable: false,
    });
    expect(JSON.stringify(admitted)).not.toContain("secret prose");
    expect(admitted).toEqual([expect.objectContaining({ operation: "capture", operationClass: "workspace-mutation" })]);
    const secondAuth = await paired(f.authority, server, ["capture"]);
    await server.fetch(request(ORIGIN, secondAuth, "different secret prose"));
    const identities = admitted as Array<{ requestId: string; deviceId: string }>;
    expect(new Set(identities.map((item) => item.requestId)).size).toBe(2);
    expect(new Set(identities.map((item) => item.deviceId)).size).toBe(2);
    expect(JSON.stringify(admitted)).not.toContain("different secret prose");
    await server.close();
    f.authority.close();
  });

  test("a side effect followed by throw persists interrupted uncertainty", async () => {
    const f = await fixture();
    const opened = await openRequestReceiptsDb({ path: join(f.root, "receipts.db") });
    if (!opened.ok) throw new Error(opened.error.kind);
    const receipts = createRequestReceipts(opened.value.db, { createId: () => "resolve-receipt" });
    let sideEffect = false;
    const vault = {
      resolve: async () => {
        sideEffect = true;
        throw new Error("after side effect");
      },
    } as unknown as Vault;
    const server = createDomeHttpServer({
      vaultPath: f.root,
      vault,
      publicVaultId: PUBLIC_VAULT_ID,
      deviceAuth: { authority: f.authority, allowedOrigins: () => [ORIGIN] },
      requestReceiptRecorder: bindHttpRequestReceiptRecorder(receipts, "host-1"),
    });
    const auth = await paired(f.authority, server, ["resolve"]);
    const response = await server.fetch(new Request(`${ORIGIN}/resolve`, {
      method: "POST",
      headers: { cookie: auth.cookie, origin: ORIGIN, "x-dome-csrf": auth.csrf, "content-type": "application/json" },
      body: JSON.stringify({ id: 1, value: "yes" }),
    }));
    expect(sideEffect).toBe(true);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "mutation-outcome-unknown", retryable: false });
    expect(receipts.list()).toEqual([expect.objectContaining({
      state: "interrupted",
      resultCode: "mutation-outcome-unknown",
      adoptionState: "unknown",
      recoveryRequired: true,
    })]);
    await server.close();
    receipts.close();
    f.authority.close();
  });

  test("apply invalid and drain runtime failure persist uncertainty, never success", async () => {
    const f = await fixture();
    const opened = await openRequestReceiptsDb({ path: join(f.root, "receipts.db") });
    if (!opened.ok) throw new Error(opened.error.kind);
    let n = 0;
    const receipts = createRequestReceipts(opened.value.db, { createId: () => `receipt-${++n}` });
    const server = createDomeHttpServer({
      vaultPath: f.root,
      publicVaultId: PUBLIC_VAULT_ID,
      deviceAuth: { authority: f.authority, allowedOrigins: () => [ORIGIN] },
      requestReceiptRecorder: bindHttpRequestReceiptRecorder(receipts, "host-1"),
    });
    const auth = await paired(f.authority, server, ["resolve", "converse"]);
    const headers = { cookie: auth.cookie, origin: ORIGIN, "x-dome-csrf": auth.csrf, "content-type": "application/json" };
    const apply = await server.fetch(new Request(`${ORIGIN}/apply`, { method: "POST", headers, body: JSON.stringify({ id: 1 }) }));
    expect(apply.status).toBe(500);
    expect(await apply.json()).toMatchObject({ error: "mutation-outcome-unknown", retryable: false });
    const drain = await server.fetch(new Request(`${ORIGIN}/agent-work/drain`, { method: "POST", headers, body: JSON.stringify({ limit: 1 }) }));
    expect(drain.status).toBe(500);
    expect(await drain.json()).toMatchObject({ error: "mutation-outcome-unknown", retryable: false });
    expect(receipts.list().map((receipt) => ({ operation: receipt.operation, state: receipt.state })))
      .toEqual(expect.arrayContaining([
        { operation: "apply-proposal", state: "interrupted" },
        { operation: "agent-work-drain", state: "interrupted" },
      ]));
    expect(receipts.list({ state: "succeeded" })).toEqual([]);
    await server.close();
    receipts.close();
    f.authority.close();
  });
});
