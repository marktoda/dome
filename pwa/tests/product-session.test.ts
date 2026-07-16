import { describe, expect, test } from "bun:test";
import type { ProductReadiness } from "../../contracts/product-readiness";
import { deriveProductSession } from "../src/connection/product-session";
import { READY_PRODUCT } from "./readiness-fixture";

function readiness(patch: Partial<ProductReadiness>): ProductReadiness {
  return { ...READY_PRODUCT, ...patch };
}

describe("deriveProductSession", () => {
  test("derives a current session and every feature from one validated document", () => {
    expect(deriveProductSession({
      availability: "available",
      readiness: { document: READY_PRODUCT, stale: false, issue: null },
      authRepair: false,
    })).toMatchObject({
      kind: "current",
      access: { read: true, converse: true, voice: true, captureReplay: true, resolve: true },
      recovery: null,
      connection: { label: "ready", tone: "healthy" },
    });
  });

  test("keeps useful features while presenting missing model setup as one recovery", () => {
    const session = deriveProductSession({
      availability: "available",
      readiness: {
        document: readiness({
          model: { state: "unconfigured" },
          transcription: { state: "unreachable" },
        }),
        stale: false,
        issue: null,
      },
      authRepair: false,
    });

    expect(session).toMatchObject({
      kind: "model-missing",
      access: { read: true, converse: false, voice: false, captureReplay: true, resolve: true },
      recovery: { kind: "retry", title: "Ask needs setup", actionLabel: "Check again" },
      connection: { label: "limited", tone: "attention" },
    });
    expect(session.recovery?.detail).toContain("dome home setup configure");
  });

  test("preserves route-level access when host presentation is not ready", () => {
    for (const state of ["starting", "blocked", "probation"] as const) {
      const session = deriveProductSession({
        availability: "available",
        readiness: {
          document: readiness({ host: { ...READY_PRODUCT.host, state } }),
          stale: false,
          issue: null,
        },
        authRepair: false,
      });
      expect(session.access).toEqual({
        read: true,
        converse: true,
        voice: true,
        captureReplay: true,
        resolve: true,
      });
    }
  });

  test("turns non-current evidence into local-only sessions with one prioritized recovery", () => {
    const cases = [
      {
        input: { availability: "offline" as const, readiness: { document: READY_PRODUCT, stale: true, issue: null }, authRepair: false },
        expected: { kind: "offline", recovery: { title: "You're offline", actionLabel: "Try again" } },
      },
      {
        input: { availability: "unreachable" as const, readiness: { document: READY_PRODUCT, stale: true, issue: null }, authRepair: false },
        expected: { kind: "unreachable", recovery: { title: "Dome Home can't be reached", actionLabel: "Try again" } },
      },
      {
        input: { availability: "available" as const, readiness: { document: READY_PRODUCT, stale: true, issue: "readiness-failed" as const }, authRepair: false },
        expected: { kind: "stale", recovery: { title: "Connection needs a refresh", actionLabel: "Refresh connection" } },
      },
      {
        input: { availability: "available" as const, readiness: { document: null, stale: false, issue: "incompatible" as const }, authRepair: false },
        expected: { kind: "incompatible", recovery: { title: "Dome Home needs an update", actionLabel: "Check again" } },
      },
      {
        input: { availability: "available" as const, readiness: { document: READY_PRODUCT, stale: true, issue: null }, authRepair: true },
        expected: { kind: "auth-repair", recovery: { kind: "repair", title: "Pair this device again" } },
      },
    ];

    for (const { input, expected } of cases) {
      const session = deriveProductSession(input);
      expect(session).toMatchObject(expected);
      expect(session.access).toEqual({ read: false, converse: false, voice: false, captureReplay: false, resolve: false });
    }
  });
});
