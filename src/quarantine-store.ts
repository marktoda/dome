// Persistent quarantine record at .dome/state/quarantined.json.
//
// Mirrors the .dome/state/scheduled.json shape (gitignored, derived,
// rebuildable). The store exists because dome doctor and dome serve don't
// share a process; an in-memory quarantine doesn't survive the CLI handoff.
// See docs/wiki/specs/hooks.md §"Execution model" Failure model and
// docs/wiki/specs/vault-layout.md §"Derived operational state under .dome/".
//
// The on-disk shape is a JSON array of handler ids. A missing file is
// treated as "no handlers quarantined." Writes are best-effort: errors are
// swallowed rather than thrown, because a quarantine write failure should
// never abort a Tool call.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface QuarantineStore {
  /** Load the persisted quarantine ids. Returns [] when the file is absent. */
  load(): Promise<string[]>;
  /** Write the current quarantine set to disk; resolves when fsync completes. */
  save(ids: ReadonlyArray<string>): Promise<void>;
  /** Wipe the file (write `[]`) — used by `dome doctor --reset-quarantined-hooks`. */
  clear(): Promise<void>;
}

export function makeQuarantineStore(path: string): QuarantineStore {
  return {
    async load(): Promise<string[]> {
      if (!existsSync(path)) return [];
      try {
        const text = await readFile(path, "utf8");
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed.filter(x => typeof x === "string") : [];
      } catch {
        // Corrupted file — treat as empty; the next save rewrites it.
        return [];
      }
    },
    async save(ids: ReadonlyArray<string>): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify([...ids].sort(), null, 2));
    },
    async clear(): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "[]");
    },
  };
}
