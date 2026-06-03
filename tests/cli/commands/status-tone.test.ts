import { describe, expect, test } from "bun:test";
import { syncTone, freshnessTone } from "../../../src/cli/commands/status-tone";

describe("syncTone", () => {
  test("diverged → err, needed → warn, ok → ok", () => {
    expect(syncTone({ adopted_diverged: true, sync_needed: true })).toEqual({ tone: "err", label: "diverged" });
    expect(syncTone({ adopted_diverged: false, sync_needed: true })).toEqual({ tone: "warn", label: "needed" });
    expect(syncTone({ adopted_diverged: false, sync_needed: false })).toEqual({ tone: "ok", label: "ok" });
  });
});

describe("freshnessTone", () => {
  test("fresh → ok, stale → warn, cache drift annotated", () => {
    expect(freshnessTone({ projection_stale: false, projection_cache_drift: false })).toEqual({ tone: "ok", label: "fresh" });
    expect(freshnessTone({ projection_stale: true, projection_cache_drift: false })).toEqual({ tone: "warn", label: "stale" });
    expect(freshnessTone({ projection_stale: true, projection_cache_drift: true })).toEqual({ tone: "warn", label: "stale (cache drift)" });
  });
});
