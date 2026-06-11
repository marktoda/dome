// core/short-hash: sha256-prefix hashing for idempotency keys and content
// fingerprints. NOT for durable vault identity — anchors/stable ids have
// their own pinned helpers (contentAnchorId, openLoopStableId).
import { createHash } from "node:crypto";

/** First `hexChars` hex chars of sha256(value). Pass 64 for the full digest. */
export function shortHash(value: string, hexChars: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, hexChars);
}
