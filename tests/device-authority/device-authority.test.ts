import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openDeviceAuthority,
  type DeviceAuthority,
} from "../../src/device-authority/device-authority";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function authority(options: {
  readonly credentialTtlMs?: number;
} = {}): Promise<{ readonly dbPath: string; readonly authority: DeviceAuthority }> {
  const root = mkdtempSync(join(tmpdir(), "dome-device-authority-"));
  roots.push(root);
  const dbPath = join(root, "device-authority.db");
  const opened = await openDeviceAuthority({ path: dbPath, ...options });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error("device authority did not open");
  return { dbPath, authority: opened.value.authority };
}

function pair(
  store: DeviceAuthority,
  name: string,
  capabilities: Array<"read" | "capture" | "author"> = ["read"],
) {
  const minted = store.mintPairingGrant({ deviceName: name, capabilities });
  expect(minted.kind).toBe("minted");
  if (minted.kind !== "minted") throw new Error("pairing grant not minted");
  const exchanged = store.exchangePairingCode({
    pairingCode: minted.pairingCode,
  });
  expect(exchanged.kind).toBe("paired");
  if (exchanged.kind !== "paired") throw new Error("pairing grant not exchanged");
  return { minted, exchanged };
}

describe("device authority", () => {
  test("persists metadata across reopen and never stores raw secrets", async () => {
    const { dbPath, authority: first } = await authority();
    const { minted, exchanged } = pair(first, "Mark's iPhone", ["capture", "read"]);
    const deviceId = exchanged.device.id;

    const inspection = new Database(dbPath);
    const rows = inspection.query<Record<string, unknown>, []>(
      "SELECT code_hash, device_name, capabilities_json FROM pairing_grants",
    ).all();
    expect(String(rows[0]?.["code_hash"])).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.["device_name"]).toBe("Mark's iPhone");
    const deviceRow = inspection.query<Record<string, unknown>, []>(
      "SELECT id, secret_hash, csrf_hash FROM device_credentials",
    ).get();
    expect(deviceRow?.["id"]).toBe(exchanged.credentialId);
    expect(String(deviceRow?.["secret_hash"])).toMatch(/^[0-9a-f]{64}$/);
    expect(String(deviceRow?.["csrf_hash"])).toMatch(/^[0-9a-f]{64}$/);
    expect(exchanged.credential).toStartWith(`dome_cred.${exchanged.credentialId}.`);
    expect(exchanged.credentialExpiresAt).toBe(exchanged.device.credentialExpiresAt);
    inspection.close();
    first.close();

    const bytes = await readFile(dbPath);
    const pairingSecret = minted.pairingCode.split(".")[2]!;
    const credentialSecret = exchanged.credential.split(".")[2]!;
    const csrfSecret = exchanged.csrfSecret.split(".")[1]!;
    for (const raw of [pairingSecret, credentialSecret, csrfSecret]) {
      expect(bytes.includes(Buffer.from(raw))).toBe(false);
    }
    const reopened = await openDeviceAuthority({ path: dbPath });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.value.migration).toBe("ok");
    expect(reopened.value.authority.listDevices()).toMatchObject([
      { id: deviceId, name: "Mark's iPhone", capabilities: ["capture", "read"] },
    ]);
    reopened.value.authority.close();
  });

  test("pairing codes are one-time, expiring, scoped, and attempt-limited", async () => {
    const { authority: store } = await authority();
    const now = new Date("2026-07-11T12:00:00.000Z");
    const minted = store.mintPairingGrant({
      deviceName: "phone",
      capabilities: ["read", "capture"],
      now,
      ttlMs: 1_000,
      maxAttempts: 2,
    });
    expect(minted.kind).toBe("minted");
    if (minted.kind !== "minted") return;
    const [prefix, id] = minted.pairingCode.split(".");
    expect(store.exchangePairingCode({
      pairingCode: `${prefix}.${id}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
      now,
    })).toEqual({ kind: "invalid" });
    expect(store.exchangePairingCode({
      pairingCode: `${prefix}.${id}.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`,
      now,
    })).toEqual({ kind: "limited" });
    expect(store.exchangePairingCode({ pairingCode: minted.pairingCode, now }))
      .toEqual({ kind: "limited" });

    const expiring = store.mintPairingGrant({
      deviceName: "tablet",
      capabilities: ["read"],
      now,
      ttlMs: 1,
    });
    expect(expiring.kind).toBe("minted");
    if (expiring.kind !== "minted") return;
    expect(store.exchangePairingCode({
      pairingCode: expiring.pairingCode,
      now: new Date(now.getTime() + 1),
    })).toEqual({ kind: "expired" });

    const usable = store.mintPairingGrant({
      deviceName: "desktop",
      capabilities: ["capture", "read"],
      now,
    });
    expect(usable.kind).toBe("minted");
    if (usable.kind !== "minted") return;
    const paired = store.exchangePairingCode({ pairingCode: usable.pairingCode, now });
    expect(paired.kind).toBe("paired");
    if (paired.kind !== "paired") return;
    expect(paired.device.capabilities).toEqual(["capture", "read"]);
    expect(store.exchangePairingCode({ pairingCode: usable.pairingCode, now }))
      .toEqual({ kind: "consumed" });
    store.close();
  });

  test("authenticates credential and CSRF, then records last use", async () => {
    const { authority: store } = await authority();
    const { exchanged } = pair(store, "desktop", ["read", "author"]);
    expect(store.authenticate({ credential: "wrong" })).toEqual({ kind: "invalid" });
    const [credentialPrefix, credentialId] = exchanged.credential.split(".");
    expect(store.authenticate({
      credential: `${credentialPrefix}.${credentialId}.${"A".repeat(43)}`,
    })).toEqual({ kind: "invalid" });
    expect(store.authenticate({
      credential: exchanged.credential,
      requireCsrf: true,
    })).toEqual({ kind: "csrf-invalid" });
    expect(store.authenticate({
      credential: exchanged.credential,
      csrfSecret: "wrong",
      requireCsrf: true,
    })).toEqual({ kind: "csrf-invalid" });
    const usedAt = new Date("2026-07-11T13:00:00.000Z");
    const authenticated = store.authenticate({
      credential: exchanged.credential,
      csrfSecret: exchanged.csrfSecret,
      requireCsrf: true,
      now: usedAt,
    });
    expect(authenticated).toMatchObject({
      kind: "authenticated",
      actorId: "owner",
      credentialId: exchanged.credentialId,
      device: {
        id: exchanged.device.id,
        capabilities: ["author", "read"],
        lastUsedAt: usedAt.toISOString(),
      },
    });
    store.close();
  });

  test("revokes one device without affecting another", async () => {
    const { authority: store } = await authority();
    const phone = pair(store, "phone").exchanged;
    const desktop = pair(store, "desktop", ["read", "capture"]).exchanged;
    expect(store.revokeDevice({ deviceId: phone.device.id })).toMatchObject({ kind: "revoked" });
    expect(store.authenticate({ credential: phone.credential })).toEqual({ kind: "revoked" });
    expect(store.authenticate({ credential: desktop.credential })).toMatchObject({
      kind: "authenticated",
      device: { id: desktop.device.id },
    });
    expect(store.revokeDevice({ deviceId: phone.device.id })).toEqual({ kind: "already-revoked" });
    store.close();
  });

  test("rotation invalidates old credential and CSRF while preserving identity and grant", async () => {
    const { dbPath, authority: store } = await authority();
    const original = pair(store, "phone", ["read", "capture"]).exchanged;
    const rotated = store.rotateDeviceCredential({ deviceId: original.device.id });
    expect(rotated.kind).toBe("rotated");
    if (rotated.kind !== "rotated") return;
    expect(rotated.device.id).toBe(original.device.id);
    expect(rotated.device.capabilities).toEqual(["capture", "read"]);
    expect(rotated.credential).not.toBe(original.credential);
    expect(rotated.credentialId).not.toBe(original.credentialId);
    expect(rotated.credentialExpiresAt).toBe(rotated.device.credentialExpiresAt);
    expect(store.authenticate({ credential: original.credential })).toEqual({ kind: "invalid" });
    expect(store.authenticate({
      credential: rotated.credential,
      csrfSecret: original.csrfSecret,
      requireCsrf: true,
    })).toEqual({ kind: "csrf-invalid" });
    expect(store.authenticate({
      credential: rotated.credential,
      csrfSecret: rotated.csrfSecret,
      requireCsrf: true,
    })).toMatchObject({ kind: "authenticated", device: { id: original.device.id } });
    const inspection = new Database(dbPath);
    const history = inspection.query<{
      id: string;
      rotated_at: string | null;
      revoked_at: string | null;
    }, []>(
      "SELECT id, rotated_at, revoked_at FROM device_credentials ORDER BY rowid",
    ).all();
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ id: original.credentialId, rotated_at: expect.any(String) });
    expect(history[1]).toEqual({ id: rotated.credentialId, rotated_at: null, revoked_at: null });
    inspection.close();
    store.close();
  });

  test("credential expiry is persisted and blocks authentication and rotation", async () => {
    const { dbPath, authority: store } = await authority({ credentialTtlMs: 1_000 });
    const now = new Date("2026-07-12T10:00:00.000Z");
    const minted = store.mintPairingGrant({
      deviceName: "short-lived",
      capabilities: ["read"],
      now,
    });
    expect(minted.kind).toBe("minted");
    if (minted.kind !== "minted") return;
    const paired = store.exchangePairingCode({ pairingCode: minted.pairingCode, now });
    expect(paired.kind).toBe("paired");
    if (paired.kind !== "paired") return;
    const expiresAt = new Date(now.getTime() + 1_000).toISOString();
    expect(paired).toMatchObject({
      credentialId: expect.any(String),
      credentialExpiresAt: expiresAt,
      device: { name: "short-lived", credentialExpiresAt: expiresAt },
    });
    store.close();

    const reopened = await openDeviceAuthority({ path: dbPath });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    const atExpiry = new Date(now.getTime() + 1_000);
    expect(reopened.value.authority.authenticate({
      credential: paired.credential,
      now: atExpiry,
    })).toEqual({ kind: "expired" });
    expect(reopened.value.authority.rotateDeviceCredential({
      deviceId: paired.device.id,
      now: atExpiry,
    })).toEqual({ kind: "expired" });
    reopened.value.authority.close();
  });

  test("two independently opened authorities exchange one code with exactly one winner", async () => {
    const { dbPath, authority: first } = await authority();
    const secondOpened = await openDeviceAuthority({ path: dbPath });
    expect(secondOpened.ok).toBe(true);
    if (!secondOpened.ok) return;
    const second = secondOpened.value.authority;
    const minted = first.mintPairingGrant({
      deviceName: "single phone",
      capabilities: ["read"],
    });
    expect(minted.kind).toBe("minted");
    if (minted.kind !== "minted") return;

    const outcomes = await Promise.all([
      Promise.resolve().then(() => first.exchangePairingCode({ pairingCode: minted.pairingCode })),
      Promise.resolve().then(() => second.exchangePairingCode({ pairingCode: minted.pairingCode })),
    ]);
    expect(outcomes.filter((outcome) => outcome.kind === "paired")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === "consumed")).toHaveLength(1);
    expect(first.listDevices()).toHaveLength(1);
    first.close();
    second.close();
  });

  test("two-handle rotate race preserves history and leaves one returned credential active", async () => {
    const { dbPath, authority: first } = await authority();
    const original = pair(first, "rotation race").exchanged;
    const secondOpened = await openDeviceAuthority({ path: dbPath });
    expect(secondOpened.ok).toBe(true);
    if (!secondOpened.ok) return;
    const second = secondOpened.value.authority;

    const outcomes = await Promise.all([
      Promise.resolve().then(() => first.rotateDeviceCredential({ deviceId: original.device.id })),
      Promise.resolve().then(() => second.rotateDeviceCredential({ deviceId: original.device.id })),
    ]);
    const rotated = outcomes.filter((outcome) => outcome.kind === "rotated");
    expect(rotated).toHaveLength(2);
    const auth = rotated.map((outcome) =>
      outcome.kind === "rotated"
        ? first.authenticate({ credential: outcome.credential })
        : { kind: "invalid" as const },
    );
    expect(auth.filter((outcome) => outcome.kind === "authenticated")).toHaveLength(1);
    expect(auth.filter((outcome) => outcome.kind === "invalid")).toHaveLength(1);

    const inspection = new Database(dbPath);
    const history = inspection.query<{
      id: string;
      rotated_at: string | null;
      revoked_at: string | null;
    }, []>("SELECT id, rotated_at, revoked_at FROM device_credentials ORDER BY rowid").all();
    expect(history).toHaveLength(3);
    expect(history.filter((row) => row.rotated_at === null && row.revoked_at === null))
      .toHaveLength(1);
    inspection.close();
    first.close();
    second.close();
  });

  test("two-handle rotate versus revoke cannot leave an active credential", async () => {
    const { dbPath, authority: first } = await authority();
    const original = pair(first, "revoke race").exchanged;
    const secondOpened = await openDeviceAuthority({ path: dbPath });
    expect(secondOpened.ok).toBe(true);
    if (!secondOpened.ok) return;
    const second = secondOpened.value.authority;

    const [rotation, revocation] = await Promise.all([
      Promise.resolve().then(() => first.rotateDeviceCredential({ deviceId: original.device.id })),
      Promise.resolve().then(() => second.revokeDevice({ deviceId: original.device.id })),
    ]);
    expect(revocation.kind).toBe("revoked");
    expect(["rotated", "revoked"]).toContain(rotation.kind);
    expect(first.authenticate({ credential: original.credential })).toEqual({ kind: "revoked" });
    if (rotation.kind === "rotated") {
      expect(first.authenticate({ credential: rotation.credential })).toEqual({ kind: "revoked" });
    }
    const inspection = new Database(dbPath);
    const credentials = inspection.query<{ revoked_at: string | null }, []>(
      "SELECT revoked_at FROM device_credentials",
    ).all();
    expect(credentials.length).toBeGreaterThanOrEqual(1);
    expect(credentials.every((row) => row.revoked_at !== null)).toBe(true);
    inspection.close();
    first.close();
    second.close();
  });

  test("two-handle rotate versus epoch invalidation cannot preserve old authority", async () => {
    const { dbPath, authority: first } = await authority();
    const original = pair(first, "epoch race").exchanged;
    const secondOpened = await openDeviceAuthority({ path: dbPath });
    expect(secondOpened.ok).toBe(true);
    if (!secondOpened.ok) return;
    const second = secondOpened.value.authority;

    const [rotation, invalidation] = await Promise.all([
      Promise.resolve().then(() => first.rotateDeviceCredential({ deviceId: original.device.id })),
      Promise.resolve().then(() => second.invalidateAll()),
    ]);
    expect(invalidation.authEpoch).toBe(2);
    expect(["rotated", "epoch-invalid"]).toContain(rotation.kind);
    expect(["invalid", "epoch-invalid"]).toContain(
      first.authenticate({ credential: original.credential }).kind,
    );
    if (rotation.kind === "rotated") {
      expect(first.authenticate({ credential: rotation.credential })).toEqual({ kind: "epoch-invalid" });
    }
    first.close();
    second.close();
  });

  test("two-handle authenticate versus revoke has a revoked final state", async () => {
    const { dbPath, authority: first } = await authority();
    const paired = pair(first, "auth race").exchanged;
    const secondOpened = await openDeviceAuthority({ path: dbPath });
    expect(secondOpened.ok).toBe(true);
    if (!secondOpened.ok) return;
    const second = secondOpened.value.authority;

    const [authentication, revocation] = await Promise.all([
      Promise.resolve().then(() => first.authenticate({ credential: paired.credential })),
      Promise.resolve().then(() => second.revokeDevice({ deviceId: paired.device.id })),
    ]);
    expect(["authenticated", "revoked"]).toContain(authentication.kind);
    expect(revocation.kind).toBe("revoked");
    expect(first.authenticate({ credential: paired.credential })).toEqual({ kind: "revoked" });
    first.close();
    second.close();
  });

  test("incrementing auth epoch invalidates every device and unconsumed grant", async () => {
    const { dbPath, authority: store } = await authority();
    const paired = pair(store, "desktop").exchanged;
    const oldGrant = store.mintPairingGrant({ deviceName: "old", capabilities: ["read"] });
    expect(oldGrant.kind).toBe("minted");
    if (oldGrant.kind !== "minted") return;
    const invalidated = store.invalidateAll({ now: new Date("2026-07-11T14:00:00.000Z") });
    expect(invalidated.authEpoch).toBe(2);
    expect(store.authenticate({ credential: paired.credential })).toEqual({ kind: "epoch-invalid" });
    expect(store.rotateDeviceCredential({ deviceId: paired.device.id })).toEqual({ kind: "epoch-invalid" });
    expect(store.exchangePairingCode({ pairingCode: oldGrant.pairingCode }))
      .toEqual({ kind: "epoch-invalid" });

    const newGrant = store.mintPairingGrant({ deviceName: "new", capabilities: ["read"] });
    expect(newGrant.kind).toBe("minted");
    if (newGrant.kind !== "minted") return;
    const next = store.exchangePairingCode({ pairingCode: newGrant.pairingCode });
    expect(next).toMatchObject({ kind: "paired", device: { authEpoch: 2 } });
    if (next.kind !== "paired") return;
    store.close();

    const reopened = await openDeviceAuthority({ path: dbPath });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.value.authority.authEpoch()).toBe(2);
    expect(reopened.value.authority.authenticate({ credential: paired.credential }))
      .toEqual({ kind: "epoch-invalid" });
    expect(reopened.value.authority.authenticate({ credential: next.credential }))
      .toMatchObject({ kind: "authenticated", device: { authEpoch: 2 } });
    reopened.value.authority.close();
  });
});
