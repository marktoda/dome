// `--show events`: list known event-kind prefixes (read-only catalogue).
//
// Centralized here to avoid divergence with the grammar declared in
// docs/wiki/specs/hooks.md §"Event grammar". When the grammar changes,
// update both files in lockstep.

import type { Vault } from "../../../vault";

// Known event-kind prefixes per docs/wiki/specs/hooks.md §"Event grammar".
const KNOWN_EVENT_KIND_PREFIXES: ReadonlyArray<string> = [
  "document.written.wiki.*",
  "document.written.inbox.*",
  "document.written.raw",
  "document.written.index",
  "document.written.log",
  "document.deleted.wiki.*",
  "document.deleted.inbox.*",
  "document.deleted.raw",
  "document.deleted.index",
  "document.deleted.log",
  "document.moved",
  "log.appended",
  "vault.out-of-band-edit",
];

export async function showEvents(_vault: Vault): Promise<{ info: string[] }> {
  const info: string[] = [];
  for (const kind of KNOWN_EVENT_KIND_PREFIXES) info.push(`event: ${kind}`);
  return { info };
}
