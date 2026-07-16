---
type: plan
created: 2026-07-11
updated: 2026-07-16
status: reviewed
description: "Reviewed product vision and vertical execution path for a self-contained, PWA-first Dome personal knowledge appliance."
sources:
  - "[[VISION]]"
  - "[[cohesive/plans/2026-07-11-productization-modernization]]"
  - "[[cohesive/reviews/2026-07-09-first-principles-product-review]]"
  - "[[wiki/specs/http-surface]]"
  - "[[wiki/specs/sdk-surface]]"
  - "[[wiki/concepts/client-model]]"
---

# PWA-first product vision

## Status and relationship to prior work

This plan is the product-direction successor to the "continued
productization" section of
[[cohesive/plans/2026-07-11-productization-modernization]]. The completed P0–P7
engine, performance, distribution, and evaluation work in that document remains
the baseline. This plan now governs product-host and PWA work.

It was written after read-only reviews of the engine, HTTP/PWA, and
multi-consumer architecture, then revised after a fresh adversarial review.

## Decision

The first full Dome product is **Dome Home**:

> One owner, one portable Markdown/Git vault, one supervised Dome host, and
> many authenticated devices and clients.

The PWA is the first primary product client. CLI, MCP, Obsidian, and foreground
agent harnesses remain first-class local consumers of the same vault.

"Many consumers" initially means one person's phone, browsers, CLI, MCP
clients, and agent harnesses. It does not mean multiple people collaborating in
one working tree, multiple vaults in one runtime, or a multi-tenant service.
Those change authority, privacy, conflict, recovery, and operations and must be
designed separately if evidence demands them.

## First-principles judgment

Dome's sealed Vault, Proposal, Processor, and Effect model is not the blocker.
It already gives the product one mutation path, capability-checked behavior,
adopted-state recall, rebuildable knowledge projections, and durable audit and
recovery stores.

The missing product is around that engine:

- a new user separately assembles the compiler daemon, HTTP server, PWA build,
  bearer token, model provider, transcription, and private network;
- the installed artifact omits the PWA and the root release gates do not build
  it;
- HTTP opens a Vault per operation and serializes most work through one mutex;
- a streamed model turn can block Today, recents, capture, and another device;
- Dome-mediated writes are not uniformly commit-or-reconcile after failures;
- the browser trusts unchecked wire casts and stores one shared bearer in
  `localStorage`;
- loading, authentication, offline, stale, and unhealthy states collapse into
  a blank or falsely healthy screen;
- backup, restore, migration, pairing, revocation, and upgrade are not one
  supported lifecycle.

The next architecture work is therefore three deep Modules around the engine:

1. controlled host-mediated workspace mutation;
2. one long-lived single-vault product host;
3. shared validated and authenticated product contracts.

Do not add another engine primitive, normalized content database, document
compiler framework, workflow system, or intelligence layer for this work.

## Product promises

1. **The vault is the asset.** Markdown, Git, configuration, and durable
   operational state remain portable and owner-controlled.
2. **Conversation is the center, not the truth.** Ask/voice is the primary
   interaction; Today and Activity frame it. Durable knowledge and decisions
   land in the vault, so Dome remains a compiler product rather than a chat
   archive.
3. **Host-mediated writes are attributable and recoverable.** External editors
   and local agents still edit Git directly; Dome never overwrites their bytes
   during rollback or reconciliation.
4. **Committed is not adopted.** A receipt distinguishes locally queued,
   committed, adopted, blocked, diverged, and failed.
5. **Offline starts with text capture.** V1 queues text in available persistent
   browser storage and makes pending items visible and exportable. Browser
   storage can be evicted, so the product never promises impossible absolute
   durability.
6. **One logical capture, idempotent replay.** Networks may retry. Stable
   capture identity in the committed artifact makes duplicates reconcilable;
   no claim of transport exactly-once delivery.
7. **Authority is device-specific and revocable.** No shared master credential
   is stored in the browser.
8. **Models are optional accelerators.** Today, text capture, decisions,
   browsing, and lexical recall remain useful without conversation or
   transcription.
9. **Health is product truth.** Liveness, vault readiness, adoption freshness,
   and optional-provider readiness are distinct.
10. **No speculative distributed system.** No CRDT, peer clone, tenant-aware
    engine, or generic remote editor in the first product.

## Chosen V1 product

### Experience

The PWA keeps the existing companion shape but makes its modes explicit:

- **Ask** — the center: streaming grounded conversation, Stop/Retry, and
  sources that open adopted evidence.
- **Today frame** — brief, agenda, urgent work, and owner questions above or
  beside the conversation; collapses naturally once a turn starts.
- **Activity** — recent captures and changes with actor, time, and adopted
  document reader.
- **Capture** — a global text action; online voice transcribes, reviews, then
  enters the same text queue.
- **Connection** — paired host/vault identity, freshness, device grant,
  model/transcription availability, version, re-pair, and recovery.

Maintain stays ambient. The PWA shows actionable degradation, not processor
ids, ledgers, generic plugin views, or engine vocabulary.

Owner questions and task settlement may ship in the Today frame. Garden
proposal apply/reject remains in the CLI for V1; it returns only after the PWA
has a review detail with diff, base revision, provenance, and staleness state.

### Supported beta matrix

- **Host:** macOS under launchd, one vault per host process.
- **Product distribution:** signed/versioned macOS artifact containing the
  pinned Dome/Bun runtime, migrations, and built PWA. The existing npm package
  remains the SDK artifact and is not mistaken for the end-user installer.
- **Clients:** current iOS Safari installed PWA and current Chromium desktop;
  real iOS device testing is required. Playwright WebKit is useful coverage but
  is not evidence that iOS Safari works.
- **Same-machine access:** loopback.
- **Remote access:** Tailscale Serve privately proxies the loopback host over
  HTTPS. Tailscale is a supported external prerequisite, not bundled Dome
  infrastructure and not an engine dependency.
- **Uninstall:** removes host integration and product binaries only; never the
  vault, durable state, or backups.

HTTPS is required remotely because browser microphone access requires a secure
context. Connection readiness must explain Tailscale-down, certificate, and
configured-origin failures. Public-internet exposure is unsupported.

## Architecture and trust paths

Remote product clients and local compiler clients intentionally enter through
different paths:

```text
PWA / remote scripts
  -> device identity + scoped authorization
  -> versioned product contracts
  -> Product Host admission and operation scheduling
  -> existing Vault + surface operations

Local CLI / local MCP / foreground agent harness
  -> public Vault + compiler boundary
  -> shared controlled-mutation Module when using Dome commands
  -> direct Git edits remain ordinary external proposals

Both paths
  -> sealed engine: Proposal -> Processor -> capability-checked Effect
  -> Markdown/Git + durable operational stores
```

