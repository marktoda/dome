// Canonical types for the Dome v1 SDK surface.
// See docs/wiki/specs/sdk-surface.md §"The four concepts".
//
// Phase 7b: trimmed to the surfaces v1 actually consumes.
//   - `Result<T, E>` + `ok` / `err`: the never-throws sum type the engine,
//     processors, projection, outbox, and ledger layers thread through their
//     I/O boundaries (the same shape `bun:sqlite` callers normalize into).
//   - `ToolError`: the open-ended error taxonomy the `Result`-returning
//     entry points surface. The v0.5 kinds that referenced retired surfaces
//     (`dispatcher-owned-path`, `wikilink-not-fullpath`, `frontmatter-mismatch`,
//     `page-creation-requires-reason`, `concurrent-write-conflict`,
//     `not-found`, `already-exists`, `vault-not-git-repo`, `config-invalid`,
//     `bundle-load-failure`, `invariant-violated`) are removed. The remaining
//     `validation` kind is emitted by `src/adopted-ref.ts` and is the only
//     `ToolError` discriminator any current v1 caller produces.

// ----- Result<T, E> ---------------------------------------------------------

export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

// ----- ToolError vocabulary -------------------------------------------------

export type ToolError = { kind: "validation"; message: string };
