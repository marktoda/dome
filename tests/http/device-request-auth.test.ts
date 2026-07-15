import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openDeviceAuthority,
  type DeviceAuthority,
} from "../../src/device-authority/device-authority";
import {
  authenticateDeviceRequest,
  exchangeDevicePairing,
  hardenDeviceResponse,
} from "../../src/http/device-request-auth";

const roots: string[] = [];
const NOW = new Date("2026-07-12T12:00:00.000Z");
const ORIGIN = "https://dome.tail.example:8443";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(capabilities: Array<"read" | "capture" | "author"> = ["read"]): Promise<{
  readonly authority: DeviceAuthority;
  readonly deviceCookie: string;
  readonly csrfCookie: string;
  readonly credential: string;
  readonly csrf: string;
  readonly deviceId: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "dome-device-request-auth-"));
  roots.push(root);
  const opened = await openDeviceAuthority({
    path: join(root, "device-authority.db"),
    credentialTtlMs: 60_000,
  });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error("authority did not open");
  const authority = opened.value.authority;
  const minted = authority.mintPairingGrant({
    deviceName: "Test phone",
    capabilities,
    now: NOW,
  });
  expect(minted.kind).toBe("minted");
  if (minted.kind !== "minted") throw new Error("grant did not mint");
  const exchanged = exchangeDevicePairing(authority, {
    pairingCode: minted.pairingCode,
    requestOrigin: ORIGIN,
    now: NOW,
    requestId: "req_pair",
  });
  expect(exchanged.ok).toBe(true);
  if (!exchanged.ok) throw new Error("grant did not exchange");
  const deviceCookie = exchanged.setCookies[0].split(";", 1)[0]!;
  const csrfCookie = exchanged.setCookies[1].split(";", 1)[0]!;
  return {
    authority,
    deviceCookie,
    csrfCookie,
    credential: decodeURIComponent(deviceCookie.slice("dome_device=".length)),
    csrf: decodeURIComponent(csrfCookie.slice("dome_csrf=".length)),
    deviceId: exchanged.deviceId,
  };
}

function request(input: {
  readonly method?: string;
  readonly cookie?: string;
  readonly authorization?: string;
  readonly origin?: string;
  readonly csrf?: string;
} = {}): Request {
  const headers = new Headers();
  if (input.cookie !== undefined) headers.set("cookie", input.cookie);
  if (input.authorization !== undefined) headers.set("authorization", input.authorization);
  if (input.origin !== undefined) headers.set("origin", input.origin);
  if (input.csrf !== undefined) headers.set("x-dome-csrf", input.csrf);
  return new Request(`${ORIGIN}/capture`, {
    method: input.method ?? "GET",
    headers,
    ...((input.method ?? "GET") === "POST" ? { body: "{}" } : {}),
  });
}

