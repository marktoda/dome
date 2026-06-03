// src/cli/commands/status-tone.ts
import type { Status } from "../presenter";

export function syncTone(s: { adopted_diverged: boolean; sync_needed: boolean }): Status {
  if (s.adopted_diverged) return { tone: "err", label: "diverged" };
  if (s.sync_needed) return { tone: "warn", label: "needed" };
  return { tone: "ok", label: "ok" };
}

export function freshnessTone(s: { projection_stale: boolean; projection_cache_drift: boolean }): Status {
  if (!s.projection_stale) return { tone: "ok", label: "fresh" };
  return { tone: "warn", label: s.projection_cache_drift ? "stale (cache drift)" : "stale" };
}
