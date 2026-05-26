# Brainstorm — multi-platform sync transport (v1+)

### Current scope
- Multi-platform DOME: mobile + web + desktop, with mobile-write being the load-bearing new capability.
- Offline reading on mobile (required, per user constraint).
- Offline ingestion queuing on mobile (nice-to-have, satisfied by same mechanism).
- Importing existing vaults (Obsidian git repos, arbitrary markdown dirs + `git init`).
- Fresh-start vault creation that's symmetric across platforms.
- "Clean sync" — no git conflict markers leaking to the phone user.

### Future pressure (not current scope)
- Voice client (AirPods-style write-heavy capture).
- Hosted-managed offering of the same conduit binary.
- Apple Notes / Google Docs import flows.
- Multi-user / shared-vault model.
- Phone-as-full-peer with local SDK + push capability (v2 promotion path).
- Real-time CRDT collaborative editing — explicitly NOT planned; D is optimistic-locked. If this earns its way in, it's a v3 architecture shift, not an extension of D.
- Conduit mirroring to upstream remotes (GitHub, Gitea, etc.) as backup / portability.

### Non-goals
- Replacing git as the underlying transport (`VAULT_IS_GIT_REPO` is axiom).
- Holding canonical state outside markdown (`MARKDOWN_IS_SOURCE_OF_TRUTH` is axiom).
- A SaaS the user's memory is trapped inside (VISION non-goal).
- Replacing Obsidian on desktop (VISION positions Obsidian as the browser).
- Adding GitHub OAuth on the phone in v1 (conduit is the only remote v1 needs).

## Design options

### Option A: BYO git remote (zero infrastructure shipped)
**Summary:** DOME ships no conduit. Vault syncs over whatever git remote the user picks (GitHub, Gitea, private SSH). Mobile uses isomorphic-git over HTTPS to the same remote.
**Substrate changes required:** Minimal — extend `VAULT_IS_GIT_REPO §"Multi-device sync"` paragraph with conventions for mobile (isomorphic-git on iOS), document Obsidian-Git compatibility patterns.
**Locality impact:** None — DOME stays a CLI/SDK/MCP-server shape.
**Future fit:** Voice and write-heavy mobile capture have high latency (GitHub roundtrip). Mobile UX is the weak link.
**Initial risks:** Mobile capture latency; onboarding casual users who don't know git.

### Option B': Read cache + intent-journal (thin client with bespoke mirror)
**Summary:** Phone holds an LRU markdown cache + an intent-journal of pending writes. Reads from cache when offline; writes via conduit API. Bespoke cache invalidation protocol between conduit and phone.
**Substrate changes required:** Read-cache protocol spec, cache-invalidation invariant, search-index-over-cache spec, shadow-reads-over-journal spec.
**Locality impact:** New mobile-side state types (cache + journal + live data when online).
**Future fit:** Voice capture works via journal. History/blame/diff on mobile do NOT work (cache is current-state-only). Wikilink navigation breaks for non-cached pages.
**Initial risks:** Cache-invalidation bugs; mental model gets uglier than D's; once cache approaches full vault size, B' is just D with extra steps.

### Option C: Full git peer (SDK + git on phone)
**Summary:** Phone holds a full clone, runs the SDK, pushes directly to remotes. Phone is a true peer.
**Substrate changes required:** Mobile SDK port (Bun does not run on iOS — requires JavaScriptCore via React Native shim, OR a native Swift/Kotlin port, OR restricting mobile to a subset that bypasses tools and violates `HOOKS_CANNOT_BYPASS_TOOLS`), mobile-friendly git-merge UX spec (git conflict markers in markdown on a phone screen is hostile UX), phone-side hook execution spec, push auth spec.
**Locality impact:** Phone becomes a Dome node; full SDK + reconcile + hooks on mobile.
**Future fit:** Maximally honors "interfaces interchangeable, vault is forever." But the Bun-on-iOS blocker is real and structural.
**Initial risks:** Multi-engineer-year cost; two write paths (API + direct-git) with lockstep risk; phone-side hook dispatch is a new failure-mode surface.