describe("exchangeDevicePairing", () => {
  test("issues host-only strict secure device and CSRF cookies", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-device-pair-http-"));
    roots.push(root);
    const opened = await openDeviceAuthority({
      path: join(root, "authority.db"),
      credentialTtlMs: 60_000,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const authority = opened.value.authority;
    const minted = authority.mintPairingGrant({
      deviceName: "Phone",
      capabilities: ["capture", "read"],
      now: NOW,
    });
    expect(minted.kind).toBe("minted");
    if (minted.kind !== "minted") return;
    const result = exchangeDevicePairing(authority, {
      pairingCode: minted.pairingCode,
      requestOrigin: ORIGIN,
      now: NOW,
      requestId: "req_pair",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requestId).toBe("req_pair");
    expect(result.cookieSecurity).toBe("secure");
    expect([...result.capabilities]).toEqual(["capture", "read"]);
    expect(result.setCookies[0]).toContain("dome_device=");
    expect(result.setCookies[0]).toContain("Secure; SameSite=Strict; HttpOnly");
    expect(result.setCookies[1]).toContain("dome_csrf=");
    expect(result.setCookies[1]).toContain("Secure; SameSite=Strict");
    expect(result.setCookies[1]).not.toContain("HttpOnly");
    for (const cookie of result.setCookies) {
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("Max-Age=60");
      expect(cookie).not.toContain("Domain=");
    }
    const replay = exchangeDevicePairing(authority, {
      pairingCode: minted.pairingCode,
      requestOrigin: ORIGIN,
      now: NOW,
      requestId: "req_replay",
    });
    expect(replay).toMatchObject({
      ok: false,
      failure: { status: 401, code: "pairing-consumed", requestId: "req_replay" },
    });
    expect(JSON.stringify(replay)).not.toContain(minted.pairingCode);
    authority.close();
  });

  test("uses non-Secure cookies only for explicit HTTP loopback development origins", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-device-pair-profile-"));
    roots.push(root);
    const opened = await openDeviceAuthority({ path: join(root, "authority.db") });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const authority = opened.value.authority;
    const mint = (name: string) => authority.mintPairingGrant({
      deviceName: name,
      capabilities: ["read"],
      now: NOW,
    });

    const local = mint("Vite browser");
    expect(local.kind).toBe("minted");
    if (local.kind !== "minted") return;
    const localResult = exchangeDevicePairing(authority, {
      pairingCode: local.pairingCode,
      requestOrigin: "http://localhost:5173",
      now: NOW,
    });
    expect(localResult.ok).toBe(true);
    if (!localResult.ok) return;
    expect(localResult.cookieSecurity).toBe("loopback-development");
    for (const cookie of localResult.setCookies) {
      expect(cookie).not.toContain("; Secure");
      expect(cookie).toContain("SameSite=Strict");
    }

    const insecure = mint("LAN browser");
    expect(insecure.kind).toBe("minted");
    if (insecure.kind !== "minted") return;
    const refused = exchangeDevicePairing(authority, {
      pairingCode: insecure.pairingCode,
      requestOrigin: "http://192.168.1.25:5173",
      now: NOW,
      requestId: "req_insecure",
    });
    expect(refused).toMatchObject({
      ok: false,
      failure: { status: 403, code: "pairing-insecure-origin", requestId: "req_insecure" },
    });
    // Transport rejection happens before authority exchange and cannot burn the code.
    expect(exchangeDevicePairing(authority, {
      pairingCode: insecure.pairingCode,
      requestOrigin: "https://dome.tail.example",
      now: NOW,
    })).toMatchObject({ ok: true, cookieSecurity: "secure" });
    authority.close();
  });
});

describe("authenticateDeviceRequest", () => {
  test("returns a frozen, scoped cookie context for safe reads", async () => {
    const fx = await fixture(["read", "capture"]);
    const result = authenticateDeviceRequest(
      fx.authority,
      request({ cookie: `${fx.deviceCookie}; ${fx.csrfCookie}` }),
      { allowedOrigins: [ORIGIN], now: NOW, requestId: "req_read" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.context)).toBe(true);
    expect(result.context).toMatchObject({
      actorId: "owner",
      deviceId: fx.deviceId,
      requestId: "req_read",
      transport: "cookie",
    });
    expect([...result.context.capabilities]).toEqual(["capture", "read"]);
    expect(Object.isFrozen(result.context.capabilities)).toBe(true);
    expect("add" in result.context.capabilities).toBe(false);
    fx.authority.close();
  });

  test("cookie mutation requires exact canonical Origin and double-submit CSRF", async () => {
    const fx = await fixture(["capture"]);
    const cookie = `${fx.deviceCookie}; ${fx.csrfCookie}`;
    const attempt = (input: { origin?: string; csrf?: string; cookie?: string }) =>
      authenticateDeviceRequest(
        fx.authority,
        request({ method: "POST", cookie: input.cookie ?? cookie, ...input }),
        { allowedOrigins: [ORIGIN], now: NOW, requestId: "req_write" },
      );
    expect(attempt({ csrf: fx.csrf })).toMatchObject({
      ok: false,
      failure: { status: 403, code: "origin-required" },
    });
    expect(attempt({ origin: "https://dome.tail.example", csrf: fx.csrf })).toMatchObject({
      ok: false,
      failure: { status: 403, code: "origin-forbidden" },
    });
    expect(attempt({ origin: ORIGIN })).toMatchObject({
      ok: false,
      failure: { status: 403, code: "csrf-required" },
    });
    expect(attempt({ origin: ORIGIN, csrf: "wrong" })).toMatchObject({
      ok: false,
      failure: { status: 403, code: "csrf-invalid" },
    });
    expect(attempt({
      origin: ORIGIN,
      csrf: fx.csrf,
      cookie: `${fx.deviceCookie}; dome_csrf=wrong`,
    })).toMatchObject({ ok: false, failure: { code: "csrf-invalid" } });
    expect(attempt({ origin: ORIGIN, csrf: fx.csrf })).toMatchObject({
      ok: true,
      context: { transport: "cookie" },
    });

    // Default ports and host casing canonicalize; a non-default port remains exact.
    const canonical = authenticateDeviceRequest(
      fx.authority,
      request({ method: "POST", cookie, origin: "https://DOME.tail.example", csrf: fx.csrf }),
      { allowedOrigins: ["https://dome.tail.example:443"], now: NOW },
    );
    expect(canonical.ok).toBe(true);
    fx.authority.close();
  });

  test("bearer skips CSRF but rejects any untrusted Origin", async () => {
    const fx = await fixture(["author", "read"]);
    const authenticate = (origin?: string) => authenticateDeviceRequest(
      fx.authority,
      request({
        authorization: `Bearer ${fx.credential}`,
        ...(origin !== undefined ? { origin } : {}),
      }),
      { allowedOrigins: [ORIGIN], now: NOW, requestId: "req_bearer" },
    );
    expect(authenticate()).toMatchObject({
      ok: true,
      context: { transport: "bearer", requestId: "req_bearer" },
    });
    expect(authenticate(ORIGIN)).toMatchObject({ ok: true });
    expect(authenticate("https://dome.tail.example:9443")).toMatchObject({
      ok: false,
      failure: { status: 403, code: "origin-forbidden" },
    });
    fx.authority.close();
  });

  test("rejects malformed, duplicate, and ambiguous authentication", async () => {
    const fx = await fixture();
    const auth = (req: Request) => authenticateDeviceRequest(fx.authority, req, {
      allowedOrigins: [ORIGIN],
      now: NOW,
    });
    expect(auth(request())).toMatchObject({ ok: false, failure: { code: "auth-required" } });
    expect(auth(request({ cookie: `${fx.deviceCookie}; ${fx.deviceCookie}` })))
      .toMatchObject({ ok: false, failure: { code: "auth-malformed" } });
    expect(auth(request({ cookie: `${fx.deviceCookie}; ${fx.csrfCookie}; ${fx.csrfCookie}` })))
      .toMatchObject({ ok: false, failure: { code: "auth-malformed" } });
    expect(auth(request({ cookie: "broken-cookie" })))
      .toMatchObject({ ok: false, failure: { code: "auth-malformed" } });
    expect(auth(request({
      cookie: fx.deviceCookie,
      authorization: `Bearer ${fx.credential}`,
    }))).toMatchObject({ ok: false, failure: { code: "auth-malformed" } });
    fx.authority.close();
  });

  test("revocation and rotation take effect on the next request", async () => {
    const revoked = await fixture();
    expect(revoked.authority.revokeDevice({ deviceId: revoked.deviceId }).kind).toBe("revoked");
    expect(authenticateDeviceRequest(
      revoked.authority,
      request({ authorization: `Bearer ${revoked.credential}` }),
      { allowedOrigins: [ORIGIN], now: NOW },
    )).toMatchObject({
      ok: false,
      failure: { status: 401, code: "credential-invalid" },
    });
    revoked.authority.close();

    const rotated = await fixture();
    const next = rotated.authority.rotateDeviceCredential({ deviceId: rotated.deviceId, now: NOW });
    expect(next.kind).toBe("rotated");
    if (next.kind !== "rotated") return;
    expect(authenticateDeviceRequest(
      rotated.authority,
      request({ authorization: `Bearer ${rotated.credential}` }),
      { allowedOrigins: [ORIGIN], now: NOW },
    )).toMatchObject({ ok: false, failure: { code: "credential-invalid" } });
    expect(authenticateDeviceRequest(
      rotated.authority,
      request({ authorization: `Bearer ${next.credential}` }),
      { allowedOrigins: [ORIGIN], now: NOW },
    )).toMatchObject({
      ok: true,
      context: { credentialId: next.credentialId, transport: "bearer" },
    });
    rotated.authority.close();
  });
});

describe("hardenDeviceResponse", () => {
  test("preserves an explicit static cache policy", () => {
    const response = hardenDeviceResponse(new Response("asset", {
      headers: { "cache-control": "public, max-age=31536000, immutable" },
    }), { requestId: "request-static", preserveStaticCacheControl: true });
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("content-security-policy")).toContain("worker-src 'self'");
    const authenticated = hardenDeviceResponse(new Response("private", {
      headers: { "cache-control": "public, max-age=31536000, immutable" },
    }), { requestId: "request-private" });
    expect(authenticated.headers.get("cache-control")).toBe("no-store");
  });

  test("adds strict PWA-compatible headers, no-store, request id, and strips CORS", async () => {
    const response = hardenDeviceResponse(new Response("ok", {
      status: 201,
      headers: {
        "content-type": "text/plain",
        "access-control-allow-origin": "*",
        "access-control-allow-credentials": "true",
      },
    }), { requestId: "req_headers" });
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("content-security-policy")).toContain("worker-src 'self' blob:");
    expect(response.headers.get("content-security-policy")).toContain(
      "style-src-attr 'unsafe-inline'",
    );
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("permissions-policy")).toContain("microphone=(self)");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-dome-request-id")).toBe("req_headers");
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect(response.headers.has("access-control-allow-credentials")).toBe(false);

    const error = hardenDeviceResponse(
      new Response('{"code":"credential-invalid"}', { status: 401 }),
      { requestId: "req_error" },
    );
    expect(error.status).toBe(401);
    expect(error.headers.get("cache-control")).toBe("no-store");
    expect(error.headers.get("x-dome-request-id")).toBe("req_error");
    expect(error.headers.get("content-security-policy")).toContain("default-src 'self'");
  });
});
