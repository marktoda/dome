// EngineVault — the minimal structural shape the v1 engine layer reads
// from a vault handle. Phases 1-6 imported the full v0.5 `Vault` type
// from `../vault`; Phase 7b retires `src/vault.ts` and decouples the
// engine by naming exactly what it needs.
//
// Two fields:
//   - `path`: the on-disk vault directory.
//   - `config.git.auto_commit_workflows`: the flag closure-commit reads
//     to decide whether to emit a closure commit at all.
//
// The v1 engine never reads other Vault fields — `tools`, `bundles`,
// `dispatchEvents`, etc. were v0.5 surfaces that retired with src/vault.ts.
//
// Pinned by [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]] §"engine reads
// vault by shape, not by class".

export type EngineVault = {
  readonly path: string;
  readonly config: {
    readonly git: {
      readonly auto_commit_workflows: boolean;
    };
  };
};
