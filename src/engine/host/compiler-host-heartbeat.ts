import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const HEARTBEAT_SCHEMA = "dome.compiler-host-heartbeat/v1";

export type ServeHeartbeatStatus =
  | {
      readonly status: "off";
      readonly pid: null;
      readonly branch: null;
      readonly updatedAt: null;
      readonly staleAfterMs: null;
    }
  | {
      readonly status: "running" | "stale";
      readonly pid: number | null;
      readonly branch: string | null;
      readonly updatedAt: string | null;
      readonly staleAfterMs: number | null;
    };

export type ServeHeartbeatHandle = {
  readonly token: string;
  readonly startedAt: string;
};

type ServeHeartbeatFile = {
  readonly schema: typeof HEARTBEAT_SCHEMA;
  readonly token: string;
  readonly command: "serve";
  readonly pid: number;
  readonly hostname: string;
  readonly branch: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly pollIntervalMs: number;
  readonly operationalIntervalMs: number;
  readonly staleAfterMs: number;
};

type HeartbeatReadResult =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "ok"; readonly heartbeat: ServeHeartbeatFile };

export function createServeHeartbeatHandle(
  now: Date = new Date(),
): ServeHeartbeatHandle {
  return Object.freeze({
    token: randomUUID(),
    startedAt: now.toISOString(),
  });
}

export async function writeServeHeartbeat(opts: {
  readonly vaultPath: string;
  readonly handle: ServeHeartbeatHandle;
  readonly branch: string;
  readonly pollIntervalMs: number;
  readonly operationalIntervalMs: number;
  readonly now?: Date;
}): Promise<void> {
  const now = opts.now ?? new Date();
  const heartbeat: ServeHeartbeatFile = {
    schema: HEARTBEAT_SCHEMA,
    token: opts.handle.token,
    command: "serve",
    pid: process.pid,
    hostname: hostname(),
    branch: opts.branch,
    startedAt: opts.handle.startedAt,
    updatedAt: now.toISOString(),
    pollIntervalMs: opts.pollIntervalMs,
    operationalIntervalMs: opts.operationalIntervalMs,
    staleAfterMs: staleAfterMs(opts.pollIntervalMs, opts.operationalIntervalMs),
  };
  const path = serveHeartbeatPath(opts.vaultPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(heartbeat)}\n`, "utf8");
}

export async function clearServeHeartbeat(opts: {
  readonly vaultPath: string;
  readonly handle: ServeHeartbeatHandle;
}): Promise<void> {
  const path = serveHeartbeatPath(opts.vaultPath);
  const read = await readHeartbeatFile(path);
  if (read.kind !== "ok" || read.heartbeat.token !== opts.handle.token) return;
  try {
    await unlink(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

export async function readServeHeartbeatStatus(opts: {
  readonly vaultPath: string;
  readonly now?: Date;
}): Promise<ServeHeartbeatStatus> {
  const read = await readHeartbeatFile(serveHeartbeatPath(opts.vaultPath));
  if (read.kind === "missing") {
    return Object.freeze({
      status: "off" as const,
      pid: null,
      branch: null,
      updatedAt: null,
      staleAfterMs: null,
    });
  }
  if (read.kind === "invalid") {
    return Object.freeze({
      status: "stale" as const,
      pid: null,
      branch: null,
      updatedAt: null,
      staleAfterMs: null,
    });
  }

  const { heartbeat } = read;
  const updatedAtMs = Date.parse(heartbeat.updatedAt);
  const ageMs = Number.isFinite(updatedAtMs)
    ? (opts.now ?? new Date()).getTime() - updatedAtMs
    : Number.POSITIVE_INFINITY;
  const expired = ageMs > heartbeat.staleAfterMs;
  const sameHost = heartbeat.hostname === hostname();
  const pidAlive = !sameHost || isPidAlive(heartbeat.pid);
  const status = expired || !pidAlive ? "stale" : "running";

  return Object.freeze({
    status,
    pid: heartbeat.pid,
    branch: heartbeat.branch,
    updatedAt: heartbeat.updatedAt,
    staleAfterMs: heartbeat.staleAfterMs,
  });
}

export function serveHeartbeatPath(vaultPath: string): string {
  return join(vaultPath, ".dome", "state", "serve-heartbeat.json");
}

async function readHeartbeatFile(
  path: string,
): Promise<HeartbeatReadResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return Object.freeze({ kind: "missing" as const });
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ServeHeartbeatFile>;
    if (
      parsed.schema !== HEARTBEAT_SCHEMA ||
      parsed.command !== "serve" ||
      typeof parsed.token !== "string" ||
      !isPositiveInteger(parsed.pid) ||
      typeof parsed.hostname !== "string" ||
      typeof parsed.branch !== "string" ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      !isPositiveInteger(parsed.pollIntervalMs) ||
      !isPositiveInteger(parsed.operationalIntervalMs) ||
      !isPositiveInteger(parsed.staleAfterMs)
    ) {
      return Object.freeze({ kind: "invalid" as const });
    }
    return Object.freeze({
      kind: "ok" as const,
      heartbeat: Object.freeze({
        schema: parsed.schema,
        token: parsed.token,
        command: parsed.command,
        pid: parsed.pid,
        hostname: parsed.hostname,
        branch: parsed.branch,
        startedAt: parsed.startedAt,
        updatedAt: parsed.updatedAt,
        pollIntervalMs: parsed.pollIntervalMs,
        operationalIntervalMs: parsed.operationalIntervalMs,
        staleAfterMs: parsed.staleAfterMs,
      }),
    });
  } catch {
    return Object.freeze({ kind: "invalid" as const });
  }
}

function staleAfterMs(pollIntervalMs: number, operationalIntervalMs: number): number {
  return Math.max(5_000, pollIntervalMs * 4, operationalIntervalMs * 4);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