The Product Host owns one long-lived compiler runtime and remote admission. It
does not own every way Git can change.

## Five design decisions

### 1. Controlled host-mediated mutation

Current capture, settle, proposal application, and assistant authoring can
materialize working-tree bytes before the Git commit fully lands. A failure or
process death can leave ambiguous bytes, and a naive rollback could overwrite a
human edit made concurrently.

Create one deep mutation Module for all Dome-mediated Git-native writes. Its
Interface accepts a bounded change set, expected base/revision, actor/device and
request identity. Its implementation owns:

- a cross-process mutation lease built on the existing file-lock substrate and
  coordinated with compiler-host locks;
- commit/tree construction before checkout materialization where possible;
- ref CAS and immutable request identity in commit metadata;
- conditional per-file atomic replacement only when expected owner bytes still
  match;
- index reconciliation;
- a small durable recovery journal for "commit landed, materialization
  incomplete";
- restart reconciliation to repaired or explicitly diverged state.

All Dome commands that mutate the workspace use this Module. External
Obsidian/agent edits do not take its lane; they are protected by expected-byte
checks and are never overwritten.

Correct acceptance is eventual reconciliation:

- no commit and owner bytes untouched; or
- one attributable commit with the checkout repaired; or
- one attributable commit and an explicit divergence requiring owner action.

Instantaneous multi-file atomicity or byte restoration after arbitrary process
death is not promised.

### 2. One external host lifecycle, cohesive internal Modules

Replace/extract—not duplicate—the lifecycle logic currently split across
`dome serve`, `dome http`, and their large CLI implementations.

The external Product Host Interface stays small: start, readiness, close. Its
implementation composes internal Modules/Adapters for:

- compiler poll/scheduler and config/extension reload;
- operation admission and classified leases;
- controlled mutation lane and recovery journal;
- HTTP/static PWA Adapter;
- device authentication;
- bounded AgentRuntime sessions;
- transcription Adapter;
- graceful shutdown.

Compatibility commands delegate to the extracted implementation. There is no
permanent parallel product host. V1 chooses restart/reopen on config, provider,
or extension changes unless measured hot reload is demonstrably safer.

One OS/file ownership lease refuses a second long-lived host. This does not
prevent ordinary Git editors or short local CLI reads.

### 3. Classify operations instead of one global mutex

Do not declare all reads concurrent or all views immutable. Characterize the
long-lived runtime and SQLite handles, then enforce this initial matrix:

| Class | Examples | Initial rule |
|---|---|---|
| Immutable adopted read | Git blob read, pure projection query, recents | concurrent after safety tests |
| View execution | Today, installed view; may ledger operational rows | short bounded view lease |
| Operational read/write | questions, proposals, credentials, receipts | store-specific SQLite transaction |
| Workspace mutation | capture, settle, assistant authoring, apply | one bounded FIFO lane + expected revision |
| Engine tick | adopt, garden, scheduled work | existing engine locks coordinated with mutation admission |
| Model generation | conversation/transcription | no vault lease; each tool call borrows one short classified lease |

The mutation queue has a bound, cancellation, timeout, and 429/retry response.
Shutdown stops admission, aborts or drains sessions, reconciles active
mutations, then closes the Vault.

Today may later become a cached adopted read model, but V1 treats it as a view
execution because it runs a processor and writes ledger evidence.

### 4. Shared browser-safe contracts and truthful receipts

Create a dedicated `./contracts` companion entrypoint with dependency-light
Zod schemas for PWA-used requests, responses, errors, receipts, readiness, and
SSE events. Do not re-export it through the SDK root if doing so weakens core
import fences. React presentation remains outside it.

Both server and browser validate runtime data. Malformed SSE is an error, not a
discarded frame.

The authenticated bootstrap/readiness document includes:

- product build and supported contract versions;
- opaque vault identity/display name, never filesystem path;
- device identity and grant;
- host liveness and vault readiness;
- adopted/current state and last successful compile;
- model and transcription readiness;
- PWA asset compatibility.

Capture identity must survive archive/rename and restore. Put it in the
committed artifact or commit trailer. The host receipt store is a rebuildable
lookup/reconciliation index, not the sole source of idempotency truth and not a
pretend SQLite+Git distributed transaction.

### 5. Concrete pairing, sessions, backup, and recovery

#### Pairing and request identity

Only a local-console command may mint the first or recovery pairing code. It is
high entropy, one-time, short-lived, attempt-limited, and invalidated on use.

The same-origin PWA exchanges it for a Secure, HttpOnly, SameSite=Strict device
cookie with explicit path and lifetime. CORS is denied by default. Mutations
validate the exact configured external origin and CSRF token; forwarded host or
origin headers are trusted only through the configured Tailscale Adapter.
Tailnet membership is transport context, not Dome device identity.

CLI/MCP/scripts receive separately scoped opaque bearers. Server-side storage
contains hashes, device name, grant, auth epoch, creation/last-use, and revoke
state. Every request resolves to actorId, deviceId, requestId, and grant.

If every device is revoked, recovery is local-console-only. There are no
accounts, OAuth, organizations, or general policy engine in V1.

#### Sessions

Conversation is not durable truth. Server sessions remain ephemeral but gain
device ownership, one active turn, idle and absolute TTL, maximum sessions and
turns, bounded context, cancellation, and time/tool/model-cost limits. A PWA may
retain its visible transcript locally. Host restart recreates a session
explicitly rather than stranding a cached id.

#### Backup and migration

Backups are host-quiesced, encrypted, checksummed snapshots of committed Git
refs/objects (including adopted refs), config and local providers/extensions,
and every durable operational store. The host can drain its own lanes but
cannot freeze Obsidian or a foreground agent. A dirty working tree therefore
either blocks the normal backup with an actionable warning or is captured as a
separately labeled dirty overlay using stable-hash retry; it is never silently
described as a consistent committed snapshot. SQLite snapshots use a real
connection-level snapshot/checkpoint mechanism; copying live DB/WAL files is
not sufficient. Projection state may rebuild, but answers, proposals, pending
outbox, quarantine, and audit cannot silently disappear.

Secrets have an explicit inclusion/redaction and encryption-key policy.
Retention and restore verification are part of the product contract.

A blank-host restore reconstructs the device registry for audit but increments
the auth epoch and invalidates all cookies, bearers, and unused grants. The
owner must pair again locally; revoked credentials never resurrect. A failed
pre-commit upgrade is not a blank-host restore: rollback restores the exact
N-1 durable snapshots and preserves the N-1 auth epoch, credentials, and audit.

