// HTTP device request authentication: a protocol Adapter over the durable
// DeviceAuthority. It owns cookie/header parsing, origin and double-submit
// CSRF policy, request identity, and public error redaction; it owns no auth
// state and returns no framework-specific route response.

import { randomUUID, timingSafeEqual } from "node:crypto";

import type { Capability } from "../capabilities";
import type { DeviceAuthority, PairingExchangeResult } from "../device-authority/device-authority";

export const DEVICE_COOKIE = "dome_device" as const;
export const CSRF_COOKIE = "dome_csrf" as const;

export type DeviceRequestContext = Readonly<{
  actorId: "owner";
  deviceId: string;
  deviceName: string;
  credentialId: string;
  requestId: string;
  capabilities: ReadonlySet<Capability>;
  transport: "cookie" | "bearer";
}>;

export type DeviceAuthFailureCode =
  | "auth-required"
  | "auth-malformed"
  | "credential-invalid"
  | "credential-revoked"
  | "credential-expired"
  | "credential-invalidated"
  | "origin-required"
  | "origin-forbidden"
  | "csrf-required"
  | "csrf-invalid";

export type DeviceAuthFailure = Readonly<{
  status: 401 | 403;
  code: DeviceAuthFailureCode;
  message: string;
  requestId: string;
}>;

export type AuthenticateDeviceRequestResult =
  | { readonly ok: true; readonly context: DeviceRequestContext }
  | { readonly ok: false; readonly failure: DeviceAuthFailure };

export type PairingHttpFailureCode =
  | "pairing-invalid"
  | "pairing-expired"
  | "pairing-limited"
  | "pairing-consumed"
  | "pairing-invalidated"
  | "pairing-insecure-origin";

export type ExchangeDevicePairingResult =
  | Readonly<{
      ok: true;
      requestId: string;
      deviceId: string;
      deviceName: string;
      credentialId: string;
      credentialExpiresAt: string;
      cookieSecurity: "secure" | "loopback-development";
      csrfToken: string;
      capabilities: ReadonlySet<Capability>;
      setCookies: readonly [deviceCookie: string, csrfCookie: string];
    }>
  | Readonly<{
      ok: false;
      failure: Readonly<{
        status: 401 | 403;
        code: PairingHttpFailureCode;
        message: string;
        requestId: string;
      }>;
    }>;

export function exchangeDevicePairing(
  authority: DeviceAuthority,
  input: {
    readonly pairingCode: string;
    readonly requestOrigin: string;
    readonly now?: Date;
    readonly requestId?: string;
  },
): ExchangeDevicePairingResult {
  const requestId = input.requestId ?? randomUUID();
  const now = input.now ?? new Date();
  const cookieSecurity = cookieSecurityForOrigin(input.requestOrigin);
  if (cookieSecurity === null) {
    return Object.freeze({
      ok: false as const,
      failure: Object.freeze({
        status: 403 as const,
        code: "pairing-insecure-origin" as const,
        message: publicMessage("pairing-insecure-origin"),
        requestId,
      }),
    });
  }
  const exchanged = authority.exchangePairingCode({
    pairingCode: input.pairingCode,
    now,
  });
  if (exchanged.kind !== "paired") {
    return Object.freeze({
      ok: false as const,
      failure: pairingFailure(exchanged, requestId),
    });
  }
  const maxAge = Math.max(
    1,
    Math.floor((Date.parse(exchanged.credentialExpiresAt) - now.getTime()) / 1_000),
  );
  const secure = cookieSecurity === "secure" ? "; Secure" : "";
  const common = `Path=/; Max-Age=${maxAge}; Expires=${new Date(exchanged.credentialExpiresAt).toUTCString()}${secure}; SameSite=Strict`;
  return Object.freeze({
    ok: true as const,
    requestId,
    deviceId: exchanged.device.id,
    deviceName: exchanged.device.name,
    credentialId: exchanged.credentialId,
    credentialExpiresAt: exchanged.credentialExpiresAt,
    cookieSecurity,
    csrfToken: exchanged.csrfSecret,
    capabilities: immutableCapabilities(exchanged.device.capabilities),
    setCookies: Object.freeze([
      `${DEVICE_COOKIE}=${encodeURIComponent(exchanged.credential)}; ${common}; HttpOnly`,
      `${CSRF_COOKIE}=${encodeURIComponent(exchanged.csrfSecret)}; ${common}`,
    ]) as readonly [string, string],
  });
}

