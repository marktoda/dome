import type { ProductReadiness } from "../../contracts/product-readiness";

export const READY_PRODUCT: ProductReadiness = Object.freeze({
  schema: "dome.product.readiness/v1",
  productVersion: "1.0.0-test",
  artifactId: "artifact-test",
  writesAdmitted: true,
  contractVersions: Object.freeze(["dome.product.readiness/v1", "dome.daily.today/v1"]),
  assetVersion: "asset-test",
  vault: Object.freeze({ id: "vault-test", name: "Work" }),
  device: Object.freeze({
    id: "device-test",
    name: "Test device",
    capabilities: Object.freeze(["read", "capture", "resolve", "converse"]),
  }),
  host: Object.freeze({ state: "ready", since: "2026-07-15T12:00:00.000Z" }),
  adoption: Object.freeze({
    state: "current",
    head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    adopted: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    lastSuccessAt: "2026-07-15T12:00:00.000Z",
  }),
  model: Object.freeze({ state: "ready" }),
  transcription: Object.freeze({ state: "ready" }),
  nextActions: Object.freeze([]),
});

export function readinessResponse(document: ProductReadiness = READY_PRODUCT): Response {
  return new Response(JSON.stringify(document), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
