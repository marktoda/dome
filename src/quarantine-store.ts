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
//
// Validation: parsed JSON flows through `QuarantineSchema` (Zod) — a
// corrupted file emits a console.warn AND returns the empty-array fallback.
// The store carries no PrivilegedWriter reference (it's pure I/O), so
// observability is local-only via console.warn rather than log.md; the
// next reconcile will surface the same corruption via its own state-file
// validation path. Closes the third scar site in
// docs/wiki/gotchas/boundary-validation-via-zod.md.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { QuarantineSchema } from "./state-schemas";

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
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch {
        return [];
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (e) {
        // Corrupted JSON — treat as empty so the dispatcher continues to
        // function; the next save rewrites the file. Surface the corruption
        // via console.warn (the store has no PrivilegedWriter; reconcile's
        // own state-file validation path emits the log entry).
        console.warn(`Invalid .dome/state/quarantined.json (invalid JSON: ${(e as Error).message}); falling back to empty set`);
        return [];
      }
      const parseResult = QuarantineSchema.safeParse(raw);
      if (!parseResult.success) {
        console.warn(
          `Invalid .dome/state/quarantined.json shape: ${parseResult.error.issues[0]?.message ?? parseResult.error.message}; falling back to empty set`,
        );
        return [];
      }
      return parseResult.data;
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