### Option D: Read-replica with conduit-mediated writes
**Summary:** Phone holds a *fetch-only* git clone (full vault, full history, full search — locally and offline). Writes go via conduit API using the existing `expected_mtime` optimistic-locking primitive. Intent-journal for offline writes; replays on reconnection. Conduit is canonical git remote.
**Substrate changes required:** `transport.md` spec, `conduit.md` spec, `identity.md` spec, journal-replay invariants and matrices, multi-tenant isolation invariant.
**Locality impact:** Conduit is a new harness (lives in `src/conduit/`, outside SDK and core). Phone is a smart-display + write-relay (no SDK on phone).
**Future fit:** Voice rides the same intent-journal primitive. Phone-as-full-peer (C) is an additive future upgrade — the storage shape is already a clone. Hosted-managed offering is the same binary deployed by DOME-the-company. Multi-tenancy is baked into the architecture from day one even if single-tenant in initial deployment.
**Initial risks:** Conduit becomes SPOF for write availability (mitigated by durable journal + defer-not-die failure mode + re-seedable conduit disk).

### Option (rejected): Hosted SaaS as primary
Structurally blocked by VISION principle #1 ("by refusing to own the data, we earn the right to be the layer that touches it") and the "no SaaS your memory is trapped inside" non-goal. Hosted-managed deployment of the conduit binary remains available as a future offering.

## Pressure test summary

| Option | Cohesion w/ substrate | Substrate delta | Future fit | Locality | Main risk |
|---|---|---|---|---|---|
| A | High | Small | Mobile UX weak; voice impractical | Clean; no new code | Mobile capture latency multi-hop through GitHub |
| B' | Medium | Medium | History/blame/search bespoke | New cache protocol on mobile | Cache invalidation bugs; B' grows into D |
| C | High in principle | Very large | Best long-term; Bun-on-iOS blocker | Phone becomes Dome node | Engineering cost; phone-side hook surface; mobile merge UX |
| D | High | Medium | Voice + web + hosted-managed all ride same primitive | Conduit is new harness; SDK stays where it lives today | Conduit SPOF for write availability |

## Decision dialog

### Axes walked
- **Axis 1 (Service shape):** agent picked Optional self-hostable conduit; user ratified. Substrate evidence: `VAULT_IS_GIT_REPO §"Multi-device sync (v1+)"`, `VISION.md §"v1+ Product"` ("optional cloud sync"), VISION principle #1 ruling out SaaS-as-primary.
- **Axis 2 (Mobile transport):** agent initially picked B (lightweight intent-journal, no read cache); user pushed back — offline reading required, asked for full B-vs-C tradeoff analysis. Agent surfaced D (read-replica + conduit-mediated writes) as hybrid that captures most of C's wins without C's Bun-on-iOS blocker; user ratified D. Substrate evidence: `concurrent-harness-write.md §"v1+ sync notes"`, `out-of-band-vault-edits.md §"Plugin / sync-layer notes"`, the `HOOKS_CANNOT_BYPASS_TOOLS` invariant.

### Sub-decisions
| # | Sub-decision | Tag | Outcome | Notes |
|---|---|---|---|---|
| 1 | Conduit's relationship to upstream remote | Pick | Conduit IS canonical remote in v1 | User: "kinda out of scope / easy to change in the future." Upstream-mirror is a future roadmap item. |
| 2 | Multi-vault per conduit instance | Pick | Multi-tenant in architecture from day one | User: "conduit should be able to host many vaults / be multitenant even eventually." Single-tenant deployment in initial rollout; architecture assumes multiple. |
| 3 | Auth model | Confirm | Per-device tokens issued through user-account OAuth | Agent recommendation; user ratified by non-pushback. |
| 4 | Journal lifecycle | Confirm | Clear-on-successful-replay; surface pending count in mobile UI | Journal is derived state per `MARKDOWN_IS_SOURCE_OF_TRUTH`. |
| 5 | Conduit runs reconcile + hooks on write | Confirm | Yes | Hooks live with SDK; conduit is the SDK-bearing process. |
| 6 | Conduit deployment target | Default | Docker image first; fly.io / Railway templates downstream | |
| 7 | Mobile fetch trigger | Default | App-foreground initially; push-notification + background-app-refresh in v1.1 | |
| 8 | Binary name | Default | `dome-cloud` (open to `dome-relay`) | |