Rollback means restore before the upgraded host admits writes. Once version N
accepts writes, recovery is forward-fix/forward-migrate unless the owner
explicitly accepts losing post-upgrade work. Each changed durable store has a
frozen N-1 fixture and transactional migration.

## PWA reliability choices

### Capture

Use the existing IndexedDB idea through the small `idb` wrapper rather than
maintaining raw transaction plumbing. Request persistent storage where
supported, show whether it was granted, list all pending captures, and support
copy/export/delete.

V1 offline capture is text-only. Online voice records, transcribes, enters a
reviewable text draft, then queues the text. Persisting audio blobs offline is
deferred until quota, encryption, privacy, and iOS eviction behavior are
designed and tested.

Capture states are: draft, saved locally, sending, committed, adopted, blocked,
diverged, failed. The UI never says "Captured" at an earlier state.

### Conversation and sources

One client connection state covers connecting, ready, stale, offline,
auth-expired, host-degraded, incompatible, and retrying. Initial fetch failures
are visible. The green pulse is removed unless backed by readiness.

Ask supports Stop, Retry, timeout, premature EOF, host restart, and session
recreation. Other devices and Today remain responsive during generation.

Citations and Activity rows open an adopted source reader with path, commit,
and readable inert Markdown plus an exact raw view. This closes the Recall
loop before adding more panels.

### PWA platform

Use `vite-plugin-pwa`/Workbox for app-shell precache, manifest/assets, and update
prompts only; it is not the capture durability mechanism. Cache no sensitive
vault responses by default.

Add 192/512/maskable/touch icons, standalone metadata, safe areas, dynamic
viewport, offline shell, and an explicit update/reload flow.

Use Playwright Chromium for installed-artifact E2E, plus real-device iOS Safari
gates. Accessibility includes visible focus, 44px controls, dialog focus
management, live status announcements, keyboard operation, reduced motion,
contrast, zoom, and dynamic type.

Keep Bun's Fetch server and existing HTTP tests. A router framework does not
solve lifecycle, scheduling, auth, or product semantics. Do not add a general
auth framework before accounts exist.

Web-platform grounding:

