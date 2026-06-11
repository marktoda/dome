// sqlite/hash: schema-fingerprint helpers shared by the four stores. The DDL
// hash decides rebuild/refuse behavior on open — see each store's db.ts.
import { createHash } from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function computeDdlHash(ddl: ReadonlyArray<string>): string {
  return sha256Hex(ddl.join("\n"));
}