### Cross-branch graft check (Phase 4 opening)
- **Hybrid candidate surfaced?** Yes — agent surfaced D (read-replica with conduit-mediated writes) as a hybrid between B's thin-client and C's full-peer. User accepted D as the leaf.
- **Cleared?** Yes — proceeded to remaining battery. The non-chosen branches (A: BYO git, C: full peer) reappear as future roadmap items, not as graftable structure for v1.

## Breakage analysis

### Option D (the recommended direction)
- **Docs that would change:** `wiki/specs/harnesses.md`, `wiki/specs/vault-layout.md`, `wiki/specs/sdk-surface.md`, `wiki/invariants/VAULT_IS_GIT_REPO.md` (multi-device-sync paragraph).
- **New docs:** `wiki/specs/transport.md`, `wiki/specs/conduit.md`, `wiki/specs/identity.md`.
- **Existing assumptions that break:** `harnesses.md`'s single-process-per-vault model needs extension to "the conduit's vault is one running SDK process; remote MCP/HTTP harnesses connect to it." Single-tenant SDK assumptions in `openVault` become multi-tenant-prefixed.
- **Behavior matrix impact:** New `device-class-capabilities.md` matrix (mobile/web/desktop × read/write/voice/intake/admin); new `journal-replay-outcomes.md` matrix (clean / conflict / unauthorized / retry-needed).
- **Invariant impact:** Add `WRITES_FROM_REMOTE_HARNESSES_GO_THROUGH_TOOLS`, `INTENT_JOURNAL_IS_DERIVED_STATE`, `MULTI_TENANT_VAULT_ISOLATION`, `CORE_HAS_NO_TRANSPORT_DEPENDENCY`. The four existing axioms (`VAULT_IS_GIT_REPO`, `MARKDOWN_IS_SOURCE_OF_TRUTH`, `HOOKS_CANNOT_BYPASS_TOOLS`, `EVERY_WRITE_IS_LOGGED`) hold without weakening.
- **Test guarantee impact:** New tests — journal-replay (clean + conflict + storm); remote Tool dispatch parity (parametric test asserting every Tool callable in-process is equivalently callable over remote API, with identical Effect outputs); multi-tenant isolation (vault A's token cannot read vault B); fetch-only mobile assertion (phone test harness never invokes `git push`).
- **Gotchas triggered:** `journal-replay-storm.md` (50 buffered writes hitting on reconnect after long offline); `conduit-loss-recovery.md` (re-seeding from a peer clone via `dome-cloud restore-from-clone`); `tenant-isolation-bypass.md` (path-traversal via API → cross-tenant read; mitigation = per-tenant chroot at `openVault`); `mobile-fetch-failure.md` (partial fetch; treat as offline); `voice-capture-while-conduit-unreachable.md` (graceful journal-and-defer); `expected-mtime-snapshot-staleness.md` (phone's mtime snapshot is from a fetch 12 hours ago; replay sees `concurrent-write-conflict`; agent presents merge UI).
- **Locality / centralization concerns:** Conduit code lives in `src/conduit/` — separate from `src/sdk/` and `src/core/`. HTTP/MCP-remote shimming MUST NOT live in the SDK package — analogous to how `CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY` keeps LLM out of core. The new invariant `CORE_HAS_NO_TRANSPORT_DEPENDENCY` makes this explicit.
- **Easy invalid change still possible:**
  - Adding a new Tool to the SDK without registering it in the conduit's API surface → Tool is callable locally but silently unavailable to mobile. Mitigation: semantic linter requires every public Tool to declare `conduit_callable: true | false` explicitly (no implicit default).
  - Registering a Tool in the conduit's API surface without declaring an auth scope → Tool is callable by any authenticated device regardless of intended boundary. Mitigation: every conduit-callable Tool MUST declare `auth_scope` (semantic linter enforces).
  - A hook spawned from a remote Tool call leaking the calling device's identity into vault content → mitigation: hook context carries `originated_from` field; sensitive hooks (LLM calls, external API calls) check originating device authorization.

## Recommendation

**Direction:** Conduit-mediated read-replica DOME — open-source self-hostable conduit binary as canonical git remote in v1; mobile holds a fetch-only clone + intent-journal for writes; desktop runs the SDK locally as today; multi-tenant in architecture from day one even if single-tenant in initial deployment.

**Main risk:** The conduit becomes a single point of failure for *write availability*. Not data loss — but multi-hour write-staleness if the operator doesn't notice the conduit is down.

**Structural mitigation:**
1. **Durable journal on the device** — pending writes survive conduit outage indefinitely; auto-replay on restore. Journal is local-disk, fsync'd append.
2. **Fetch-only mobile clone** — even with conduit down, mobile retains full read access (history, search, wikilink navigation) from its local mirror.
3. **Defer-not-die failure mode** — only `concurrent-write-conflict` is a Tool-level error during journal replay; network/auth/conduit-restart errors are "retry queued," never "write lost."
4. **`MARKDOWN_IS_SOURCE_OF_TRUTH` makes the conduit re-seedable** — any peer's clone can rebuild the conduit's disk. A `dome-cloud restore-from-clone <path>` CLI makes recovery a documented one-liner.

**Required substrate before implementation:**
- Specs:
  - `wiki/specs/transport.md` — conduit API shape, intent-journal protocol, mobile fetch model, replay semantics
  - `wiki/specs/conduit.md` — conduit lifecycle, multi-tenant addressing, deployment shapes, process pool model, restore-from-clone operation
  - `wiki/specs/identity.md` — per-device tokens, OAuth flow, multi-tenant vault addressing, auth scope per Tool
  - Updates to `harnesses.md`, `vault-layout.md`, `sdk-surface.md`, `VAULT_IS_GIT_REPO.md` per breakage analysis above
- Matrices:
  - `wiki/matrices/device-class-capabilities.md` — mobile/web/desktop × read/write/voice/intake/admin
  - `wiki/matrices/journal-replay-outcomes.md` — replay-attempt outcome states + their handling
- Named invariants:
  - `WRITES_FROM_REMOTE_HARNESSES_GO_THROUGH_TOOLS` — remote API calls dispatch through the same Tool layer; no raw-file POST endpoint
  - `INTENT_JOURNAL_IS_DERIVED_STATE` — journal is discardable; only successfully-replayed writes are canonical
  - `MULTI_TENANT_VAULT_ISOLATION` — vaults under one conduit are isolated at every operation; per-tenant chroot at the `openVault` layer
  - `CORE_HAS_NO_TRANSPORT_DEPENDENCY` — sibling to `CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY`; transport shimming lives in conduit harness, not core or SDK
- Tests / checks:
  - Journal replay tests (clean / conflict / storm / partial)
  - Remote Tool dispatch parity (parametric over Tool catalog)
  - Multi-tenant isolation tests (cross-tenant read denied, cross-tenant write denied, path-traversal denied)
  - Fetch-only mobile assertion (no `git push` from mobile clone)
- Gotchas:
  - `journal-replay-storm.md`
  - `conduit-loss-recovery.md`
  - `tenant-isolation-bypass.md`
  - `mobile-fetch-failure.md`
  - `voice-capture-while-conduit-unreachable.md`
  - `expected-mtime-snapshot-staleness.md`
- Semantic linters:
  - Every public Tool declares `conduit_callable: true | false` (explicit, not defaulted)
  - Every conduit-callable Tool declares `auth_scope`
  - Hook context carries `originated_from`; sensitive hooks check originating device authorization

## Operational flow validation (post-recommendation refinement)

The architecture was pressure-tested against substrate; this section pressure-tests it against user-facing onboarding flows.

### Flow 1 — Fresh vault, laptop-first
1. `dome init ~/vaults/new` (local v0.5 flow; unchanged).
2. `dome-cloud connect --remote <conduit-url>` — auths against conduit, conduit provisions vault namespace under user's tenant, sets `origin` remote, initial push.
3. Mobile pairs against conduit; sees vault in user's vault list; clones.

Works cleanly.

### Flow 2 — Fresh vault, mobile-first (friction point)
The architecture as designed REQUIRES a conduit to exist before mobile can be onboarded. For a mobile-first casual user (the audience VISION names — student building thesis, writer maintaining character notes, retiree organizing family history), being told "spin up a fly.io instance before you start" is hostile. This pressures the self-host-first framing toward shipping a hosted-managed conduit deployment in v1, not v1.1+.

**Open question (deferred):** does DOME-the-company run a hosted-managed conduit deployment in v1 concurrent with the self-host binary? Architecturally the binary is the same; operationally it adds billing/account/monitoring/backup-as-a-service. If mobile-first onboarding is a v1 goal, hosted-managed is effectively coincident with mobile, not a v1.1 followup. Resolved at v1+ planning kickoff.

### Flow 3 — Import existing Obsidian vault (already git-repo + GitHub-synced)
1. Laptop: `dome migrate ~/vaults/personal` runs `dome doctor`, lays in `.dome/`, commits migration.
2. `dome-cloud connect --remote <conduit-url>` pushes existing repo to conduit; conduit provisions namespace from incoming repo.
3. Mobile pairs, clones.

**Subtle issue:** existing GitHub remote becomes secondary. Conduit-is-canonical in v1 means GitHub either (a) drops, (b) requires manual dual-push by the laptop, or (c) waits for the "conduit mirrors upstream" roadmap item from Pick #1. Users who *want* to keep GitHub canonical are friction. A v1.1 "conduit pushes upstream" feature is a 50-line `git push` in the conduit's reconcile loop — worth promoting from "future roadmap" to "v1.1 followup" when v1+ planning kicks off.

### Flow 4 — Switch conduits (portability proof)
1. From laptop (still has full clone): `dome-cloud restore-from-clone ~/vaults/personal --to <new-conduit-url>` — pushes laptop clone to new conduit; auto-provisions namespace.
2. Re-pair each device against new conduit (per-device OAuth handshake).
3. App on each device handles `git remote set-url`; pending journal entries replay against new conduit using existing `expected_mtime` semantics.

Works because conduit is just (git remote + SDK process). Replacing it is the same shape as switching IMAP providers. VISION principle #3 ("vault is forever, interfaces interchangeable") holds end-to-end.

**Friction:** re-pairing N devices is N OAuth handshakes. For 2-3 devices fine; for 5+ tedious. A separate "DOME identity service" issuing tokens *to* any conduit would smooth this — but that IS DOME running an identity SaaS, which has VISION-principle tension. Defer.

### Design questions resolved post-flow-walk
1. **Hosted-managed conduit deployment in v1?** — *Resolved: defer to v1.x coincident with mobile launch.* v1.0 ships self-host binary only; ~6 months of in-the-wild battle-testing; DOME-the-company runs hosted-managed in v1.1 or v1.2 alongside mobile GA. Mobile in v1.0 is advanced-users-only (those who already run a conduit). Tradeoff accepted: ~6 months of "mobile needs a conduit first" friction for early adopters in exchange for substrate settling before DOME inherits operational responsibility.
2. **Conduit-pushes-upstream-remote feature in v1.1?** — *Resolved: promote from "future roadmap" to "v1.1 followup."* Small implementation cost (~50-100 lines + config + integration test); audience benefit (Obsidian-Git users keeping GitHub canonical) is real. Failure mode (conduit/upstream divergence) is bounded and observable via `dome-cloud doctor`. v1.0 scope is unchanged — only the planning posture is upgraded.
3. **DOME identity service separate from conduit identity?** — *Resolved: defer to v2 or later.* Multi-conduit + 5+ devices is a niche case in v1; building an identity SaaS has VISION-principle tension. Revisit when a concrete user pulls on it.

### Next

Persist this brainstorm as v1+ future-direction reference. *(`cohesive:rewrite-specs` is deferred until v1+ planning is actively underway.)* **When v1+ work begins:** invoke `cohesive:rewrite-specs` with this brainstorm as input, slug `multi-platform-sync`. The brainstorm's "Required substrate before implementation" list is the rewrite-specs payload. The three "open questions from flow-walk" above are the design-question inputs for any pre-rewrite brainstorm round.
