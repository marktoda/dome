import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const COOKIE = "dome_pair";
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1_000;
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES = 5;

export type LoopbackPairing = {
  readonly exchange: (code: string) =>
    | { readonly kind: "paired"; readonly cookie: string; readonly expiresAt: string }
    | { readonly kind: "invalid" }
    | { readonly kind: "limited"; readonly retryAfterSeconds: number };
  readonly authorized: (request: Request) => boolean;
};

/**
 * Process-local browser pairing for the P1 loopback product journey.
 * The browser receives only an opaque HttpOnly cookie; the console code and
 * compatibility bearer never enter browser storage. Durable device authority
 * deliberately remains behind P3's separate Interface.
 */
export function createLoopbackPairing(input: {
  readonly code: string;
  readonly sessionTtlMs?: number;
  readonly now?: () => Date;
  readonly randomSession?: () => string;
}): LoopbackPairing {
  if (input.code.trim().length < 8) {
    throw new Error("loopback pairing code must contain at least 8 characters");
  }
  const expected = digest(input.code);
  const now = input.now ?? (() => new Date());
  const ttlMs = input.sessionTtlMs ?? DEFAULT_TTL_MS;
  const randomSession = input.randomSession ?? (() => randomBytes(32).toString("base64url"));
  const sessions = new Map<string, number>();
  let failures: number[] = [];

  const prune = (at: number): void => {
    failures = failures.filter((time) => at - time < FAILURE_WINDOW_MS);
    for (const [key, expires] of sessions) {
      if (expires <= at) sessions.delete(key);
    }
  };

  return Object.freeze({
    exchange(code) {
      const at = now().getTime();
      prune(at);
      if (failures.length >= MAX_FAILURES) {
        const retryAt = failures[0]! + FAILURE_WINDOW_MS;
        return {
          kind: "limited" as const,
          retryAfterSeconds: Math.max(1, Math.ceil((retryAt - at) / 1_000)),
        };
      }
      if (!timingSafeEqual(digest(code), expected)) {
        failures.push(at);
        return Object.freeze({ kind: "invalid" as const });
      }
      failures = [];
      const session = randomSession();
      const expires = at + ttlMs;
      sessions.set(digest(session).toString("hex"), expires);
      return Object.freeze({
        kind: "paired" as const,
        cookie: `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ttlMs / 1_000)}`,
        expiresAt: new Date(expires).toISOString(),
      });
    },

    authorized(request) {
      const at = now().getTime();
      prune(at);
      const session = readCookie(request.headers.get("cookie"), COOKIE);
      if (session === null) return false;
      return (sessions.get(digest(session).toString("hex")) ?? 0) > at;
    },
  });
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}
