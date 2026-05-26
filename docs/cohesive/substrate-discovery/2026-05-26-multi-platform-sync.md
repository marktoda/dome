# Substrate Discovery — multi-platform sync transport

## Substrate discovered

### Target change surface
- Subsystem: vault transport / multi-platform write access (v1+ scope per VISION.md)
- Main files likely involved (future): a `sync/` module under `src/`, mobile/web client, possibly a hosted server. Today: no transport beyond local FS.
- Neighboring subsystems: `openVault` (`src/vault.ts`), reconciliation (`src/reconcile.ts`), watcher, MCP server, CLI.

### Relevant specs/docs
- `docs/VISION.md` §"v1+ Product" — names "Optional cloud sync over the markdown vault" and "native mobile app: voice-first capture, structured browse, prep mode, inbox review."
- `docs/wiki/specs/vault-layout.md` §"Git repository structure" — every vault is a git repo; `.dome/state/` is gitignored per-machine; everything else is committed.
- `docs/wiki/specs/sdk-surface.md` — Vault/Document/Tool/Hook is the durable surface; harnesses (incl. MCP servers) are interchangeable above it.
- `docs/wiki/specs/mcp-surface.md` — current write surface for agents.
- `docs/wiki/specs/harnesses.md` — interface-agnostic surface model.

### Behavior matrices
- Existing: `consumer-surface.md` (per-surface tool exposure), `event-types-and-payloads.md`, `intent-prompt-tools.md`. None covers per-device-class transport.
- Missing but likely needed: device-class × surface-capability matrix (mobile vs desktop vs web — read/write/voice/intake/admin). Sync-event matrix (push origin × conflict-class × resolution path).

### Named invariants
- **Existing axioms that constrain sync:**
  - `VAULT_IS_GIT_REPO` (axiom; explicitly names `git push`/`git pull` as v1+ sync model)
  - `MARKDOWN_IS_SOURCE_OF_TRUTH` (axiom; "sync mechanisms (v1+) can be markdown-native without coupling to Dome's runtime")
  - `EVERY_WRITE_IS_LOGGED` (every mutation produces an `appendLog` entry — cross-device writes must too)
  - `INDEX_AND_LOG_ARE_DISPATCHER_OWNED` (mobile clients can't write to `index.md` / `log.md` directly — must go through tools)
- **Candidate invariants surfaced by this change:**
  - `WRITES_TO_VAULT_GO_THROUGH_TOOLS` — even from mobile/API, no direct file POST that bypasses the tool surface (else invariant enforcement collapses)
  - `SYNC_BOUNDARY_IS_GIT` — the canonical transport boundary between devices is git refs, not custom replication
  - `DEVICE_HAS_LOCAL_OR_NONE` — a device either holds a full clone (with its own `.git/`) or holds none (talks to a remote SDK); no half-clone modes

### Existing enforcement
- Tests: `tests/invariants/vault-is-git-repo.test.ts`, `tests/invariants/markdown-is-source-of-truth.test.ts`, `tests/invariants/every-write-is-logged.test.ts`, `tests/integration/end-to-end.test.ts`.
- Types: `openVault` refuses non-git directories at the type/runtime boundary.
- Constraints: `.gitignore` distinguishes committed identity (`.dome/config.yaml`, hooks, prompts) from per-machine state (`.dome/state/`).
- CI checks: none currently (no `.github/workflows/` files surfaced).
- Semantic linters: `dome doctor` reports invariant violations after out-of-band edits.

### Known gotchas / scars (load-bearing for sync)
- `concurrent-harness-write.md` — optimistic locking via `expected_mtime`; doc explicitly states "concurrent writes across devices (laptop and phone) are structurally identical to concurrent writes across harness sessions."
- `out-of-band-vault-edits.md` — sync layers (Syncthing, git, iCloud Drive) generate out-of-band edits; watcher emits `vault.out-of-band-edit` events. v1+ may register sync as a "trusted mutator."
- `dirty-git-state-at-reconcile.md` — reconcile refuses mid-merge / mid-rebase. Sync conflict resolution will land in this state more often.
- `async-read-after-write-staleness.md`, `multi-page-partial-write.md` — related concurrency scars.

### Locality boundaries
- `Vault` instance is the locality boundary — one per process, one per vault path. Sync is naturally a new module that orchestrates `Vault` operations and git ops; it should NOT live inside core.
- `CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY` invariant implies a parallel `CORE_HAS_NO_SYNC_DEPENDENCY` — sync goes in shell, not core.
- Suspected seam: a hosted-API server reuses the SDK on the server side; this is a new harness (per `harnesses.md`), not a new core dependency.

### Missing memory
- **No transport spec** — `docs/wiki/specs/` has no `sync.md` / `transport.md`. The closest is `VAULT_IS_GIT_REPO` §"Multi-device sync (v1+)" — one paragraph, no operational detail. The substrate that would close this: a `wiki/specs/transport.md` covering local-clone-per-device, remote-conduit, mobile capabilities.
- **No device-class matrix** — no `wiki/matrices/device-class-capabilities.md` saying which surfaces support which tools. The mobile-vs-desktop tool exposure is implicit.
- **No mobile-write gotcha** — concurrent-harness-write notes "v1+ multi-device sync (rare in v0.5; common in v1+)" but no gotcha for the mobile-offline-capture case (write while offline, sync later, conflict during merge).
- **`SYNC_BOUNDARY_IS_GIT` is not named yet** — currently implicit from `VAULT_IS_GIT_REPO`'s §"Multi-device sync" paragraph. A sync-aware caller (e.g., a future "iCloud Drive sync" plugin) could plausibly violate this without an explicit invariant.
- **No identity / auth spec** — when the user logs in on mobile, what identifies "their vault"? GitHub OAuth, server account, both? No doc.

### Next
- This discovery feeds the brainstorm currently underway. *(`cohesive:brainstorm-design`.)* **Design question:** local-git-clone-per-device vs hosted-API conduit vs hybrid — under the `VAULT_IS_GIT_REPO` axiom.