export function authenticateDeviceRequest(
  authority: DeviceAuthority,
  request: Request,
  options: {
    readonly allowedOrigins: ReadonlyArray<string>;
    readonly now?: Date;
    readonly requestId?: string;
  },
): AuthenticateDeviceRequestResult {
  const requestId = options.requestId ?? randomUUID();
  const allowedOrigins = new Set(options.allowedOrigins.map(canonicalOrigin));
  const parsedCookies = parseCookies(request.headers.get("cookie"));
  if (!parsedCookies.ok) return failed(401, "auth-malformed", requestId);

  const authorization = request.headers.get("authorization");
  const bearer = parseBearer(authorization);
  if (authorization !== null && bearer === null) {
    return failed(401, "auth-malformed", requestId);
  }
  const cookieCredential = parsedCookies.values.get(DEVICE_COOKIE);
  if (bearer !== null && cookieCredential !== undefined) {
    return failed(401, "auth-malformed", requestId);
  }
  if (bearer === null && cookieCredential === undefined) {
    return failed(401, "auth-required", requestId);
  }

  const transport = bearer === null ? "cookie" as const : "bearer" as const;
  const credential = bearer ?? cookieCredential!;
  const originHeader = request.headers.get("origin");
  const origin = originHeader === null ? null : tryCanonicalOrigin(originHeader);

  if (transport === "bearer") {
    if (originHeader !== null && (origin === null || !allowedOrigins.has(origin))) {
      return failed(403, "origin-forbidden", requestId);
    }
  } else if (!isSafeMethod(request.method)) {
    if (originHeader === null) return failed(403, "origin-required", requestId);
    if (origin === null || !allowedOrigins.has(origin)) {
      return failed(403, "origin-forbidden", requestId);
    }
    const csrfCookie = parsedCookies.values.get(CSRF_COOKIE);
    const csrfHeader = request.headers.get("x-dome-csrf");
    if (csrfCookie === undefined || csrfHeader === null) {
      return failed(403, "csrf-required", requestId);
    }
    if (!sameSecret(csrfCookie, csrfHeader)) {
      return failed(403, "csrf-invalid", requestId);
    }
  }

  const csrf = transport === "cookie" && !isSafeMethod(request.method)
    ? request.headers.get("x-dome-csrf") ?? undefined
    : undefined;
  const authenticated = authority.authenticate({
    credential,
    ...(csrf !== undefined ? { csrfSecret: csrf, requireCsrf: true } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  if (authenticated.kind !== "authenticated") {
    return authorityFailure(authenticated.kind, requestId);
  }
  const context: DeviceRequestContext = Object.freeze({
    actorId: "owner",
    deviceId: authenticated.device.id,
    deviceName: authenticated.device.name,
    credentialId: authenticated.credentialId,
    requestId,
    capabilities: immutableCapabilities(authenticated.device.capabilities),
    transport,
  });
  return Object.freeze({ ok: true as const, context });
}

export function hardenDeviceResponse(
  response: Response,
  input: { readonly requestId: string },
): Response {
  const headers = new Headers(response.headers);
  headers.set(
    "content-security-policy",
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; "
      + "form-action 'self'; script-src 'self'; style-src 'self'; "
      + "style-src-attr 'unsafe-inline'; "
      + "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; "
      + "media-src 'self' blob:; worker-src 'self' blob:; manifest-src 'self'",
  );
  headers.set("x-frame-options", "DENY");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set(
    "permissions-policy",
    "camera=(), geolocation=(), microphone=(self), payment=(), usb=()",
  );
  headers.set("cache-control", "no-store");
  headers.set("x-dome-request-id", input.requestId);
  for (const name of [
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-allow-headers",
    "access-control-allow-methods",
    "access-control-expose-headers",
    "access-control-max-age",
  ]) {
    headers.delete(name);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function pairingFailure(
  result: Exclude<PairingExchangeResult, { readonly kind: "paired" }>,
  requestId: string,
): Readonly<{
  status: 401;
  code: PairingHttpFailureCode;
  message: string;
  requestId: string;
}> {
  const code: PairingHttpFailureCode = result.kind === "expired"
    ? "pairing-expired"
    : result.kind === "limited"
      ? "pairing-limited"
      : result.kind === "consumed"
        ? "pairing-consumed"
        : result.kind === "epoch-invalid"
          ? "pairing-invalidated"
          : "pairing-invalid";
  return Object.freeze({ status: 401, code, message: publicMessage(code), requestId });
}

function authorityFailure(
  kind: "invalid" | "revoked" | "expired" | "epoch-invalid" | "csrf-invalid",
  requestId: string,
): AuthenticateDeviceRequestResult {
  return kind === "csrf-invalid"
    ? failed(403, "csrf-invalid", requestId)
    : failed(401, "credential-invalid", requestId);
}

function failed(
  status: 401 | 403,
  code: DeviceAuthFailureCode,
  requestId: string,
): AuthenticateDeviceRequestResult {
  return Object.freeze({
    ok: false as const,
    failure: Object.freeze({ status, code, message: publicMessage(code), requestId }),
  });
}

function publicMessage(code: DeviceAuthFailureCode | PairingHttpFailureCode): string {
  if (code === "origin-required") return "A trusted request origin is required.";
  if (code === "origin-forbidden") return "The request origin is not allowed.";
  if (code === "csrf-required") return "CSRF verification is required.";
  if (code === "csrf-invalid") return "CSRF verification failed.";
  if (code === "credential-revoked") return "The device credential was revoked.";
  if (code === "credential-expired") return "The device credential expired.";
  if (code === "credential-invalidated") return "The device credential is no longer valid.";
  if (code === "pairing-expired") return "The pairing code expired.";
  if (code === "pairing-limited") return "The pairing code cannot accept more attempts.";
  if (code === "pairing-consumed") return "The pairing code was already used.";
  if (code === "pairing-invalidated") return "The pairing code is no longer valid.";
  if (code === "pairing-invalid") return "The pairing code is invalid.";
  if (code === "pairing-insecure-origin") {
    return "Insecure pairing is allowed only from an explicit loopback development origin.";
  }
  if (code === "auth-required") return "Device authentication is required.";
  return "Device authentication is invalid.";
}

function parseBearer(authorization: string | null): string | null {
  if (authorization === null) return null;
  const match = /^Bearer ([^\s,]+)$/.exec(authorization);
  return match?.[1] ?? null;
}

function parseCookies(header: string | null):
  | { readonly ok: true; readonly values: ReadonlyMap<string, string> }
  | { readonly ok: false } {
  const values = new Map<string, string>();
  if (header === null || header.trim() === "") return { ok: true, values };
  for (const segment of header.split(";")) {
    const item = segment.trim();
    if (item === "") continue;
    const equals = item.indexOf("=");
    if (equals <= 0) return { ok: false };
    const name = item.slice(0, equals).trim();
    const raw = item.slice(equals + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || raw === "" || raw.includes(",")) {
      return { ok: false };
    }
    let value: string;
    try {
      value = decodeURIComponent(raw);
    } catch {
      return { ok: false };
    }
    if ((name === DEVICE_COOKIE || name === CSRF_COOKIE) && values.has(name)) {
      return { ok: false };
    }
    values.set(name, value);
  }
  return { ok: true, values };
}

function canonicalOrigin(input: string): string {
  const origin = tryCanonicalOrigin(input);
  if (origin === null) throw new TypeError(`invalid allowed origin: ${input}`);
  return origin;
}

function tryCanonicalOrigin(input: string): string | null {
  try {
    const url = new URL(input);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function cookieSecurityForOrigin(
  input: string,
): "secure" | "loopback-development" | null {
  const origin = tryCanonicalOrigin(input);
  if (origin === null) return null;
  const url = new URL(origin);
  if (url.protocol === "https:") return "secure";
  return url.protocol === "http:" && isLoopbackHostname(url.hostname)
    ? "loopback-development"
    : null;
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") ||
    host === "127.0.0.1" || host === "[::1]";
}

function isSafeMethod(method: string): boolean {
  return method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD";
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function immutableCapabilities(values: Iterable<Capability>): ReadonlySet<Capability> {
  const target = new Set(values);
  const immutable = new Proxy(target, {
    get(set, property) {
      if (property === "add" || property === "delete" || property === "clear") {
        return undefined;
      }
      const value: unknown = Reflect.get(set, property, set);
      return typeof value === "function" ? value.bind(set) : value;
    },
    has(set, property) {
      if (property === "add" || property === "delete" || property === "clear") {
        return false;
      }
      return Reflect.has(set, property);
    },
  });
  Object.freeze(immutable);
  return immutable;
}