- [Microphone capture requires a secure context](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).
- [Tailscale Serve can privately proxy a loopback service over HTTPS](https://tailscale.com/docs/reference/tailscale-cli/serve).
- [OWASP recommends against browser localStorage for session identifiers](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html#local-storage).
- [`vite-plugin-pwa` supplies Workbox-backed app-shell and update plumbing](https://github.com/vite-pwa/vite-plugin-pwa).

## Vertical execution plan

Every implementation phase (P1–P6) ends in an installed-artifact PWA journey.
The PWA is not deferred until after a horizontal backend rewrite.

### P0 — Freeze the contract and threat model

Deliver the one-owner/one-vault scope, beta matrix above, operation classes,
pairing and recovery threat model, privacy/retention policy, readiness schema,
backup objectives, and versioned second-user scenario. Ratify the same product
ordering in `VISION.md`, [[wiki/concepts/client-model]], and
[[wiki/specs/http-surface]] so PWA-first Dome Home replaces the stale
hosted-before-native roadmap without changing the compiler/client distinction.

Exit: the contract answers who may mint authority, who owns each write, what
survives restart/restore, where secrets live, and what ready means.

### P1 — Safe text capture vertical slice

Deliver shared contracts needed by capture; the controlled-mutation Module and
recovery journal; migrate capture first; stable capture identity and typed
receipt; minimal local-console pairing and paired PWA; visible persistent text
queue with idempotent replay.

Exit journey: install development artifact, pair browser, go offline, save and
export a pending text capture, reconnect/retry, and observe one logical capture
reach committed then adopted. Fault injection yields untouched owner bytes,
repaired checkout, or explicit divergence. P1 is loopback/in-process only;
remote exposure remains disabled until P3's hardened-auth gate passes.

**Implemented 2026-07-11.** `contracts/capture.ts` and the PWA IndexedDB
outbox provide the typed durable queue; `src/mutation/controlled-mutation.ts`
provides expected-byte admission and crash reconciliation; capture carries a
stable artifact identity; and the temporary loopback pairing Adapter removes
the browser bearer. `tests/product/pwa-loopback-capture.test.ts` proves the
real listener's pair → committed → duplicate retry → adopted sequence. PWA
tests separately prove offline persistence/export and mutation fault tests pin
all three recovery outcomes. Remote pairing remains refused.

### P2 — Long-lived host and Today frame

Extract the compiler lifecycle into the cohesive Product Host, inject the
long-lived runtime into HTTP, add the operation scheduler/readiness, serve
bundled PWA assets, and migrate settle/assistant authoring through controlled
mutation. Migrate `performApply` as well so CLI proposal application cannot
remain the unsafe exception; cover stale base, CAS failure, recovery journal,
and checkout divergence. Keep compatibility commands delegating rather than
duplicating.

Exit journey: a slow fake model turn cannot block Today, adopted source reads,
or a second device's capture; killing and restarting leaves no stale ownership
or half-applied host mutation. The second client is in-process or loopback;
Tailscale/remote access is still disabled.

**Implemented 2026-07-11.** `dome home` now owns one long-lived Vault, exclusive
host lifecycle, authenticated readiness, built-PWA serving, loopback pairing,
and a bounded operation scheduler. Views, workspace mutations, and compiler
ticks share one conservative FIFO lease; adopted reads and generation remain
unleased. The real listener journey stalls a fake model while Today, an adopted
source read, capture, and subsequent adoption complete. Settle, proposal apply,
and hosted assistant authoring now converge through controlled mutation with
expected-byte CAS, request attribution, restart recovery, and explicit landed-
commit divergence handling. Remote authority remains disabled for P3.

### P3 — Bounded Ask and hardened device auth

Deliver complete device grants/revoke/rotate/auth epoch, origin/CSRF/security
headers, request attribution and rates, bounded AgentRuntime sessions, shared
SSE validation, Stop/Retry/session recreation, model/transcription readiness,
and source reader. Only this phase enables the configured Tailscale HTTPS
origin and remote-device pairing.

Exit journey: pair phone and desktop with different grants, run concurrent
turns, open evidence, revoke one device without affecting the other, restart,
and recover conversation explicitly. Deterministic features remain useful with
model and transcription disabled.

**Checkpoint P3.1 implemented 2026-07-12.** Durable Device Authority stores
device identity separately from append-only credential history; one-time local
pairing grants pre-bind name and scoped capabilities; credentials and CSRF
secrets are hashed at rest; rotation/revocation/auth epoch and expiry survive
restart. Every transition is serialized and adversarial two-handle tests pin
exchange, rotate, revoke, authenticate, and invalidate races. `dome devices`
provides the local owner Adapter. HTTP adoption of this Interface remains P3.2.

**Checkpoint P3.2 implemented 2026-07-12.** Dome Home now opens the durable
Device Authority and resolves every non-static HTTP request to an immutable
device context before routing. Exact configured origins, double-submit CSRF,
secure host-only cookies, response hardening, per-device route/assistant
grants, and device-owned sessions replace the Product Host's temporary shared
authority. The PWA restores the non-authorizing double-submit CSRF cookie into
memory on reload; no rotating bootstrap endpoint or localStorage secret is
needed. Pairing, revocation, credential
rotation, auth-epoch invalidation, and cookies survive host restart; an
optional exact HTTPS external origin enables a private reverse proxy, while an
explicit HTTP loopback origin supports Vite development and the host itself
remains loopback-bound. Standalone `dome http` retains its
compatibility bearer and P1 loopback Adapter. Bounded session resources,
Stop/Retry, shared SSE validation, and persistent device-attributed mutation
receipts remain P3.3.

**Checkpoint P3.3a implemented 2026-07-12.** AgentRuntime now owns bounded
session/turn admission, deterministic expiry, bounded retained context,
cooperative cancellation, and turn timeouts. Cancellation retains capacity
until the provider exits. The HTTP Adapter exposes an owner-bound idempotent
cancel route and typed retry/expiry responses. Server and PWA share one strict,
bounded `dome.agent.stream/v1` decoder; malformed or prematurely ended streams
become visible retryable errors. Stop/Retry presentation and explicit restart
recovery remain P3.3b; exact source reading and durable receipts follow as
P3.3c/P3.3d.

**Checkpoints P3.3b and P3.3c implemented 2026-07-12.** Ask now owns one
explicit client turn handle at a time. Stop aborts that exact stream, waits for
the owner-bound server cancellation result, and reconciles late terminal
events without opening a second turn. Retry starts a fresh conversation only
after an explicit warning that external actions may repeat; missing and
expired sessions are visible states and are never replayed automatically.
Conversation boundaries, terminal errors, and recovery remain in the visible
transcript. Citations now open through a shared, strictly validated
`dome.source-document/v1` Interface that reads only canonical user Markdown at
the cited commit when it is the current adopted commit or retained adopted
history. The reader checks Git blob metadata before allocation, caps responses
at 512 KiB, excludes engine metadata, and maps repository failures to typed
unavailability. The PWA binds every successful response back to the requested
path and commit and presents it as safe rendered CommonMark/GFM with inert
Obsidian wiki-links and an exact raw toggle in a keyboard-contained dialog.
Raw HTML and remote images are never activated. Persistent device-attributed
mutation receipts remain P3.3d.

**Checkpoint P3.3d implemented 2026-07-12.** The Product Host owns a separate,
non-rebuildable `request-receipts.db` using WAL with full synchronous durability.
Authenticated HTTP mutations and every mutating assistant tool fail closed if
their receipt cannot be admitted. Receipts contain only opaque request,
operation, device, credential, transport, lifecycle, result-code, and commit
metadata—never bodies, prompts, answers, paths, model output, or credentials.
Each assistant action is a distinct child operation sharing its turn request
id and borrowing the correct short scheduler lane; read tools create no rows.
Known rejections, successful commits, recovery-required landed commits, queued
cancellation, and genuinely uncertain post-side-effect outcomes remain
distinct. Startup marks prior-host admitted work interrupted, and only safe
successful/rejected history is explicitly pruneable. P3.3 is complete.

### P4 — Self-contained distribution, backup, and upgrade

Deliver the signed macOS product artifact with pinned runtime and PWA; one
install/start/restart/status/uninstall lifecycle; guided Tailscale/model
setup; encrypted consistent backup; blank-host restore; frozen
N-1 migrations; pre-admission rollback.

The first P4 checkpoint is deliberately narrower: `bun run
build:home-artifact` produces a versioned `darwin-arm64` tarball containing a
pinned Bun runtime, Dome runtime assets, production dependencies, and the built
PWA. Its relocatable `bin/dome` wrapper works without a source checkout, and
the v1 manifest plus sorted checksums make the contents inspectable. This
checkpoint is **unsigned, not notarized, and has no upgrade mechanism**; those
remain P4 work, along with lifecycle management, backup/restore, migrations,
and guided provider setup. The npm package rehearsal remains the SDK release
gate and is intentionally separate from this end-user artifact.

The next P4 checkpoint adds the supervised macOS lifecycle as nested
`dome home install|start|restart|status|uninstall` commands. It installs the
self-contained artifact as an immutable content-addressed managed release and
uses one closed per-vault installation record as the sole selector for the
LaunchAgent integration,
waits for schema-valid pairing readiness, refuses legacy Serve or foreground
Home conflicts, and preserves artifact bytes, the complete vault, state,
logs, the installation record, and managed releases on uninstall. Signing and
notarization, upgrades/rollback, release garbage collection, in-place/merge recovery, and provider setup remain
explicitly deferred P4 work.

The following P4 checkpoint adds encrypted offline backup creation,
verification, and public blank-host restore. The Home artifact bundles pinned
official age v1.3.1 tools; `dome backup keygen|create|verify|restore` fences supervised Home, snapshots the exact
clean committed Git/state inventory, uses connection-level SQLite snapshots,
publishes atomically without replacement, and validates a closed checksummed
manifest. Backup creation now uses the durable lifecycle suspension bracket,
then the operational SHARED lease and complete external-plus-local Product
Host ownership in fixed order. Archive and resume truth remain independent, so
a created archive is never hidden by a failed or deferred Home restart. Blank-host
restore accepts only an absent absolute target, reconstructs and validates in
private sibling staging, checkpoints a fresh Device Authority epoch, fsyncs
the reconstructed tree bottom-up, and uses one canonical target identity with
macOS atomic no-replace publication. Signing/notarization, upgrades/rollback, and
guided provider setup remain P4 work.

The next P4 checkpoint establishes write-disabled upgrade probation without
overclaiming a complete upgrade. `dome home --upgrade-probation` derives the
candidate id/version from the strict invoking-artifact verifier, takes the same
external cross-process ownership lock as normal Home, and boots a deliberately
small validation Adapter. One initial `realpath` supplies the vault identity to
admission and both modes' locks, so aliases cannot split ownership. A stale
same-host/dead-PID vault lock may be inspected and ignored but is never mutated;
malformed, remote, and ambiguous holders remain closed. The Adapter serves only
loopback liveness/readiness
and closed pairing status. It never opens the Vault or any SQLite store, never
runs recovery/receipt interruption, never creates a vault id, and never starts
the engine tick/scheduler; every other route fails `503` before implementation.
Readiness is explicit (`host.state: probation`, exact `artifactId` and
`productVersion`, `writesAdmitted: false`). There is no committed mode or
boolean escape hatch in this checkpoint. Durable transaction journaling,
snapshots, migrations, commit-before-admission, pre-commit rollback, frozen
N-1 fixtures, signing/notarization, and guided provider setup remain P4 work.

The following P4 checkpoint adds the external pre-commit upgrade transaction,
without pretending the complete upgrader exists. A closed, private, fsynced
`active/` journal under the per-vault Home installation directory binds one
transaction to canonical old/candidate release and selector evidence. Prepare
uses a shared source-unopened, privately staged `quick_check` + `VACUUM INTO`
primitive to snapshot the six durable SQLite stores plus optional
quarantine/host identity. Projection is
explicitly omitted as rebuildable, and Git/Markdown are outside rollback.

Prepare/restore have no boolean quiescence escape hatch. This bounded P4
checkpoint implements one DELETE-journal coordinator under excluded
`.dome/state/locks/` state: ordinary operations hold lifetime SHARED leases and
upgrade engagement drains them under EXCLUSIVE before publishing a private,
fsynced external Home marker, then holds kernel-managed EXCLUSIVE ownership
through prepare/restore without a PID/stale-file protocol. Runtime, normal
Home, Home lifecycle mutations, proposals, ledger read/repair, devices, and
live backup acquire before mutable openers; an exact structural inventory is
a reviewed drift alarm and behavior tests pin representative denials.
Successful prepare leaves the
barrier engaged across return and process death. Restore clears it only after
durable terminal evidence, coordinator last. Current normal Home rejects
active invalid or pre-commit evidence before any mutable opener. Restore
refuses selector drift, preserves
N-1 Device Authority active/revoked credentials, grants, epoch, and audit,
replaces and fsyncs each
state entry idempotently while prepared, and removes WAL/SHM only after
replacement. A missing or corrupt failed-candidate payload is never a rollback
prerequisite. `restored` is terminal and never replays the snapshot over later
N-1 writes. Artifact metadata carries writer-barrier protocol v1. At this
frozen checkpoint `distribution.upgradeSupported` remained false; the later
0.2 activation pipeline is the only path that can emit true. Intact legacy v1
artifacts stay runnable but are ineligible on either side of an upgrade. Cross-surface
exclusion is complete; backup consumes supervised lifecycle suspension, while
the upgrade orchestrator must consume the same seam because current Home holds
a lifetime lease.
The next bounded checkpoint freezes the exact predecessor before changing
production schema: six readable canonical SQL dumps plus a closed provenance,
schema, and logical-canary manifest. A private closed six-store migration
Module then proves exact N-1 compatibility from copy-first private rollback
snapshots during prepare and candidate manifest compatibility before journal
publication. Prepared retries use a deterministic, cleaned private scratch
root outside the closed active journal inventory. The artifact builder emits
optional protocol-1 `durableState` evidence; legacy omission remains runnable
and old-side eligible but cannot be a candidate. Only request receipts change,
adding the partial prune index through one exact old-hash route. Ordinary opens
still refuse N-1. `migratePreparedHomeUpgrade` runs only against an already
published `prepared` transaction under operational EXCLUSIVE and both Product
Host locks, preflights all six before mutation, supports predecessor/current
idempotent retry, and leaves journal and barriers prepared/closed. Fault tests
prove rollback of store transactions, retry after a committed-store crash, and
exact N-1 restore including credential truth.

The installed journey distinguishes immutable fixture truth from runtime
truth. It first validates the raw six-store canaries immediately after
materialization. Frozen Home startup and its first tick then perform ordinary one-time recovery:
the due handlerless outbox row fails once, the stale admitted request receipt
becomes interrupted/recovery-required, and the pending scheduled garden
proposal stays pending because its `dome.markdown.attic-sweep` owner and
`patch.propose` capability are live. Its linked run is generated through the
real proposal and ledger interfaces with coherent schedule, effect-hash, base,
source, change, and capability-use provenance. The closed frozen source
inventory also pins the owning `dome.markdown` manifest bytes, so CI proves the
owner and grant from the checkout without requiring Git history.

The rehearsal validates the entire selected six-store post-start canary before
capturing that exact state as the quiescent runtime baseline, waits for a
distinct authenticated host tick, and proves the baseline is unchanged. Every
later N-1, migrated N, rollback, and forward-repair check preserves that
runtime baseline while continuing to prove the appropriate schema hashes and
active/revoked credential truth.

The private candidate-cutover checkpoint now composes those foundations behind
one phase-free interface. It suspends and drains current Home, prepares and
migrates frozen N-1, launches the exact managed candidate in write-closed
probation, fully validates readiness plus closed pairing/capture behavior,
drains it, and re-proves all six stores before durable selector commit. The
v2 journal records transaction-bound probation and `switching`, publishes the
plist first and installation selector last with CAS-shaped verification, then
records irreversible `committed`. Only exact candidate lifecycle
authorization can release the external and operational barriers before Home
resumes. Normal admission then accepts only the manifest-derived candidate
id/version; N-1 and wrong-version launches remain closed.

Any `prepared`/`switching` failure restores exact N-1 selectors and durable
state automatically, even when the candidate payload or live vault-id evidence
is missing or corrupt. `committed` is forward-only: missing/corrupt candidate
evidence reports `recovery-required` and never rolls back. The cutover result
keeps durable `transactionOutcome`, `handoffError`, and raw lifecycle result as
separate truths; top-level readiness derives from handoff plus lifecycle.

Crash recovery has one narrow lock-order exception. An already-active
`prepared`/`switching` attempt restores before reacquiring lifecycle Tx2 because
selector/plist bytes may no longer match the old resume target. The retained
lifecycle row denies every start and mutation, real operational EXCLUSIVE plus
both host locks serialize restorers, and recover mode never recreates a row a
winning recoverer cleared. Concurrent recovery tests pin one winner, one
loser, terminal `restored`, and reopened admission.

The phase-free upgrade intent, terminal-journal retirement, exact committed
candidate forward repair, and thin `dome home upgrade [--vault] [--json]`
Adapter are now present. Lifecycle status exposes one read-only, phase-free
current-upgrade summary and makes active, broken committed, or unavailable
coordination nonzero. General artifact parsing accepts a boolean capability,
while both new-attempt boundaries require exact
`distribution.upgradeSupported: true`.

The exact 0.3 release builder now emits `true` only after a private staged
pipeline reconstructs the pinned predecessor, exercises this exact command and
status UX through the retained installed N-1→N rehearsal and frozen fixture,
binds the result to candidate/predecessor/fixture identities, writes a local
execution receipt, and re-proves candidate and source before atomic
publication. No public flag or ordinary fixture writer can bypass the gate;
this contract does not claim a real release execution has already passed.
Managed-release collection checkpoint 1 now supplies a dormant, fail-closed
host-wide reachability Module and exclusive tombstone protocol. Checkpoint 2A
adds the canonical Home-bound owner token and places ordinary fresh/idempotent
install release-through-selector publication under the exact global→artifact
rank. Checkpoint 2B now extends the same ownership through upgrade candidate
publication and durable active readback, committed release repair and durable
active reproof, and terminal active-to-history retirement through history then
upgrade fsync. A one-time pre-inventory namespace stabilization pass closes the
process-death window after retirement rename. Collection remains deliberately
unwired through checkpoint 2B. Checkpoint 3 now adds one host-wide manual
`dome home cleanup` Adapter: inspection is the default, deletion requires
explicit `--apply`, public evidence is path-free and redacted, and failed apply
completion is unknown until a fresh inspection. The raw collector remains
behind the Product Host interface with no SDK export or automatic caller.
Checkpoint 4 adds only a count-free optional manual-cleanup advisory after a
healthy committed retirement has returned. It deliberately performs no
automatic inspection: a reachability scan would verify every release, fsync
upgrade namespaces, and take global ownership merely to decide whether to
print a hint, while selectors for other vaults can still protect the retired
release. Rollback and every recovery action remain higher priority.
Automatic retention/scheduling policy remains a later checkpoint.

The authenticated macOS distribution checkpoint adds one Apple Silicon
release command, `bun run build:home-distribution`, above the installed-gated
artifact builder. It preserves the pinned upstream Bun signature, signs the
two pinned `age` executables and closed credential helper, signs and notarizes the outer DMG, staples
the ticket, and rechecks UDIF and uncached Gatekeeper truth. The release
receipt binds the actual native identities, accepted Apple submission, inner
manifest, archive, and redacted activation evidence. Independent verification
requires the expected publisher team and reads the artifact back from a
read-only DMG mount; sidecar metadata is never the authority for embedded
payload identity.

Publication is one fsynced, no-replace envelope rather than a pair of sibling
transactions. `public/` is the exact three-file distributable and `private/`
retains the mode-0600 installed rehearsal preimage needed for audit. The three
release inputs are a Developer ID Application identity, its Apple team id, and
an existing `notarytool` Keychain profile. No credentialed release execution
is claimed by tests: a real signed/notarized artifact and clean-consumer-Mac
acceptance remain release gates. The current product slice adds secure
Keychain credential storage and guided model-provider setup; no workflow or
state-machine framework is introduced.

The secure credential slice is model-only and end to end. A packaged native
helper binds interactive replacement, inspection, decrypting check, removal,
and exact shipped Anthropic provider launch to one validated default Keychain
and vault-id-plus-canonical-path account. Package `0.3.0` binds the helper and
immutable artifact Bun/provider payloads in the signed manifest; the helper
also compiles in both staged SHA-256 values, verifies both held descriptors,
and re-proves the named Bun inode immediately before `execve` after all launch
assembly and Keychain cleanup.
The mutable vault provider remains only an explicit configuration selector,
and no endpoint override crosses the managed credential boundary. Secret bytes
never enter the Dome Bun host; only the fixed provider Bun child receives them
in its explicit scrubbed environment.
`dome home setup status|configure|check|remove` derives truth from vault config,
Keychain presence, the real provider probe, and plaintext-residue inspection;
it creates no setup record and preserves missing/custom config. Rotation is
live for subsequent provider launches and needs no restart. Authenticated local
readiness single-flights concurrent decrypt checks and caches the result for at
most one second, so credential changes are visible within one second rather
than immediately. Every new installation/selection publication boundary
rejects secret-like environment persistence while retaining legacy parsing for
status. A read-only, path-free scanner reports `clean`, `residue`, or
`indeterminate` across live, temporary, staging, active, and immutable-history
copies. Runtime never falls back to legacy plaintext residue. Transcription
setup and orphan Keychain-item collection remain deferred. Exact legacy
Anthropic residue cleanup now ships as a preview-first, lifecycle-owned intent:
it requires verified Keychain/provider readiness, refuses active upgrades,
converges crash-retained tombstones, prunes contaminated terminal archives
without rewriting them, and proves a clean two-pass inventory before resume.

Existing active upgrades remain recoverable even if their already-persisted
selector evidence contains legacy credentials: recovery may replay those exact
bytes only to terminalize the extant barrier, while every new attempt remains
closed. Migration follows terminal recovery so the system never trades a
plaintext-residue problem for a permanently write-closed vault.

Exit journey: a clean Mac needs no source checkout or manual PWA build; it
pairs an iPhone, upgrades an N-1 fixture after backup, handles a forced failed
upgrade without admitting writes, and restores onto a blank host with all
credentials invalidated and durable knowledge/operational state preserved.

### P5 — Offline, accessibility, and product polish

Deliver final Ask/Today/Activity/Capture/Connection modes; truthful stale,
offline, incompatible and degraded states; PWA manifest/service worker/update;
Activity/source navigation; mutation confirmation/retry; accessibility; current
Chromium and real iOS Safari matrix.

Garden proposal review remains absent unless this phase also delivers full
diff/base/provenance/staleness evidence. Blind apply/reject is removed.

The bounded P5.1 checkpoint now ships the honest offline shell: established
GenerateSW/Workbox libraries precache only the generated shell, manifest, and
hashed static payloads; runtime API caching and broad navigation fallback are
absent. A locally paired device can boot into visibly limited offline or
host-unreachable mode, retain/export/replay text capture, and explicitly
activate a waiting update. Live reads and mutations remain disabled until Home
is reachable. The PWA no longer exposes proposal decisions without full review
evidence, and the root implementation gate now tests and builds the PWA.

This checkpoint does not claim final installability icons, full Connection and
readiness UX, offline knowledge browsing, browser automation, real-device iOS
acceptance, or the complete accessibility matrix.

The bounded P5.2 checkpoint ships authenticated Connection truth. The PWA
strictly validates `GET /readyz`, distinguishes offline, unreachable, expired
or revoked authentication, reachable readiness failure, and incompatible
contracts, and keeps prior readiness only as visibly stale context. One pure
access derivation gates Today/source reads, Ask/model use, voice/transcription,
capture replay, and owner decisions from the validated device capabilities,
provider state, and write admission. Host state remains separately visible
rather than disabling read routes that the Home still admits. A compact accessible
Connection disclosure explains vault, device, version, dependency states,
capabilities, and the host's text-only next actions. Re-pairing never clears
the local text queue or replaces the limited local-capture shell.

P5.2 does not add polling, another persisted connection schema, a workflow or
state-machine framework, offline knowledge browsing, install icons, browser
automation, real-device iOS acceptance, or the complete accessibility matrix.

The bounded P5.3 checkpoint makes the installed system Google Chrome stable channel part of the
existing prepublication installed-candidate gate. The exact candidate's
supervised `ready-success` Home pairs through the shipped UI, validates
Connection truth, proves a service-worker-controlled offline reload while
`/readyz` remains uncached, saves and exports one local text capture, revokes
that browser, preserves the queue through auth repair, and re-pairs to one
logical replay. The ephemeral browser context records no trace, HAR, video,
screenshot, or storage state. `playwright-core` supplies browser control; the
release host supplies an installed Google Chrome stable channel, so Dome neither downloads nor
ships a browser.

P5.3 does not claim install icons or Chromium PWA-install UI, visual regression
coverage, screen-reader evidence, real-device iOS Safari acceptance,
signed/notarized execution, or clean-consumer-Mac acceptance. Automated update
replacement is implemented separately by P5.6, not evidenced by P5.3. The
remaining owner gates stay explicit in the Home PWA acceptance runbook.

The bounded P5.4 checkpoint ships the install identity contract: one
code-native charcoal/sage source, tracked minimal-2023 raster/favicon outputs,
stable manifest id, explicit `any`/`maskable` purposes, Apple standalone head
metadata, and a closed exact HTTP/precache inventory. Portable tests pin PNG
dimensions and opaque maskable/Apple output; the artifact rehearsal validates
the emitted head, manifest, MIME/cache policy, and every precached asset. The
existing installed Chrome gate also decodes the exact icon set before pairing.

P5.4 does not claim Chrome's install UI, real-device iOS appearance, visual or
screen-reader acceptance, dynamic type/safe-area behavior, signed/notarized
execution, or clean-consumer-Mac evidence. Waiting-worker replacement is the
separate P5.6 checkpoint; the other items remain owner-window work.

The bounded P5.5a functional-closure checkpoint closes portable contracts for
two existing Home surfaces. Activity is derived from the current branch's
adopted ref, is honestly empty before that ref exists, and identifies each row
with the exact newest-change commit in adopted ancestry. A readable row opens
that immutable revision in the existing source reader; unadopted `HEAD` work
cannot enter the feed. Task completion owns one per-task pending, success, or
failure lifecycle. Success is announced politely and followed by the normal
Today refresh; failure remains visible as an alert with an explicit Retry that
cannot issue a duplicate in-flight settlement.

P5.5a evidence is limited to surface, HTTP, and component tests; the exact
artifact-bound installed Activity and settlement journey continues in P5.5c.
P5.5a also
does not claim adaptive layout completion, global focus-order or
44px-target auditing, screen-reader acceptance, safe-area or dynamic-type
acceptance, visual regression coverage, or real-device iOS evidence. Those
continue into P5.5b and the owner-hardware gates.

The bounded P5.5b adaptive-accessibility checkpoint introduces one local modal
focus Module for source and capture surfaces, four-axis safe-area and dynamic
viewport policy, a 44px enabled-control/coarse-target contract with an inline
prose-link exception, high-contrast focus and secondary text/control
boundaries, reduced-motion suppression, and concise status semantics. The
existing installed system-Chrome journey now includes a gate that checks the
ready shell at 320×568, 390×844, and 844×390 for horizontal overflow, target
size, critical-control containment, visible keyboard focus, and reduced-motion
computed styles, then returns to a stable 390×844 viewport.

Fresh exact installed Chrome responsive evidence requires executing that
artifact-bound gate. It does not prove real-iPhone portrait, landscape, notch,
software-keyboard, Dynamic Type/200%, VoiceOver, or Safari touch/microphone
behavior. Those remain owner-hardware gates. The waiting-worker N→N+1
replacement journey is implemented separately by P5.6.

The bounded P5.5c checkpoint extends the same installed `ready-success`
journey through an end-to-end functional closure. The upgraded Home adopts one
ordinary due-today anchored canary commit. A narrowly granted Chrome device
opens the Activity row at that exact human revision, verifies its source,
closes with focus restoration, then settles the Today task with one click and
an exact successful response receipt. The installed gate binds that receipt rather
than depending on either transient paint. The host independently proves that exact human settlement commit,
closed source, Done-today record, and daemon adoption exactly once; Chrome
reloads to prove the task is gone before continuing offline/auth/replay.

The code and portable non-evidence fences are checked in; fresh artifact-bound
evidence still requires executing the rehearsal. P5.5c does not widen the
remaining real-device, assistive-technology, visual, signed-distribution, or
clean-consumer claims above; update replacement is the separate P5.6 gate.

The bounded P5.6 waiting-worker checkpoint closes the automated update seam
without introducing another Home topology. After the existing installed
Chrome journey, a separate runner loads only the extracted candidate static
inventory and derives an in-memory N by adding one fixed index marker and
changing the exact singular Workbox index MD5. Every other byte is shared with
N+1. One closed, bounded, static-only ephemeral loopback gateway publishes N
and then atomically points at the untouched extracted candidate; it has no API
proxy and `/readyz` remains 404.

An ephemeral system-Chrome context controls N, saves a text capture through
the limited shell, and records its exact IndexedDB identity. After explicit
service-worker update discovery, the runner requires the prompt, waiting
worker, old active controller, and N marker before the human-equivalent
`Update now` action. A controllerchange-driven reload must expose exact
candidate index/worker SHA-256 bytes, no marker or waiting worker, and the same
local capture row. The row is then removed through the UI.

This is deliberately a local-state survival claim, not capture replay, engine
or vault persistence, logical idempotency, API compatibility, Chrome install
UI, multi-tab/background-update behavior, real-device Safari, signed
distribution, or clean-consumer evidence. Portable generation, closed-gateway,
phase, cancellation-settlement, and cleanup tests remain non-evidence; fresh
proof requires the installed artifact rehearsal.

Exit journey: installed PWA boots offline, preserves/exports/replays text
capture, recovers from expired auth and premature SSE EOF, passes keyboard and
screen-reader flows, and explains every degraded dependency.

### P6 — Owner-appliance beta

Run the complete adversarial scenario:

1. clean install and vault init/import;
2. pair phone and desktop;
3. run twenty ordered rounds in which desktop Ask is visibly streaming while
   the paired phone activates the general `Refresh Today` control and opens one
   preselected exact adopted source, waiting for each accessible terminal;
4. while one mediated mutation is pending, Force Quit the exact `Dome Home`
   process and reconcile after launchd `KeepAlive` restarts it automatically;
5. replay one offline logical capture;
6. revoke one device;
7. back up and exercise a failed pre-admission upgrade;
8. restore onto a blank host and re-pair;
9. rebuild projections and compare Markdown/Git, adopted ref, answers,
   proposals, pending outbox, and audit receipts.

Exit: at least five distinct external owner-vaults complete the journey with
consent and without developer intervention. Review capture loss/duplication,
P95 Today/source latency during model work, adoption latency, readiness, model
cost, backup/restore, and upgrade outcomes. All packets must qualify and the
release operator must explicitly complete the out-of-band owner review before
the aggregate becomes `ready`.

Status: local content-free packet validation and aggregation tooling is
implemented. Installed-artifact automation is proven by its separate release
gates; it is not owner-beta evidence. The PWA's independent always-visible
`Refresh Today` control and the managed LaunchAgent's manifest-verified
`runtime/Dome Home` executable alias plus exact `Dome Home` argv0 are general
product seams, not beta-only
telemetry or a collector;
the evidence Adapter has no production caller and can be deleted without
removing them. P6 exit remains blocked on five genuine external-owner runs,
explicit operator review, and the real-device/accessibility and
signed-distribution owner gates. No owner evidence is claimed by checked-in
tests or tooling.

### P7 — Re-evaluate broader deployment

Use P6 evidence to decide whether the next need is more vaults, an optional
relay, or collaboration. Each requires a new design review. No hosted topology
is committed by this plan.

## Current product-compression checkpoint (2026-07-16)

The reliability program delivered the required host, upgrade, recovery, and
installed-PWA machinery, but it also left too many implementation concepts on
the owner's everyday surface. Before broadening the product, Dome is taking a
deliberate compression checkpoint:

- Dome Home and its PWA are the one appliance experience. The old
  server-rendered Today cockpit is retired; `/today` is only a compatibility
  redirect to the PWA when that shell is installed.
- One derived `ProductSession` owns browser access and recovery truth. The
  default surface says Today, Activity, Capture, Ask, Connection, Dome, and
  You. Engine state, provider probes, and protocol details live under explicit
  technical disclosure instead of becoming navigation or competing alerts.
- One Recovery Card presents the highest-priority owner action. Today and
  Activity keep only their local refresh/retry controls.
- One open-loop selector decides which checkboxes are global commitments.
  Daily tasks and explicitly actionable non-daily tasks enter Today; ordinary
  undated checklists stay in their source documents. This changes derived
  projection truth only and never silently edits or closes vault content.
- A failed generated brief is a warning with honest fallback content, not an
  invented owner question or a non-functional acknowledgement workflow.
- The default CLI and onboarding path start with Home. Low-level compiler and
  compatibility hosts remain callable for SDK operators but are not presented
  as a second consumer product.

The next product mission is a **Backlog Review**, not another broad feature:

1. **Shipped:** a paged, projection-backed `TaskBacklog.list` read interface
   over the same global open-loop origin selector, with exact-only grouping,
   full source/block-anchor evidence, and revision-bound keyset cursors;
2. **Shipped:** group explicit commitments by overdue, dated, exact duplicate
   candidate, and undated source context;
3. **Shipped engine/HTTP/PWA-client seam:** keep, defer, or close a reviewed
   batch through `dome.task-backlog.review/v1`, with one locked attributable,
   recoverable commit and one adoption receipt. The owner-facing PWA review
   paint is the next bounded checkpoint;
4. never infer closure, delete prose, or mutate a task merely because it looks
   old or duplicated.

**Live migration checkpoint (2026-07-16).** Dome Home 0.3.7 is installed on
the owner vault from the gated artifact and runs through the stable host-wide
macOS executable identity. The model-provider probe is healthy, and the new
scheduled-processor recovery path replaced the failed morning fallback with an
adopted, source-backed brief. Today's derived task count fell from 311 to 112
because the shared open-loop selector removed 199 ordinary checklist items
from the global commitment surface; no Markdown task was silently closed. The
remaining 112 are 7 daily commitments and 105 backlog commitments (2 overdue,
110 undated), so further reduction requires the explicit reviewed workflow
above. Calendar ingestion remains an owner-visible degraded dependency until
the stable Home executable passes the signed-Mac Calendar privacy gate; do not
turn that permission failure into repeated background retries.

After that bounded workflow, deepen the existing local Capture Queue with
visible queued/sending/failed/filed states and give Ask its own primary action
instead of overloading global Capture. Then return to the P6 external-owner
beta gates. No collaboration, hosted relay, embeddings, generic workflow
builder, or new engine primitive begins before that evidence.

## Cross-cutting release gates

- Host-mediated writes reconcile to no commit/untouched owner bytes, one
  attributable repaired commit, or explicit divergence.
- One host owns one long-lived runtime; duplicate host ownership is refused.
- Model generation holds no vault-wide lease; Today and capture remain
  responsive.
- Mutation admission is bounded and returns retry semantics.
- Every PWA document/event is versioned and runtime-validated.
- No shared browser master credential; device credentials are scoped, hashed,
  independently revocable, invalidated by blank-host restore, and preserved by
  exact pre-commit upgrade rollback.
- Public errors expose no filesystem paths, secrets, or raw provider output.
- Installed artifact includes pinned runtime, migrations, PWA, and manifest.
- Root gates build/test the installed PWA and real product host.
- Backup is consistent and encrypted; restore and each changed N-1 migration
  are exercised.
- Bad auth never renders blank; readiness never claims false green.
- Pending text capture is visible/exportable and replay creates one logical
  capture.
- Ask handles stop, retry, timeout, premature EOF, restart, and source opening.
- Real iOS Safari and Chromium pass install, offline shell, update,
  responsiveness, and accessibility journeys.

## Explicit deferrals

- multiple people sharing write authority in one vault;
- tenant ids inside engine or projection concepts;
- multiple vaults per Product Host;
- peer-to-peer Git/CRDT browser sync;
- full offline knowledge browsing, offline voice, or offline chat;
- generic remote Markdown editing;
- public internet accounts, OAuth, billing, or cloud identity;
- durable server-side chat history;
- garden proposal apply/reject without full review evidence;
- push, TTS, native wrappers, wearables, or arbitrary plugin UI;
- embeddings or reranking without recorded retrieval evidence;
- a new workflow/job/attention primitive.

## Final vision

Dome Home is a personal knowledge appliance: the owner talks, captures, and
decides from any paired device; the compiler keeps one portable vault coherent;
every answer opens its evidence; every mediated write is attributable and
recoverable; and backup, upgrade, and revocation are normal product actions.

That vision requires no engine reinvention. It requires a trustworthy owner of
the existing engine, a safe path for remote intent, and a PWA honest enough to
show what the system actually knows and has durably done.
