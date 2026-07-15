import { describe, expect, test } from "bun:test";
import type { ProductReadiness } from "../../contracts/product-readiness";
import { deriveProductAccess } from "../src/connection/product-access";
import { READY_PRODUCT } from "./readiness-fixture";

function readiness(patch: Partial<ProductReadiness>): ProductReadiness {
  return { ...READY_PRODUCT, ...patch };
}

describe("deriveProductAccess", () => {
  test("derives each remote affordance from capability and dependency truth", () => {
    expect(deriveProductAccess(READY_PRODUCT)).toEqual({
      read: true,
      converse: true,
      voice: true,
      captureReplay: true,
      resolve: true,
    });
    expect(deriveProductAccess(readiness({
      writesAdmitted: false,
      device: { ...READY_PRODUCT.device, capabilities: ["read", "capture"] },
      model: { state: "unreachable" },
      transcription: { state: "unconfigured" },
    }))).toEqual({
      read: true,
      converse: false,
      voice: false,
      captureReplay: false,
      resolve: false,
    });
  });

  test("host presentation state does not override the route-level access contract", () => {
    for (const state of ["starting", "blocked", "probation"] as const) {
      expect(deriveProductAccess(readiness({ host: { ...READY_PRODUCT.host, state } }))).toEqual({
        read: true,
        converse: true,
        voice: true,
        captureReplay: true,
        resolve: true,
      });
    }
  });

  test("optional providers degrade only their dependent affordances", () => {
    const access = deriveProductAccess(readiness({
      model: { state: "unconfigured" },
      transcription: { state: "unreachable" },
    }));
    expect(access).toEqual({
      read: true,
      converse: false,
      voice: false,
      captureReplay: true,
      resolve: true,
    });
  });
});
