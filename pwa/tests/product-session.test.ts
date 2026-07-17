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
      operational: { host: "ready", adoption: "current", current: true },
      composer: { placeholder: "ask or capture…", hint: null },
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
      operational: { host: "ready", adoption: "current", current: true },
    });
    expect(session.recovery?.detail).toContain("dome home setup configure");
    expect(session.composer.hint).toBeNull();
  });

  test("preserves route-level access while every non-ready host state stays non-green", () => {
    const cases = [
      ["starting", "checking"],
      ["degraded", "limited"],
      ["blocked", "needs attention"],
      ["probation", "checking"],
    ] as const;
    for (const [state, label] of cases) {
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
      expect(session).toMatchObject({
        kind: "operational",
        connection: { label },
        operational: { host: state, adoption: "current", current: false },
      });
      expect(session.connection.tone).not.toBe("healthy");
      expect(session.recovery).not.toBeNull();
    }
  });

  test("preserves route-level access while every non-current adoption state stays non-green", () => {
    const cases = [
      ["pending", "syncing"],
      ["blocked", "needs attention"],
      ["diverged", "needs attention"],
      ["unknown", "needs attention"],
    ] as const;
    for (const [state, label] of cases) {
      const session = deriveProductSession({
        availability: "available",
        readiness: {
          document: readiness({ adoption: { ...READY_PRODUCT.adoption, state } }),
          stale: false,
          issue: null,
        },
        authRepair: false,
      });
      expect(session).toMatchObject({
        kind: "operational",
        access: { read: true, converse: true, captureReplay: true, resolve: true },
        connection: { label },
        operational: { host: "ready", adoption: state, current: false },
      });
      expect(session.connection.tone).not.toBe("healthy");
      expect(session.recovery).not.toBeNull();
    }
  });

  test("explains device capability denial without reinterpreting it as model setup", () => {
    const session = deriveProductSession({
      availability: "available",
      readiness: {
        document: readiness({
          device: { ...READY_PRODUCT.device, capabilities: ["read"] },
        }),
        stale: false,
        issue: null,
      },
      authRepair: false,
    });
    expect(session.kind).toBe("current");
    expect(session.composer).toEqual({
      placeholder: "ask or capture…",
      hint: "Ask is not enabled for this device. Voice is not enabled for this device. Text capture still works.",
    });
    expect(session.composer.hint).not.toContain("setup");
  });

  test("explains authorization loss at the product seam", () => {
    const session = deriveProductSession({
      availability: "available",
      readiness: { document: READY_PRODUCT, stale: true, issue: null },
      authRepair: true,
    });
    expect(session.composer.hint).toBeNull();
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
