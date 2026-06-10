// engine/host/model-provider-probe-cache: the persisted last-probe result for the
// configured command model provider.
//
// The probe itself (`probeCommandModelProvider`) spawns the provider command
// with up to an 8s timeout — far too expensive for `dome status`, the cheap
// session pulse. `dome doctor` (the probe verb) and `dome status --probe`
// persist the outcome here, in the vault's gitignored derived-state dir, so
// a plain `dome status` can report last-known provider reachability for the
// cost of one small JSON file read. The cache is keyed to the exact provider
// command: a config change invalidates it implicitly (readers must check
// `probeCacheMatchesCommand`), so stale attention never survives a provider
// swap.
//
// This is derived operational state, same class as the serve heartbeat —
// safe to delete, rebuilt by the next probe.

import { existsSync, readFileSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import type { ModelProviderProbeResult } from "./command-model-provider";

const CACHE_SCHEMA = "dome.model-provider.probe-cache/v1";

export type ModelProviderProbeCache = {
  readonly schema: typeof CACHE_SCHEMA;
  /** The provider command the probe ran — the cache key. */
  readonly command: ReadonlyArray<string>;
  /** ISO timestamp of the probe. */
  readonly probedAt: string;
  readonly result: ModelProviderProbeResult;
};

const ProbeResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("responsive"),
    provider: z.string().optional(),
    keyPresent: z.boolean().optional(),
    defaultModel: z.string().optional(),
  }),
  z.object({ status: z.literal("probe-unsupported"), detail: z.string() }),
  z.object({ status: z.literal("spawn-failed"), detail: z.string() }),
  z.object({ status: z.literal("invalid-response"), detail: z.string() }),
  z.object({ status: z.literal("timed-out"), detail: z.string() }),
]);

const ProbeCacheSchema = z.object({
  schema: z.literal(CACHE_SCHEMA),
  command: z.array(z.string()),
  probedAt: z.string(),
  result: ProbeResultSchema,
});

function cachePath(vaultPath: string): string {
  return join(vaultPath, ".dome", "state", "model-provider-probe.json");
}

/**
 * Read the cached last-probe result. Returns null when the cache is absent,
 * unreadable, or malformed — a corrupt cache degrades to "never probed",
 * never to an error.
 */
export function readModelProviderProbeCache(
  vaultPath: string,
): ModelProviderProbeCache | null {
  const path = cachePath(vaultPath);
  if (!existsSync(path)) return null;
  try {
    const parsed = ProbeCacheSchema.safeParse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    if (!parsed.success) return null;
    return Object.freeze({
      schema: CACHE_SCHEMA,
      command: Object.freeze([...parsed.data.command]),
      probedAt: parsed.data.probedAt,
      result: normalizeResult(parsed.data.result),
    });
  } catch {
    return null;
  }
}

/** Drop undefined-valued optional keys so the parsed shape satisfies exactOptionalPropertyTypes. */
function normalizeResult(
  result: z.infer<typeof ProbeResultSchema>,
): ModelProviderProbeResult {
  if (result.status === "responsive") {
    return Object.freeze({
      status: "responsive" as const,
      ...(result.provider !== undefined ? { provider: result.provider } : {}),
      ...(result.keyPresent !== undefined
        ? { keyPresent: result.keyPresent }
        : {}),
      ...(result.defaultModel !== undefined
        ? { defaultModel: result.defaultModel }
        : {}),
    });
  }
  return Object.freeze({ status: result.status, detail: result.detail });
}

/**
 * Persist a probe outcome. Best-effort: callers treat a write failure as
 * non-fatal (the probe verb already reported the live result).
 */
export function writeModelProviderProbeCache(
  vaultPath: string,
  cache: {
    readonly command: ReadonlyArray<string>;
    readonly probedAt: Date;
    readonly result: ModelProviderProbeResult;
  },
): void {
  try {
    mkdirSync(join(vaultPath, ".dome", "state"), { recursive: true });
    const payload: ModelProviderProbeCache = {
      schema: CACHE_SCHEMA,
      command: [...cache.command],
      probedAt: cache.probedAt.toISOString(),
      result: cache.result,
    };
    writeFileSync(cachePath(vaultPath), `${JSON.stringify(payload, null, 2)}\n`);
  } catch {
    // Best-effort derived state; the live probe result was already reported.
  }
}

/** True when the cached probe ran the same provider command the vault is configured with now. */
export function probeCacheMatchesCommand(
  cache: ModelProviderProbeCache,
  command: ReadonlyArray<string>,
): boolean {
  return (
    cache.command.length === command.length &&
    cache.command.every((part, index) => part === command[index])
  );
}

/**
 * True when a probe result means the provider is unreachable — the same
 * classification `dome doctor` maps to the `model.provider-unreachable`
 * error finding (`responsive` and `probe-unsupported` are both "alive").
 */
export function probeResultUnreachable(
  result: ModelProviderProbeResult,
): boolean {
  return (
    result.status === "spawn-failed" ||
    result.status === "invalid-response" ||
    result.status === "timed-out"
  );
}
