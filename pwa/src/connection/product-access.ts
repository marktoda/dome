import type { ProductReadiness } from "../../../contracts/product-readiness";

export type ProductAccess = Readonly<{
  read: boolean;
  converse: boolean;
  voice: boolean;
  captureReplay: boolean;
  resolve: boolean;
}>;

export const NO_PRODUCT_ACCESS: ProductAccess = Object.freeze({
  read: false,
  converse: false,
  voice: false,
  captureReplay: false,
  resolve: false,
});

/** Derive every remote PWA affordance from one validated readiness document. */
export function deriveProductAccess(document: ProductReadiness): ProductAccess {
  const capabilities = new Set(document.device.capabilities);
  return Object.freeze({
    read: capabilities.has("read"),
    converse: capabilities.has("converse") && document.model.state === "ready",
    voice: capabilities.has("capture") && document.transcription.state === "ready",
    captureReplay: capabilities.has("capture") && document.writesAdmitted,
    resolve: capabilities.has("resolve") && document.writesAdmitted,
  });
}
