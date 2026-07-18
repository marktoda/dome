---
type: spec
created: 2026-07-11
updated: 2026-07-18
sources:
  - "[[cohesive/plans/2026-07-11-pwa-first-product]]"
  - "[[wiki/concepts/client-model]]"
  - "[[wiki/specs/http-surface]]"
  - "[[wiki/specs/agent-host]]"
  - "[[wiki/specs/vault-layout]]"
  - "[[wiki/matrices/pwa-product-acceptance]]"
description: "Dome Home product-host contract: one owner, one vault, many paired clients; trust, readiness, operation classes, lifecycle, and recovery."
status: implementing
---

# Product host

## Contract

The first complete Dome product is **Dome Home**:

> One human owner, one portable Markdown/Git vault, one supervised host, and
> many authenticated devices and local clients.

The Product Host is a concrete deployment Module around the existing engine,
not an engine primitive. Vault, Proposal, Processor, and Effect remain sealed.
The host owns one long-lived compiler runtime and remote admission for one
vault. It does not own every way Git can change: Obsidian, local agents, and
ordinary Git clients remain external writers whose commits become Proposals.

The external lifecycle Interface is intentionally small:

```text
start -> readiness -> close
```

Its implementation replaces and extracts the long-running lifecycle currently
split between `dome serve` and `dome http`. Compatibility commands delegate to
that implementation; Dome does not retain two independent host paths.

## Product and client hierarchy

Conversation is the center of the shipped PWA. Today and Activity frame it;
Capture is globally available. Conversation is not durable product truth: the
vault is. Agent sessions may be ephemeral and bounded because useful outcomes,
decisions, and evidence land in Markdown/Git or durable operational stores.

Remote and local consumers enter through different trust paths:

```text
PWA / remote scripts
  -> paired device identity + scoped authorization
  -> versioned product contracts
  -> Product Host admission and operation scheduling
  -> public Vault + surface operations

Local CLI / local MCP / foreground harness
  -> public Vault + compiler boundary
  -> controlled mutation Module when invoking Dome writes
  -> ordinary external Git commits otherwise
```

The first product does not support multiple human owners, shared-vault
collaboration, multiple vaults in one host, or public multi-tenant service.

## Supported beta

| Dimension | Supported contract |
|---|---|
| Host | macOS under launchd; one vault per host process |
| Distribution | signed/versioned macOS artifact with pinned Dome/Bun runtime, migrations, and built PWA |
| Browsers | current Chromium desktop and real-device iOS Safari installed PWA |
| Same-machine transport | loopback |
| Remote transport | Tailscale Serve HTTPS proxy to the loopback host |
| Public internet | unsupported |
| Uninstall | removes integration/binaries only; preserves vault, state, and backups |

Tailscale is a supported external prerequisite and HTTPS Adapter, not bundled
infrastructure and not an engine dependency. P1 and P2 implementation journeys
remain loopback/in-process only. Remote pairing and Tailscale exposure stay
disabled until P3's hardened-auth gate passes.

P1 uses the explicitly temporary process-local pairing Adapter documented in
[[wiki/specs/http-surface]]. It removes the browser master token and proves the
loopback journey, but does not satisfy the durable device-authority contract
below. P3 replaces its implementation rather than layering remote authority on
top of it.

## Authority model

Do not conflate the three authorization domains in
[[wiki/specs/agent-host]]:

1. client/device authorization;
2. agent workspace policy;
3. processor Effect capabilities.

The Product Host authenticates a request into:

```text
actorId · deviceId · requestId · granted client capabilities
```

The initial pairing or recovery code can be minted only by a local-console
owner action. It is high-entropy, one-time, short-lived, attempt-limited, and
invalidated on use. The same-origin PWA exchanges it for a Secure, HttpOnly,
SameSite=Strict device cookie. CORS is denied by default. Mutations validate an
exact configured external origin plus CSRF token. Forwarded origin/host data is
trusted only through the configured Tailscale Adapter.

Tailnet membership is transport context, not Dome identity. CLI/MCP/scripts
receive separately scoped opaque bearers. The host stores credential hashes,
device name, grant, auth epoch, creation/last-use, and revoke state. Revoking
one device does not affect another. If every device is revoked, recovery is
local-console-only.

There are no accounts, organizations, OAuth flows, or general policy engine in
the first product.

Device mutations are admitted through the separate durable request-receipt
store before their mutator runs. Direct HTTP operations and assistant child
tools share the same six-state, crash-honest lifecycle, but assistant children
have unique operation ids under the turn request id. The store is attribution
and recovery evidence, not an idempotency system and not a simulated
SQLite-plus-Git transaction. It stores no request or tool payload prose.

## Threat model

### Protected assets

- Markdown, Git history, and adopted refs;
- durable answers, proposals, outbox retry state, quarantine, and audit;
- model/provider and transcription secrets;
- paired-device credentials and request receipts;
- locally queued browser captures;
- cited evidence and private conversation content.

### Actors and trust

| Actor | Trust and authority |
|---|---|
| Local owner | root recovery authority; may edit/commit outside Dome |
| Paired device | only its explicit client capabilities; independently revocable |
| Local agent/editor | may change owner bytes and Git without the host lane |
| Foreground agent runtime | bounded session plus client grant and workspace policy |
| Processor | manifest/effective Effect capabilities only |
| Tailscale | private authenticated transport; not application identity |
| Model/transcription provider | external recipient only when configured and invoked |

### Required mitigations

| Threat | Required response |
|---|---|
| Shared/root token theft | no browser master token; per-device cookie/bearer, hashing, revoke, auth epoch |
| Cross-origin mutation | same-origin default, exact Origin, CSRF, CSP, frame denial, no permissive CORS |
| Credential resurrection after restore | restore registry for audit, increment auth epoch, invalidate all credentials, local re-pair |
| Duplicate capture retry | stable capture identity in committed artifact/trailer; receipt store is rebuildable index |
| Slow model blocks owner work | generation holds no vault-wide lease; tool calls borrow short classified leases |
| Concurrent external edit | expected-byte/revision checks; never overwrite owner bytes during rollback/reconcile |
| Process death mid-write | recovery journal; reconcile to no commit/untouched bytes, repaired commit, or explicit divergence |
| Queue/resource exhaustion | bounded admission, timeouts, cancellation, per-device/session limits, 429 retry hints |
| Secret/error disclosure | redacted public errors with correlation id; no paths, credentials, raw provider bodies |
| Dirty working tree during backup | refuse/warn or stable-hash dirty overlay; never call it a consistent committed snapshot |
| External provider exfiltration | explicit provider setup and action; bounded payload; visible readiness/cost policy |

## Operation classes

The host replaces one global request mutex with characterized operation
classes. Correctness comes before maximum concurrency.

| Class | Examples | Initial rule |
|---|---|---|
| Immutable adopted read | Git blob read, pure projection query, recents | concurrent only after long-lived handle tests |
| View execution | Today, installed view; may ledger rows | short bounded view lease |
| Operational transaction | questions, proposals, credentials, receipts | store-specific SQLite transaction |
| Workspace mutation | capture, settle, assistant authoring, proposal apply | one bounded FIFO lane + expected revision |
| Engine tick | adoption, garden, scheduler/outbox | existing engine locks coordinated with admission |
| Model/transcription generation | agent answer, cloud/local transcription | no vault lease; short tool-operation leases only |

The mutation lane is bounded and cancellable and exposes retry timing when
full. Today remains a view execution until a future adopted read model replaces
the processor/ledger path.

## Controlled mutation outcome

All Dome-mediated Git-native writes eventually use one deep mutation Module
built on the existing file-lock substrate and coordinated with compiler-host
locks. External editors do not join its queue.

After failure or restart, a mediated request must reconcile to exactly one of:

1. no commit and owner bytes untouched;
2. one attributable commit with checkout repaired;
3. one attributable commit plus explicit checkout divergence requiring owner
   action.

The product does not promise instantaneous multi-file filesystem atomicity.
The recovery journal exists only for commit-landed/materialization-incomplete
work and is cleared after verified reconciliation.

## Readiness contract

Liveness and readiness are different documents. Liveness says the listener can
answer. Authenticated readiness is a versioned product contract:

```ts
type ProductReadinessV1 = {
  schema: "dome.product.readiness/v1";
  productVersion: string;
  artifactId: string;
  writesAdmitted: boolean;
  contractVersions: readonly string[];
  assetVersion: string;
  vault: { id: string; name: string };
  device: { id: string; name: string; capabilities: readonly string[] };
  host: {
    state: "starting" | "ready" | "degraded" | "blocked" | "probation";
    since: string;
  };
  adoption: {
    state: "current" | "pending" | "blocked" | "diverged" | "unknown";
    head: string | null;
    adopted: string | null;
    lastSuccessAt: string | null;
  };
  model: { state: "ready" | "unconfigured" | "unreachable" };
  transcription: { state: "ready" | "unconfigured" | "unreachable" };
  nextActions: readonly { code: string; label: string }[];
};
```

The vault id is opaque and stable; filesystem paths never cross the remote
contract. `host.state: ready` requires an open vault and usable adopted state,
not merely an HTTP listener. `host.state: probation` is narrower: the exact
candidate artifact is alive and its read-only Git/vault-identity probes work,
but `writesAdmitted` is necessarily false. It must never be interpreted as
ordinary product readiness. Model/transcription degradation does not block
Today, text capture, owner decisions, document reads, or lexical recall.

The PWA consumes this document as authority only after exact runtime
validation. It derives remote affordances in one place: Today and source reads
require `read`; Ask requires `converse` plus a ready model; voice requires
`capture` plus ready transcription; capture replay requires `capture` plus
`writesAdmitted`; resolve and settle require `resolve` plus
`writesAdmitted`. A previous valid document may be shown after transport or
readiness failure, but only as labelled stale context and never to enable an
action. An authenticated 401 returns the device to pairing without clearing
its local text-capture queue or unmounting the limited local-capture shell. A
rejected pairing-code request remains an inline pairing error; it is not fresh
evidence that the current product credential was revoked.

## Capture durability contract

Offline V1 capture is text-only. The PWA requests persistent browser storage
where supported, shows whether it was granted, and keeps pending items visible,
copyable/exportable, retryable, and deletable. Browser eviction remains
possible and is stated honestly.

Online voice records and transcribes into a reviewable text draft before that
text enters the queue. Offline audio persistence is deferred.

Capture states are:

```text
draft -> saved-locally -> sending -> committed -> adopted
                                  \-> blocked | diverged | failed
```

The transport may retry. Stable capture identity must survive archive, rename,
and receipt-store rebuild so replay produces one logical capture.

## Session contract

Agent sessions are device-owned and bounded: one active turn, idle and absolute
TTL, maximum sessions/turns/context, cancellation, and time/tool/model-cost
limits. Session state is not engine or projection truth. A PWA may retain its
visible transcript locally. Host restart returns an explicit expired/missing
session outcome and the client recreates it.

## Backup, restore, migration, and uninstall

A backup quiesces host-owned lanes and takes encrypted, checksummed snapshots
of committed Git refs/objects (including adopted refs), configuration/local
extensions/providers, and every durable operational store. SQLite uses a real
connection-level snapshot/checkpoint. A dirty working tree either blocks normal
backup or becomes a separately labeled stable-hash overlay.

Restore verifies manifests/checksums and may rebuild projections. It never
silently drops answers, proposal decisions, pending outbox, quarantine, or
audit. Blank-host restore reconstructs credential records for audit, increments
the auth epoch, and invalidates all credentials. A pre-commit upgrade rollback
is different: it restores the exact N-1 operational snapshots and preserves
their auth epoch, credentials, and audit history.

Rollback is allowed only before the upgraded host admits writes. After version
N accepts writes, recovery is forward-fix/forward-migrate unless the owner
explicitly accepts losing later work. Each changed durable store has a frozen
N-1 fixture and transactional migration.

Uninstall never deletes the vault, durable state, or backups.

## Lifecycle and configuration

Startup acquires exclusive long-lived host ownership, opens one runtime,
reconciles incomplete mediated writes, validates stores/contracts/assets, and
only then becomes ready. A second host fails loudly.

Shutdown stops admission, aborts/drains sessions, drains or journals active
mutations, closes HTTP, then closes the Vault/runtime. V1 restarts/reopens on
config, model-provider, or extension changes; speculative hot reload is not a
release requirement.

## P2/P3 implementation status

The first Product Host checkpoint implements the small lifecycle Interface
(`start`, authenticated readiness, `close`), exclusive single-vault ownership,
recovery before the long-lived Vault opens, a stable opaque local vault id,
loopback pairing, and characterized operation admission. Model generation and
immutable adopted reads hold no global lease; view work, workspace mutations,
and compiler ticks share one conservative bounded FIFO lane until safe
long-lived-runtime concurrency is proven. The HTTP Adapter can
consume the owned Vault and scheduler while standalone compatibility mode
retains open-per-request serialization.

P2 completed the controlled-mutation migration for settle, proposal apply, and
assistant authoring plus the Product Host/PWA lifecycle. Compatibility
lifecycle delegation finishes with the P4 distribution/service cutover.

## P4 supervised Home lifecycle

The self-contained macOS artifact exposes one nested operator surface while
preserving bare `dome home` as the foreground Product Host:

```text
dome home install | start | restart | status | uninstall
```

The service is the per-vault LaunchAgent `com.dome.home.<vault-slug>`. Install
strictly verifies the invoking artifact and publishes a fully copied,
re-verified, fsynced tree at the immutable content-addressed path
`~/Library/Application Support/Dome/Home/releases/<artifact-id>`. A closed
per-vault `installations/<vault-slug>/installation.json` is the sole selector;
no `current` symlink or ambient invoking path participates after installation.
Current artifacts retain the pinned, signed canonical executable at
`runtime/bun` and add `runtime/Dome Home` as an exact executable twin after
signing and before manifest closure. The deterministic USTAR carries exactly
that alias as a zero-body hardlink to the earlier Bun member; no other
hardlink is admitted. The alias is an ordinary checksummed manifest file, not
a new schema capability or code-signing inventory row. Installed publication
may materialize the two paths as separate ordinary files, but their manifest
bytes, hash, mode, and executable intent remain identical.

`src/product-host/home-artifact-archive.ts` is the single archive-admission
and materialization boundary shared by release tooling and the installed
upgrade gate. It reads one stable bounded regular file, binds any expected
compressed size/digest before admission, caps gzip expansion, limits the
archive to 16,384 entries and the raw manifest to 16 MiB, validates the exact
builder-owned USTAR header encoding before extraction, and admits exactly one
private artifact root. Traversal, escaping or nested symlinks, unsupported
special files, noncanonical modes/metadata, and noncanonical hardlinks are
refused. The raw archived manifest is bound to the post-extraction manifest
and the shipped `verifyHomeArtifact` evidence before the root is returned;
optional receipt identity is checked at the same seam, and failed
materialization removes its private workspace.

`src/product-package/manifest.ts` is the shipped pure parser for the closed
`dome.product-package/v1` identity and inventories. It has no build-tool or tar
dependency. `scripts/product-package/assembler.ts` is the build-only
complete-product assembly module. Its small portable interface exists for deterministic testing and can
return only `evidence: false`; `scripts/product-package.ts` is the sole
release-capable adapter and hardwires the real Home builder, the archive
admission module above, and exclusive directory publication. Assembly requires
one clean tracked `HEAD`, captures that commit once, validates bounded selected
Git blob sizes, and materializes those blobs directly by object id rather than
using worktree or `git archive` attribute semantics. Every subprocess has
bounded output, deadline, kill, and drain behavior. The
normalized tracked stage is inventoried before the expensive Home build, so
selected secret paths, high-confidence secret content, special entries, and
noncanonical modes fail early. Ignored owner files such as a root `.env` are
not inputs and do not make an otherwise clean repository unpackageable.

Exactly one Home build is admitted into private staging. Its archive identity
and build commit must equal the captured package commit through the shared
admission module; the archived
`app/pwa/dist`—never an ambient PWA build directory—supplies the independently
checksummed production PWA and must exactly match the verified Home manifest's
PWA file inventory. `product/manifest.json` uses
`dome.product-package/v1` and closes the package name/version/source commit,
darwin-arm64 platform, Home archive bytes and identity, PWA inventory, and the
sorted path/size/hash/mode inventory for every other packed file. The stage is
re-inventoried after closure, source `HEAD` is re-proved unchanged, and `npm
pack` runs only against that private stage. The build-only, fixed
`tar@7.5.19` parser streams the actual npm tgz without extraction and requires
every `package/` member's path, bytes, digest, and exact mode to match the
closed stage. The copied publication tarball is verified again. The shared
private-directory publication module re-proves parent inode identity and
target absence before exclusive rename and only cleans staging it still owns.
Only then is one absent output directory published atomically.

The operator form is
`bun run build:product-package -- --output <absent-directory>`. It is a package
production command, not the end-user installer. The M2 acceptance gate is
`bun run release:packed-product-rehearsal`. It builds from a private clean clone
at the captured commit, installs the exact tgz with `bun install -g` into fresh
absolute Bun global-package, bin, and cache roots using `--production`,
`--ignore-scripts`, and the copyfile backend, then removes the producer clone,
package-build output, tarball, install cache, and producer HOME/XDG state. Only
after their absence is proved does a neutral-cwd probe under a dead-proxy
execution environment import every declared entrypoint, execute the direct
isolated `dome` bin, and load the shipped installed-product verifier from the
global package.

`src/product-package/installed-product.ts` rejects an aliased package root and
recursively closes the installed file and directory inventory, including
manifest mode, unexpected entries, symlinks, special files, and same-handle
bounded size/hash/mode evidence. It then re-admits the Home archive through the
ordinary strict Home archive module and binds Home artifact, raw manifest, and
build commit to the package manifest. The v2 rehearsal runs once in its own
Apple-Silicon CI job with Bun 1.2.13 and a private HOME/XDG environment. Its
portable orchestration seam can return only `evidence: false`; only the
hardwired real clone/build/global-install verifier promotes complete-product
evidence. npm publication, tags, and a GitHub release remain outside this gate.

Managed publication copies that verified twin once to the direct, host-wide
path `~/Library/Application Support/Dome/Home/runtime/Dome Home` while holding
the global release-store owner. The file and its parent are fsynced, and every
later named release must exact-match the same bytes, mode, and executable
intent. Ordinary product upgrades therefore preserve the intended stable
responsible-code path. This is the design expected to let macOS privacy
controls retain Calendar consent; the signed-Mac Calendar acceptance gate is
the evidence for that behavior, not this path property alone.

For such an artifact the LaunchAgent sets `Program` to that stable host-wide
`runtime/Dome Home` and sets `ProgramArguments` to exact argv0 `Dome Home`, followed by
`app/bin/dome`, `home`,
loopback `127.0.0.1:3663`, and the bundled PWA path. `RunAtLoad` and
`KeepAlive` supervise it; stdout and stderr append to
`<vault>/.dome/state/home.log`. Install/start/restart succeed only after the
public `/pair/status` document returns exactly `dome.device.pairing/v1` with
`available: true` and a boolean `paired`; the compatibility pairing document
is not Product Host readiness.

This executable-basename/argv launch shape makes both the managed Home
process's macOS command name (`ps comm`) and accounting name (`ps ucomm`)
exactly `Dome Home`; argv0 alone does not earn that result. The canonical
pinned Bun path remains unchanged for verification, probation, and runtime
tooling. Historical manifests with no alias remain runnable: selection emits
their byte-compatible legacy plist with no separate `Program` key and
`runtime/bun` as the first program argument. This is a general operator surface, not beta
instrumentation, and gives command-line inspection one human-recognizable
target without runtime mutation or exposing a PID or launchd label as product
evidence. Bare foreground `dome home` remains
an ordinary invoking-shell process; the name is earned by the managed launch
Adapter.

The current artifact contract pins one official Bun generation, so the stable
runtime is deliberately outside the two-document release selector transaction:
selection, rollback, and power-loss recovery never replace it. Upgrade
preflight compares the stable file with both the verified selected release and
the verified candidate. An exact selected-runtime match plus a different
candidate is refused before candidate publication with typed
`runtime-migration-required` truth; a file matching neither verified side is
reported as corruption. A missing stable file may be repaired from the named
selected release. Candidate bootstrap is reserved for a legacy selected
release with no named runtime and occurs only after the prepared transaction
has durably captured rollback evidence. A runtime generation change must ship
an explicit migration design for executable replacement, rollback
compatibility, and possible one-time macOS privacy re-consent; it may not
silently overwrite this identity or masquerade as a corrupt selected release.

Lifecycle ownership is intentionally narrow. Start, restart, and status derive
their paths only from the record and re-verify its release. Status reports the
artifact ID/version and explicit missing-release, corrupt-release,
plist-mismatch, invalid-record, and orphaned-service truth. Same-artifact
install is idempotent; an existing content-addressed release must verify and
is never replaced. A different artifact is reserved for `dome home upgrade`.
An older direct-artifact Home plist or loaded service with no installation
record is never adopted implicitly: the operator must run `dome home
uninstall` and then `dome home install` for the one-time cutover.
Uninstall boots out and removes only the Home plist, then fsyncs its parent. It
preserves the installation record, all managed releases, vault, Git history,
all `.dome/state` databases and files, logs, and backups. Restart uses the
existing plist byte-for-byte. A legacy `dome serve` plist, loaded service, or live serve
heartbeat blocks Home installation with an explicit migration instruction so
two long-lived hosts never compete for one vault.

An install with no environment flags preserves the selected record's existing
environment. Rendering publishes the plist through an exclusive private
temporary file and does not activate launchd until the file and its parent
directory are fsynced. After uninstall, record-plus-release with no plist and
no loaded service is truthfully `not-installed`; if launchd remains loaded
without the plist, status is nonzero `orphaned-service` instead.

Normal Product Host startup crosses lifecycle admission and operational writer
admission through one deep Module. While lifecycle state is inactive, it owns
the lifecycle transaction from the final inactive read through acquisition of
the operational SHARED lease; the returned lease then lives until complete
Product Host cleanup. A concurrent suspension therefore cannot slip between
the lifecycle decision and the lifetime lease. `suspending` and `suspended`
always deny startup and return the exact suspension operation id.

One narrow `resuming` exception breaks the supervisor/child wait cycle: the
launchd child may acquire SHARED while its supervisor still owns lifecycle Tx2,
but only when the durable row says the prior Home was loaded and every launch,
selector, plist, runtime, and entrypoint fact names the exact authorized resume
artifact. Admission re-reads lifecycle and cheap evidence around one complete
managed-release verification, then re-reads lifecycle once more before
publishing the lease. Any drift closes the acquired lease and fails closed.
The same exact proof intentionally admits a stale `resuming` row after the
supervisor dies, allowing launchd to recover the child before a later lifecycle
recovery clears the retained row.
The live-parent integration test pins both completion within the readiness
window and exactly one full artifact-verifier invocation.

The operator lifecycle uses the same coordinator for every mutation. After
canonical-path, macOS, uid, and exact vault-root preflight, `install`, `start`,
`restart`, and `uninstall` take lifecycle ownership first, acquire an
operational SHARED lease inside it, and only then re-read installation,
release, plist, launchd, readiness, and legacy-service evidence. No selector,
plist, release, or launchd conclusion survives a wait for lifecycle ownership.
An active `suspending`, `suspended`, or `resuming` row denies without probing or
mutating launchd and returns its exact phase, purpose, operation id, and last
error. When operational admission is closed before evidence can be read,
`installed`, `loaded`, and `ready` are `null`, never fabricated negative truth.

Install/start/restart activation has one deliberate two-phase handoff.
Recomputation, bootout, strict drain, selector/plist/release publication, and
launchd `bootstrap`/`kickstart` run under both owners. The lifecycle transaction
then commits before the parent waits for HTTP readiness, so the launched child
can acquire normal startup admission without waiting on a parent that is
waiting on it. The operational SHARED lease remains held through that readiness
observation and closes only after the result settles. Lifecycle commit/close
and lease-close failures retain the provisional selected artifact and
publication truth while returning a structured error.

Home treats only launchctl exit `0` as loaded and exact exit `113` as absent.
Any other `print` result, thrown probe, or nonzero `bootout` is ambiguous and
fails before further mutation; strict drain repeats that same proof. This
strict helper is shared with supervised suspension without changing the legacy
Serve lifecycle's compatibility semantics.

`status` branches before lifecycle ownership and every writer/host lock. It
never initializes or repairs the coordinator. Its additive closed `lifecycle`
document reports `inactive`; `active` with phase, purpose, operation id, and
last error; or `unavailable`/`invalid` with the diagnostic. Active, unavailable,
and invalid coordinator truth for a valid initialized vault exits `1` while
still preserving independently observed installation, loaded, readiness, and
artifact fields. Invalid, uninitialized, nonexistent, non-exact-root, or
unsupported pre-lifecycle CLI input remains usage error `64`. A fresh status,
unsupported platform, and invalid or uninitialized vault do not scaffold
lifecycle state.

### P4 encrypted backup checkpoint

The public recovery surface supports encrypted creation, closed verification,
and blank-host restore:

```text
dome backup keygen --output <identity-file>
dome backup create --vault <path> --output <archive> --recipient <age1...>
dome backup verify <archive> --identity <identity-file>
dome backup restore <archive> --identity <identity-file> --target <absent-absolute-vault-path>
```

`keygen` publishes the private identity mode `0600`, refuses overwrite, and
returns only its path and public recipient. Secrets are never accepted through
an argument value or environment variable. The self-contained artifact pins
the official age v1.3.1 darwin-arm64 binaries and upstream license.

`create` is an offline clean-commit snapshot. It refuses legacy Serve,
foreground Home, linked/outer/detached/dirty Git worktrees, Git locks,
surviving mutation/finalize journals, output inside the vault, and unknown
`.dome/state` entries. The crash-honest lifecycle suspension Module records
intent, boots out a loaded supervised Home, and proves drain before backup
acquires an operational SHARED lease and both Product Host locks. It then
best-effort resumes Home through strict pairing readiness. Initial launch,
lifecycle resume, and installed-release evidence share one 120-second pairing
readiness budget measured from readiness observation after activation or
loaded-service admission. Parent preflight verification is outside this readiness
clock; candidate probation remains separately bounded at 15 seconds.
An already-started listener never weakens the exact document check. Active
suspension,
ambiguous launchctl results, selector/plist drift, and either ownership lock
fail closed. An exact installed Home record and direct plist are required even
when launchd reports that Home was previously stopped. Archive creation and
restart are separate results: a published
archive retains its id, checksum, and path even when resume is deferred or
fails, while the command remains nonzero with explicit restart failure. The
same rule applies when no-replace publication succeeds but the parent-directory
durability sync fails: created archive metadata remains visible with a nonzero
uncertain-durability error. The
retained suspension operation id is recovery evidence; no public recovery
command is claimed by this checkpoint.

The closed manifest covers the committed tree and standalone Git repository,
all refs, configuration/local extensions/providers, six durable SQLite stores,
rebuildable `projection.db`, quarantine, and stable vault identity. SQLite uses
`VACUUM INTO` plus `quick_check`; WAL/SHM files are never copied. Git/state is
fingerprinted before and after snapshot. A normalized private ustar payload is
age-encrypted, fsynced, and atomically published.

`verify` privately decrypts and checks the strict manifest, exact paths/modes/
sizes/SHA-256 values, tar structure and size budgets, and every database.
`restore` accepts only an absent absolute target. It decrypts into a private
sibling staging directory, shares the same closed verification and one
extraction path, reconstructs standalone Git and every store, and increments
the excluded recomputable Git index from the exact restored HEAD before
publication, then increments and checkpoints the Device Authority epoch.
The published vault therefore opens as a clean ordinary Git worktree rather
than showing every committed path as deleted/untracked. Existing
credentials and unused grants therefore fail; an archive with no prior Device
Authority reports that truth explicitly. The requested parent is canonicalized
once so symlink retargeting cannot change the lock, staging, or publication
identity. Every restored directory is fsynced bottom-up before publication;
publication then uses macOS atomic no-replace rename and fsyncs the canonical
parent directory. Restore never overwrites, merges, or
restores in place. A failure after publication reports the target as restored
with uncertain durability rather than falsely claiming it is absent.

### P4 upgrade-probation checkpoint

`dome home --upgrade-probation` is the candidate validation launch. The CLI
accepts the candidate identity only from the existing strict invoking-artifact
verifier; a caller-provided version string or environment flag cannot declare
an artifact committed. The launch interface still has only normal and
write-closed probation modes; there is no boolean or `committed` launch mode.
A normal launch selected by an upgrade is admitted only when its
manifest-derived artifact identity exactly matches a durable v2 `committed`
transaction and its candidate selector/plist evidence.

The lifecycle canonicalizes the vault with `realpath` exactly once before
admission or lock derivation, so a symlink alias and canonical path cannot name
different hosts. Probation then takes a cross-process lock outside the vault.
Normal Home takes the same lock before its existing vault-local lock,
preserving mutual exclusion without changing the rollback candidate's
`.dome/state` bytes. Once it owns the external lock, probation ignores only a
well-formed vault-local lock from the same host whose PID is provably dead; it
does not unlink or rewrite that stale evidence. Malformed, remote-host, and
possibly-live locks fail closed. The probation Adapter then bypasses
controlled-mutation recovery, request-receipt
interruption, `openVault`, all SQLite openers, Device Authority, vault-id
creation, Home lifecycle inspection/initialization, the startup engine tick,
and the poll/scheduler loop. A fresh-vault test pins that neither lifecycle
coordinator directory exists before, during, or after probation. Its complete
network surface is public loopback `GET /healthz`, `GET /readyz`, and a closed
pairing status; every other route returns `503 write-admission-closed` before a
mutator, model, provider, or read path that could ledger work can run.

Readiness reports the manifest-derived `artifactId` and `productVersion`,
`host.state: probation`, and `writesAdmitted: false`. Whole-vault fingerprint
tests cover every Git and `.dome/state` byte while candidate readiness and
representative HTTP attempts run; a seeded admitted receipt remains admitted,
proving restart interruption is also skipped. This write-disabled candidate
boot foundation is now consumed by the private candidate-cutover checkpoint
below; it remains unavailable as a public standalone product flow.

### P4 upgrade-transaction checkpoint

`src/product-host/home-upgrade-transaction.ts` is the durable rollback and
selection Module used by the private cutover orchestrator. Its narrow
interface prepares, reads, migrates, commits, restores, releases admission,
and inspects normal-host admission. Candidate launch and lifecycle sequencing
remain in `home-upgrade-cutover.ts`; no public CLI is claimed.
`installation.json` remains selected-release truth. The external journal
records transaction truth only.

The journal lives under the canonical per-vault Home installation directory,
never in `.dome/state`. One private `active/` directory is published with
macOS atomic no-replace rename after every file and directory is fsynced
bottom-up. Its closed v2 document records the canonical vault and transaction
id; `prepared`, `switching`, `committed`, or `restored` phase; exact
old/candidate artifact ids, versions, content-addressed release paths, and
manifest hashes; exact selector, probation, and phase-time evidence; and a
fixed snapshot inventory with presence, original mode, staged size/hash, and
SQLite schema hash. A separate private 0600 archive binds exact old and
candidate `installation.json` and launchd-plist bytes. Persisted probation is
cross-bound to the transaction, artifact, version, and phase-relative time;
full reads also bind it to live vault identity. Closed v1 journals remain
strictly readable and restore-only. Unknown fields, phases, files, symlinks,
special files, redirected roots, corruption, and inconsistent selector or
release evidence fail closed.

Preparation snapshots six durable SQLite stores — answers, proposals, outbox,
runs, request receipts, and Device Authority — plus optional
`quarantined.json` and `product-host-id`. The shared SQLite mechanism copies
the quiesced main file and WAL into private staging without opening the source,
then opens that copy read-only, runs `quick_check`, uses `VACUUM INTO` so
committed WAL state is visible, and validates the standalone result.
`projection.db` is intentionally omitted because it is rebuildable; Git and
Markdown are never part of this rollback snapshot. Private snapshot files are
0600. An absent optional file is explicit inventory evidence, so rollback
removes a file created by N rather than inventing an N-1 value.

`src/operational-state/writer-barrier.ts` is the one cross-process operational
writer-admission Module. Ordinary runtimes and direct store operations hold a
rollback-journal SQLite SHARED transaction for their complete lifetime; the
upgrade Adapter takes EXCLUSIVE, drains those leases, and durably records the
transaction owner before snapshot or restore. A real singleton `SELECT`
acquires SHARED (`BEGIN` alone does not). The coordinator is pinned to DELETE
journal mode, NORMAL locking, and FULL synchronous durability; the ordinary
WAL connection configuration is forbidden here. After durable engagement,
prepare/restore hold the same coordinator's kernel-managed EXCLUSIVE lock for
the whole recovery section. Process death releases serialization without a
PID or stale-file takeover protocol while the committed blocked row remains.

The coordinator lives at
`.dome/state/locks/operational-writers.db`. It is excluded lock state, not
backup or rollback inventory. The Home Adapter additionally publishes a
strict private `upgrade/writer-barrier.json` outside the vault. Prepare leaves
both barriers engaged after return or process death. Restore removes and
fsyncs the external marker only after the journal is durably `restored`, then
clears the coordinator last. The committed path may clear the same barriers
only after the journal is durably `committed` and lifecycle has sealed the
exact candidate selector, plist, artifact id, and version as its resume
target; it removes the external marker first and clears the coordinator last.
Wrong owners, corrupt/unknown state, and ambiguous crash evidence fail closed.
A validation failure before any active transaction publication may perform the
one bounded abort-before-prepare release.

For Product Host startup, the fixed acquisition order is lifecycle startup
admission, operational lease, external Product Host lock, vault-local Product
Host lock, then mutation/store locks. Other admitted work begins at the
operational lease. A supervised quiescing operation such as backup first owns
the lifecycle transaction, durably records intent, boots out, and proves drain;
its callback then follows the operational/external/local/store order. Resume
takes the narrowly proven operational lease while lifecycle ownership remains
held. Normal Home acquires and retains that lease before Product Host ownership,
recovery, or mutable store opening; denial is therefore fingerprint-pure for
Product Host durable stores. Probation remains write-closed and bypasses
lifecycle admission entirely.

Active `prepared`/`switching` crash recovery has one narrow exception to the
ordinary lifecycle → operational order: it restores before reacquiring
lifecycle Tx2 because switching may already have changed selector/plist bytes,
which prevents old-resume evidence from validating first. The retained active
lifecycle row still denies every start and lifecycle mutation. Restore owns
operational EXCLUSIVE plus both Product Host locks. Recoverers serialize on
that ownership and again on lifecycle Tx2; after the winner clears the row,
recover mode is forbidden from recreating it, so a loser fails rather than
opening a second suspension.

Runtime, proposals, activity, inspect/repair, devices, and the durable-state
section of live backup are covered by an exact reviewed-callsite drift test.
Home lifecycle install, start, restart, and uninstall first own lifecycle and
then hold an ordinary lease before plist, selector, release, or launchctl
mutation; status stays lock-free and read-only for recovery diagnosis. This
inventory is a review alarm, not semantic proof. Behavioral denial tests pin
the runtime, proposals, and Home lifecycle seams. HTTP and MCP
inherit runtime or proposal admission. Absent-target restore and the exclusive
upgrade owner are the narrow exceptions.

Normal current Home also inspects active upgrade evidence after ownership and
before controlled-mutation recovery or any mutable store opener; prepared,
switching, corrupt, unknown, or selector-diverged evidence keeps write
admission closed. After `restored`, startup requires the exact selected-old
selectors and old manifest. After `committed`, startup requires the exact
manifest-derived candidate runtime identity and candidate selector/plist
evidence; N-1 and wrong-version launches remain closed. Full snapshot
validation remains the `read`/`restore` and restored-retirement contract.
Committed retirement instead proves exact forward candidate and selector
truth, because irreversible forward recovery cannot depend on obsolete N-1 or
rollback-snapshot contents.

Restore is allowed only before durable `committed`. `prepared` requires exact
old selection; `switching` may expose old, mixed, or candidate selection and
restores `installation.json` to old first, then the plist, before restoring
stores. It validates the closed journal, all retained snapshot evidence, and
the exact old artifact before its first state replacement; candidate
identity/path remain closed journal evidence, but candidate payload existence,
integrity, and live vault-id agreement can never become rollback prerequisites.
Restore atomically replaces each durable file, removes stale SQLite
WAL/SHM only after the main-file rename, and fsyncs the state directory after
every entry. The journal stays in its current precommit phase until the
complete old selection/state and schema hashes validate, so a partial crash
retries idempotently. Only then does it atomically record `restored`. The phase
update stages its private
transaction-named file as a sibling of `active/`, renames it over
`active/journal.json`, and fsyncs both `active/` and its `upgrade/` parent.
Crash debris therefore stays outside the closed active inventory and is safely
replaced on retry. Recovery evidence is retained.
`restored` is terminal and non-replayable: a later restore invocation returns
the validated terminal journal before reading or replacing live state, so
legitimate post-rollback N-1 writes cannot be erased.
Device Authority is restored without epoch invalidation, preserving N-1
active and revoked credentials, grants, device audit, and epoch.

### P4 private artifact publication checkpoint

The normal Home artifact builder is
`bun scripts/home-artifact.ts --output <absent-directory>`. The destination is
the publication transaction and must be absent, including as a file or a
dangling symlink; the builder creates only its parent and never deletes,
merges, or replaces prior output. It assembles the expanded artifact and its
archive together in a private same-filesystem sibling, then runs the shipped
artifact verifier and the ordinary archive rehearsal in that fixed order. The
exact `0.4.0` builder then privately reconstructs the pinned `0.1.0`
predecessor twice, runs the installed N-1→N rehearsal against that archive,
the exact staged candidate archive, and the frozen fixture, and binds the
returned predecessor, candidate, fixture, host, and scenario identity. It
writes that typed result beside the archive as a local execution receipt,
re-hashes the archive and raw manifest, re-verifies the expanded artifact, and
re-proves the clean source HEAD. The receipt is not a signature, notarization,
or transferable cryptographic attestation. Only every success permits one
exclusive atomic rename of the complete output directory. Prepublication
failures remove their private staging state when
its owned inode is still present and expose neither final path; cleanup never
follows a replaced path. Concurrent builders leave one complete winner and
never replace it. This is an atomic-visibility and no-replace boundary, not a
new power-loss durability claim. The package is `0.4.0`; only this closed
installed-gated builder writes `distribution.upgradeSupported: true`. The
exported fixture metadata writer remains fixed-false and cannot publish.

### P4 frozen N-1 migration checkpoint

The one supported predecessor is frozen as a checked-in, readable fixture
before production schema changes. Its closed manifest binds the exact source
commit, product/Bun/SQLite versions, six schema-defining source hashes, six
compiled schema hashes and meta tables, canonical SQL hashes, schema-inventory
hashes, and logical canary digest. The SQL materializes real standalone
answers, proposals, outbox, runs/capability audit, request receipts, and Device
Authority databases. CI only consumes and round-trips the fixture; the
create-exclusive freezer is a test utility, not a release-time generator.

Raw fixture validation and installed runtime preservation are separate
contracts. Before Home starts, the installed rehearsal proves the immutable
SQL still matches all raw logical canaries. The first exact N-1 host
startup/tick is then expected to normalize only genuine crash-era operational work: a due
handlerless outbox row becomes failed with one attempt, a stale admitted
request receipt becomes `interrupted` with `host-restarted`, `unknown`
adoption, and recovery required, while the pending proposal remains pending
under the live scheduled garden `dome.markdown.attic-sweep` processor and its
`patch.propose` grant. The linked ledger run carries the same processor,
schedule provenance, real patch effect hash, and proposal run id. The frozen
source inventory pins the owning extension manifest exactly; fixture tests
hash and parse the checked-out bytes and therefore require no predecessor Git
history.

The rehearsal validates every selected row in the six post-start canaries
before capturing the resulting observation as its quiescent runtime baseline.
It then waits for a distinct authenticated readiness tick and requires no
further change. All later N-1 and N comparisons use this baseline; schema
proofs and active/revoked credential truth remain separate mandatory
assertions.

The sibling `artifact-receipt.json` pins the separately reconstructed N-1 Home
archive as an **internal compatibility floor**, explicitly not as evidence of a
previously distributed release. `scripts/home-predecessor-artifact.ts`
reproduces it only on darwin-arm64 with Bun 1.2.13: two
`git clone --no-local` detached clean checkouts build the exact source commit
with isolated caches, accept only the pinned historical post-archive rehearsal
failure, and verify the archive checksum before private extraction. That
byte-pinned archive predates canonical USTAR modes and contains exactly eight
package-manager `.bin` symlinks recorded as `0777`. Its compatibility adapter
accepts only the frozen receipt hash and that closed eight-path header inventory,
rewrites those modes to `0755` in a private derivative, and routes the derivative
through the ordinary strict archive boundary; arbitrary legacy modes remain
rejected. It then runs the current artifact verifier, binds raw-manifest identity,
requires byte-identical raw archives, and only then publishes the result.
Receipt parsing and orchestration remain
hermetic cross-platform tests; reconstruction itself is a release-gate
operation.

The immutable frozen 0.1 artifact contains the historical duplicate nested
Home `--vault` forwarding bug. The installed rehearsal therefore invokes only
its predecessor `home install` from the exact initialized vault cwd without
`--vault`, exercising supported upward discovery rather than rewriting N-1.
That historical command also has a fixed ten-second readiness window. The
installed adapter accepts its timeout only when both the process exit and the
complete lifecycle document match the immutable 0.1 installed-and-loaded
late-readiness envelope. The install subprocess itself is capped at sixty
seconds. The adapter then allows at most thirty additional seconds and
requires strict pairing readiness, the exact launchd label, and a current
candidate status observation binding the selected predecessor artifact,
version, paths, and inactive lifecycle/upgrade state before pairing. Every
other predecessor failure remains terminal.
All 0.2 candidate nested commands keep explicit `--vault` and test the fixed
forwarding behavior.

`src/product-host/home-store-migrations.ts` is the private compatibility
Module. Its interface is one closed, sorted six-store protocol-1 inventory and
two operations: all-store preflight, then migration of a published prepared
transaction. It is intentionally not a migration graph. Five stores are
unchanged. Request receipts have the one exact predecessor route, adding the
partial `(finished_at, operation_id)` index used by bounded success/rejection
pruning. Ordinary receipt opening continues to refuse N-1; only the private
upgrade seam can migrate it. The migration callback, canonical DDL, exact
table/index validation, and single meta-row replacement commit in one
`BEGIN IMMEDIATE` transaction. Callback refusal or failure rolls everything
back.

Prepare copies all six live stores without opening them while operational
EXCLUSIVE and both Product Host locks are held, then proves the private
standalone rollback snapshots against the verified selected-old artifact
before journal publication. A modern old artifact with protocol-1
`durableState` must name all six exact snapshot hashes as its current schemas;
this admits a sequential patch upgrade whose stores are already current while
rejecting mixed or unknown state. A legacy old artifact with no inventory
retains the frozen exact-N-1 rule, so an unjournaled partial migration is never
reinterpreted as a sequential upgrade. The candidate manifest is proved
separately to carry the exact compiled six-store inventory and a migration
route for every selected snapshot hash. General artifact verification still
accepts a structurally valid historical protocol-1 inventory; prepare adds the
selected-manifest-to-live-state equality proof. Legacy omission remains
runnable and is allowed on the old side, but makes a candidate ineligible.
Writer-barrier protocol 1 remains required on both sides. The artifact builder
always emits both protocols. At this frozen P4 checkpoint
`distribution.upgradeSupported` remained false; the 0.2 activation pipeline
described below is the only path that can now emit true.

`migratePreparedHomeUpgrade` is private and has no CLI. It revalidates the
prepared marker, journal, selectors, candidate product version, manifest hash,
and six-store compatibility under the same EXCLUSIVE/external/local lock
order. A retry copies all six stores into a deterministic private scratch root
outside `active/`, accepts only each exact predecessor or target hash there,
and removes that scratch root after final proof. It preflights all six before
the first live-store mutation, migrates remaining predecessors
transactionally, and finishes with WAL-aware `quick_check` and target-hash
proofs. The journal deliberately remains `prepared` and both barriers remain
engaged. A crash after one store commits therefore retries forward or restores
the exact retained selected-old snapshot; it can never admit writes or bless an
unjournaled partial vault.

### P4 private candidate-cutover checkpoint

`runHomeUpgradeCutover` is the single private composition seam; callers cannot
select or reorder phases. A new attempt performs supervised Home suspension →
prepare → migrate → launch/prove/drain the exact managed candidate → durable
selector commit → seal candidate lifecycle resume evidence → release write
barriers → resume/readiness. Probation re-verifies the candidate manifest
immediately before spawning only its pinned runtime and entrypoint. It fully
parses `dome.product.readiness/v1`, binds proof to transaction, artifact,
version, vault, `host.state: probation`, `writesAdmitted: false`, and time, and
actively proves `/pair/status` plus unauthenticated `/capture` remain closed.
Every response has a timeout and an incrementally enforced 64 KiB budget.

Commit re-proves all six live stores current, records probation and
`switching`, publishes the plist first and `installation.json` last with
expected-old/desired-candidate CAS-shaped verification and directory fsync,
then durably records irreversible `committed`. Any `prepared`/`switching`
failure automatically restores exact selected-old selection and state. `committed`
never rolls back: recovery proceeds only forward through exact candidate
authorization, barrier release, and resume. Missing or corrupt committed
candidate payload remains closed and reports recovery required.

The result separates durable `transactionOutcome` (`committed` or
`rolled-back`) from `handoffError` and the raw lifecycle result. Top-level
`status` is `ready` only when handoff has no error and lifecycle is `ready` or
`not-required`; otherwise it is `recovery-required`. A prepublication failure
throws because no transaction exists to restore; simultaneous upgrade and
rollback failure throws an aggregate and remains closed. Retained terminal
evidence makes committed release and restored rollback idempotent.

### P4 public upgrade-intent checkpoint

`dome home upgrade [--vault <path>] [--json]` is a thin, lazy Adapter over the
single phase-free `manageHomeUpgrade` intent. It has no artifact-path, phase,
rollback, or recovery-control flags. The exact invoking artifact is the only
new-candidate source; retained precommit work recovers before candidacy is
evaluated, committed work moves only forward, and terminal evidence retires to
immutable bounded receipts. Public results contain fixed messages and public
artifact/operation/outcome/next-action evidence only.

Across the active-to-history rename, retirement compares the complete bounded
terminal journal rather than the smaller receipt summary. Archived committed
disposition reads keep that intrinsic identity independent of rollback bytes;
the strict history audit still reports retained snapshot damage. Archived
restored disposition never weakens: it retains full old-release, selector, and
rollback-snapshot proof.

`dome home status` adds an always-present, read-only `upgrade` projection for
status actions. It maps private precommit phases to `active`, exact extant
terminal truth to `complete`, a broken committed forward proof to
`recovery-required` plus `supply-exact-candidate`, and absent retired truth to
`inactive`. It uses disposition and strict-forward readers without locks or
writes and never reads terminal history to synthesize current coordination.

The artifact parser accepts boolean `distribution.upgradeSupported`; both the
intent and the transaction compatibility boundary require exact `true` for a
new candidate. Both boundaries also require valid SemVer for the selected and
candidate versions and a strict monotonic advance, including standard
prerelease ordering. A legacy non-SemVer installation remains runnable and
repairable but is ineligible for upgrade. Exact committed repair is exempt
because it re-establishes an already-irreversible candidate rather than opening
a new attempt. The exact 0.3 release builder emits `true` only after its private
candidate pipeline reconstructs the pinned predecessor, passes the retained
installed N-1→N rehearsal against the frozen fixture, binds the returned
identities to the still-staged bytes, writes a local execution receipt, and
re-proves candidate and source immediately before atomic publication. This is
a mandatory gate, not a claim that a real release execution has already
passed. Artifact signing/notarization is supplied by the following checkpoint.

### P4 authenticated macOS distribution checkpoint

`bun run build:home-distribution -- --output <absent-envelope>` is the release
boundary for the Apple Silicon Home product. It runs only on `darwin-arm64`
and requires three operator-supplied values: `DOME_CODESIGN_IDENTITY` (a
Developer ID Application identity for the selected team),
`DOME_APPLE_TEAM_ID`, and `DOME_NOTARY_KEYCHAIN_PROFILE`. The profile is an
existing `notarytool` Keychain profile; credentials and profile names are
never copied into artifact metadata, release receipts, or uncapped command
diagnostics.

The builder first runs the complete installed artifact and N-1 activation
gate in private state. It preserves the pinned upstream Bun binary and its
Developer ID signature byte-for-byte, signs the two pinned `age` executables
and the compiled credential helper with the configured Dome identity, and
inventories the exact four native paths again after signing. The arm64 helper
pins a macOS 13 deployment target and stable signing identifier
`com.dome.home.keychain-helper`. The inner artifact manifest binds
source and shipped hashes, TeamIdentifier, CDHash, hardened runtime, secure
timestamp, and canonical entitlements for every executable. Inner artifact
truth is `signed: true, notarized: false`: notarization belongs to the outer
container, not to the expanded directory.

The builder creates and signs a DMG, submits that exact hash with
`notarytool`, validates the complete accepted log envelope, staples the
ticket, and then rechecks the native signature, staple, UDIF structure, and a
fresh enabled Gatekeeper assessment. The independent distribution verifier
requires the expected publisher team, checks the closed receipt and file
inventory, mounts the DMG read-only in private state, runs the shipped
artifact verifier on the embedded payload, and cross-binds its manifest to
the receipt and activation evidence. Adjacent JSON therefore cannot replace
or reinterpret the payload protected by the signed DMG.

One exclusive rename publishes one private envelope. Its `public/` directory
contains exactly the DMG, strict distribution receipt, and redacted activation
binding. Its `private/release-evidence.json` retains the raw 0600 installed
activation evidence without exposing host UID or local paths in the public
release. Files and candidate directories are fsynced before publication; the
parent is fsynced and the complete published envelope is independently
reopened afterward. A collision is a definite no-publish result while a
rename-complete or post-rename failure is reported as published with uncertain
durability, and the possible winner is never removed.

Legacy signed artifacts with the prior exact three-row inventory remain
strictly verifiable and runnable. The optional `homeCredentials` protocol/hash
capability selects the four-row inventory and is required for a new upgrade
candidate; old-side upgrade evidence remains legacy-compatible.

The implementation and hermetic gates do not claim that a credentialed public
release has already been produced. A real Developer ID identity and notarization
profile must run this boundary successfully for each shipped release. A real
signed ACL/rotation execution and clean-consumer-Mac acceptance run remain
release gates.

### P4 secure Home credential substrate checkpoint

`src/product-host/home-credentials.ts` is the one deep macOS Keychain Module
for the shipped Anthropic model provider. Its packaged native helper owns
service `com.dome.home.credentials.v1`, slot `model.anthropic.api-key`, and
account `<product-host-vault-id>:model.anthropic.api-key:<sha256(canonical-vault-path)>`.
The path binding prevents a copied vault identity file from aliasing another
vault's Keychain item. The helper accepts
only an operation plus canonical vault path. It validates the owner-controlled
vault, `.dome`/state/identity closure, sibling runtime, and
every canonical default-Keychain component beneath `~/Library/Keychains`
before retaining the exact `SecKeychainRef` used by the item operation.

The helper performs interactive replacement, inspect, decrypting check,
idempotent remove, and fixed provider execution. The signed artifact manifest
binds the helper, sibling Bun, and the immutable
`app/assets/model-providers/anthropic.ts`; the helper is compiled with the
SHA-256 of the exact staged Bun and provider payloads, then opens, validates,
and hashes both held descriptors before passing the provider to Bun as
`/dev/fd/<n>`. The mutable
`.dome/model-provider.ts` is only the opt-in configuration selector and is
never executed by managed Home. Sibling Bun is held open and its named inode
is re-proved after environment/argv assembly, Keychain cleanup, and `chdir`,
immediately before the final path-based `execve`; macOS provides no `fexecve`,
so artifact signature and inventory verification remain the authority at that
final executable boundary.
Secret bytes never enter the Dome Bun host, argv, persistent files, the host's
global process environment, stdout, or setup results. Only the fixed provider
Bun child receives the API key in its explicit environment together with a closed allowlist of non-secret
Anthropic tuning variables; endpoint override is deliberately excluded.
Custom provider commands remain untouched and run
with a scrubbed non-secret environment without the managed credential.

`dome home setup status|configure|check|remove` is a model-only derived
surface. It persists no setup state and never rewrites `.dome/config.yaml`.
Configure is available only for exact command
`["bun", ".dome/model-provider.ts"]`, performs a decrypting post-write check,
and probes the same helper route used by normal packaged Home. Missing config
points to `dome init --with-model-provider anthropic`; custom config is
reported and preserved. Mutations serialize within one Home process. An
in-flight provider child may finish with its launch-time key; each subsequent
invocation re-reads current Keychain truth, so rotation needs no restart.
Authenticated readiness performs the same bounded decrypting Keychain check
without probing the model network. One shared single-flight resolver and a
cache bounded to one second coalesce concurrent reads; configure, remove, lock,
and unlock transitions become visible within at most one second without
restarting Home. Because the
Keychain account is bound to the canonical vault path, moving or renaming a
vault requires reconfiguration; the prior item remains orphaned until the
deferred credential lifecycle collector handles it.

Legacy v1 installation records remain strictly readable for status and future
migration. New installation, record publication, selection rendering, ordinary
reinstall, and new upgrade attempts reject recognized or conservatively named
secret environment variables before release, selector, lifecycle, or writer
barrier mutation. These return typed `credential-migration-required` truth;
they never silently preserve or strip plaintext credentials.

An already-active upgrade is the narrow recovery exception. It may replay or
move secret-bearing selector evidence that the prior version already created
in order to terminalize its extant writer barrier. It may not admit a new
attempt or create new selector evidence. Credential migration must wait until
that recovery is terminal; blocking recovery would strand the vault write-closed.
Low-level selector repair is recovery machinery, not an ordinary publication
surface.

The read-only credential-residue inspector covers the live installation/plist,
their crash-retained temporary siblings, upgrade staging selectors, the active
upgrade, and every immutable history selector copy. Stable direct-file reads,
closed generated-plist parsing, bounded inventories, private modes, journal
hashes, and before/after rescans yield only `clean`, path-free variable-name
`residue`, or `indeterminate`; runtime process state is explicitly unknown.
`cleanupHomeCredentialResidue` is the one preview/apply Module for the exact
legacy Anthropic variable. Apply requires the literal destructive
authorization, verified shipped-provider readiness, and decrypting Keychain
checks before mutation and before resume. The existing supervised lifecycle
Module carries the exact `credential-cleanup` purpose; its old two-purpose
SQLite layout remains readable and writable for backup/upgrade. It widens
atomically only after lifecycle ownership proves the journal inactive and
immediately before the first credential-cleanup owner is published; denied
mutation against an active legacy row leaves both row and schema untouched.

Within lifecycle ownership cleanup re-inspects, refuses every active upgrade,
and sanitizes the installation selector before deriving and publishing its
plist. Installation-only and wholly absent live selections additionally
re-prove launchd, foreground readiness, legacy Serve, and Product Host
ownership after lifecycle admission; an absent pair skips live publication and
may still prune transient/history residue, while plist-only state is invalid.
The selected content-addressed release is strictly verified and
cross-bound before changed resume evidence is authorized. Exact transient
files and abandoned staging roots are tombstoned and removed; contaminated
terminal history is never rewritten, only atomically tombstoned and pruned so
existing receipts expire naturally. Operation-bound tombstones remain visible
to the inspector as transient residue after crashes. Final two-pass inspection
must be clean; cleanup truth remains distinct from Home resume truth.
Callback failures are fixed tagged outcomes: a successfully resumed Home is
reported ready/stopped even when cleanup failed before mutation, while a
failed/deferred resume reports recovery-required. Clean-plus-recovery is
returned only when cleanup itself completed and fresh inspection proves it.

Runtime never falls back to legacy plaintext residue, and locked, unavailable,
or denied Keychain access stays explicit. Transcription migration and Keychain
orphan collection remain deferred.

### P5 installed Chromium acceptance checkpoint

The artifact builder's existing installed N-1→N gate now deepens its exact
`ready-success` scenario with one browser journey before candidate publication.
`scripts/home-pwa-chromium-acceptance.ts` drives the installed system Google Chrome stable channel
through `playwright-core`; it does not download a browser, open a persistent
profile, or create trace, HAR, video, screenshot, or storage-state evidence.
The page may reach only the installed loopback Home origin.

The journey mints a read/capture grant through the exact candidate CLI, pairs
through the shipped PWA, and checks validated Connection details. It waits for
service-worker control, reloads offline, proves authenticated readiness is not
served from cache, saves and exports one pending text capture, revokes the
browser device, and reconnects into explicit auth repair with the queue still
present. A fresh grant re-pairs the same ephemeral context; replay removes the
queue only after the vault contains the canary exactly once with a capture
identity. Failure diagnostics expose only the fixed journey phase, never
pairing codes, browser internals, filesystem paths, or captured text.

This gate is installed-artifact Chromium evidence, not installability or
cross-browser evidence. Manifest icons, Chrome install UI, screen-reader and
visual acceptance, real-device iOS Safari, signed/notarized distribution, and
clean-consumer-Mac execution remain separate owner gates; update replacement
is implemented separately by P5.6 and is not evidence from this checkpoint. See
[[cohesive/runbooks/2026-07-home-pwa-acceptance]].

### P5.4 install identity checkpoint

The checked-in PWA now has one canonical charcoal-and-sage SVG identity and
tracked 64, 192, 512, maskable 512, and Apple touch 180 PNG derivatives.
The shell advertises the SVG plus the existing 64px PNG as its raster fallback
and deliberately ships no ICO: installed Chrome reliably decodes the PNG under
the acceptance route boundary that rejected the generated ICO container.
`@vite-pwa/assets-generator@1.0.2` is an explicit regeneration command, not a
runtime or ordinary-build dependency. Maskable and Apple pixels are opaque and
full-bleed; the manifest gives `/` a stable id and uses separate explicit
`any` and `maskable` purposes. The shell carries dark and Apple standalone
metadata.

Only those exact root assets are public. They are no-cache, all enter the
static-only Workbox precache exactly once, and the artifact rehearsal checks
the exact manifest/head inventory, MIME types, nonempty bytes, and PNG sizes.
The installed Chrome journey additionally decodes each advertised and manifest
icon before pairing.

This is checked-in and artifact-gated identity evidence, not a claim about the
Chrome install UI or real-device iOS rendering. Accessibility, safe-area and
dynamic-type acceptance, visual review, signed distribution, and clean-consumer
execution remain owner-window gates; automated update replacement is the
separate P5.6 checkpoint.

### P5.5a portable functional closure checkpoint

Activity is immutable adopted evidence. The host walks the current branch's
adopted ref rather than working-tree `HEAD`; a branch without an adopted ref
has an empty feed. Every entry includes the exact newest-change commit from
that adopted ancestry. With `access.read`, its row opens the existing source
reader at that path and commit; otherwise it is non-interactive. Newer
unadopted commits must not affect `/recents` rows, titles, or source revisions.

Today task completion owns a per-task pending, success, or failure lifecycle.
Pending settlement is visibly disabled and cannot be submitted twice. Success
uses one polite status announcement before normal Today refresh removes the
task. Failure persists as an alert with explicit Retry for the same task; the
App refresh must not add a second acknowledgement.

Evidence for this checkpoint is limited to portable surface, HTTP, and
component tests. Adaptive Chrome coverage continues in P5.5b and the exact
artifact-bound installed Activity/settlement journey in P5.5c; screen-reader,
safe-area/dynamic-type, visual-regression, and real-iPhone evidence remain
owner-window work.

### P5.5b adaptive accessibility checkpoint

Source and capture modals share one local focus Module: initial focus, cyclic
Tab/Shift-Tab, Escape handling, and final-unmount restoration. Capture
recording, transcription, review/filing, and saved states expose named modal or
atomic status semantics without streaming-token live chatter. Four safe-area
axes, `100%`→`svh`→`dvh` sizing, dynamic dialog caps, 44px enabled controls and
coarse targets, visible focus, contrast floors, narrow wrapping, and complete
reduced-motion suppression are one CSS contract. Inline `.wl` prose links are
the deliberate text-link exception to the coarse-target minimum.

After readiness, the existing installed system-Chrome gate checks 320×568,
390×844, and 844×390 for no horizontal document overflow, enabled visible
controls/coarse targets of at least 44×44, critical controls inside the
viewport, a visible keyboard focus ring, and disabled computed motion. It
resets to 390×844 before
the remaining offline/auth/replay journey and preserves existing deadlines,
emergency cleanup, and artifact-free browser policy.

This implements the artifact-bound gate; fresh exact Chrome evidence requires
executing it against a candidate artifact.

This does not prove real-iPhone portrait/landscape/notch or software-keyboard
behavior, Dynamic Type/200% zoom, VoiceOver, or Safari touch/microphone flows;
those remain owner-hardware evidence. Waiting-worker N→N+1 replacement is the
separate P5.6 gate, not evidence from this checkpoint. The exact installed Activity/settlement journey is not added
by this checkpoint.

### P5.5c installed functional closure checkpoint

The `ready-success` artifact rehearsal prepares one deterministic knowledge
page under `notes/` through an ordinary owner-attributed Git commit. Its task
already carries a stable block anchor and an authenticated Home-local
due-today date. Before Chrome starts, the host waits until `/recents` binds
that page to the exact human commit and `/tasks` exposes the exact interactive
task from adopted truth.

`scripts/home-installed-functional-closure.ts` is the production evidence
Module for this checkpoint. Its narrow boundary is vault path, abortable Git,
and authenticated `/tasks`/`/recents` reads; it owns the bounded preparation,
H/S ancestry, Git attribution, and exactly-once Markdown proofs independently
of the Chromium adapter.

The existing installed Chrome journey then opens that Activity row, requires
the exact path, short commit, and recognizable source bytes, closes by Escape,
and proves focus returned to the row. Its device grant is exactly
`read,capture,resolve`. One completion click must return an exact successful
`dome.settle/v1` receipt whose commit is passed to the bounded host callback.
The callback waits for daemon adoption and proves exactly that one later source-changing commit:
author `dome settle <dome-settle@local>`, one `Dome-Request` trailer and no
`Dome-Run`, the exact source and daily paths, one closed anchored line, and one
Done-today backlink. Chrome reloads and requires the task to be absent before
continuing the pre-existing offline/auth/replay phases.

Portable component tests, rather than this installed gate, own the transient
pending/success UI states: the normal refresh may remove the row before a
success frame is observable.

This is an implemented artifact gate, not fresh installed evidence. Portable
tests cover canary shape plus phase ordering, failure, and cleanup and remain
explicitly non-evidence. Fresh evidence requires executing the candidate
artifact rehearsal. This checkpoint does not claim real iPhone/Safari,
VoiceOver, Dynamic Type/zoom, software-keyboard/safe-area behavior, visual
regression, signed distribution, or a clean consumer Mac. Waiting-worker
N→N+1 replacement is implemented separately by P5.6, not claimed by P5.5c.

### P5.6 waiting-worker update checkpoint

The installed `ready-success` path now runs a second, deliberately isolated
Chrome journey after the existing paired functional journey. Its only input is
the exact extracted candidate static root at `app/pwa/dist`. It loads a closed,
bounded, contained inventory, rejects symlinks and non-files, and retains all
bytes in private copied maps. It starts no Home, creates no second paired
device, and proxies no API: `/readyz` is an ordinary static 404 at the same
ephemeral `127.0.0.1` origin as the PWA.

Generation N is synthetic and in memory. The runner inserts exactly
`<meta name="dome-rehearsal-generation" content="synthetic-predecessor">`
before the candidate index head closure, first proves the candidate
`index.html` MD5 equals its singular generated `sw.js` precache revision, and
then replaces only that revision with the synthetic index MD5. Every other
file is byte-identical to N+1, and both index and worker must differ. One
atomic gateway pointer publication changes N to the exact extracted candidate.

An ephemeral installed system Chrome stable context has no persistent profile,
trace, HAR, video, screenshot, download, or storage-state artifact and rejects
all cross-origin requests. A fixed non-secret `dome_csrf` cookie admits the
limited shell while static `/readyz` fails. Chrome waits for N control and its
DOM marker, saves one unique text capture through the UI, and records the exact
single `dome-pwa/captures` IndexedDB row. After N+1 publication and explicit
`registration.update()`, the gate requires the visible update prompt, a
non-null waiting worker, the old active controller, and the still-marked N DOM
before confirmation. `Update now` must produce `controllerchange` plus reload,
remove the marker, leave no waiting worker, and return browser-fetched index
and worker SHA-256 values equal to the extracted candidate. The same capture
id, text, timestamp, local state, and zero attempts must remain; cleanup removes
it through the UI and proves the object store empty.

This checkpoint claims only prompt-mode N→N+1 activation and survival of that
one local IndexedDB row. It does not claim replay to Home, engine or vault
persistence, logical-capture idempotency, API compatibility, Chrome install
UI, background update policy, multi-tab behavior, real iPhone/Safari, signed
distribution, or clean-consumer execution. Pure generation, request-policy,
phase, timeout-settlement, and cleanup tests are portable non-evidence; fresh
artifact evidence requires executing the installed rehearsal.

### P6 managed-release collection checkpoint 1

`src/product-host/managed-release-gc.ts` is the one host-wide managed-release
reachability Module. Its single dormant interface acquires a kernel-backed
SQLite coordinator keyed by the canonical direct Home root outside that
managed root, inventories every direct
`installations/<vault-service-slug>/installation.json`, and protects both the
selected release and the old/candidate sides of every extant active upgrade.
Terminal history and derived receipts do not pin releases. Selected evidence
binds artifact id and product version; active evidence additionally binds the
manifest hash. Inventory uses the authoritative upgrade disposition parser but
does not require the referenced vault directory to remain mounted.

The coordinator persists at
`<dirname(Home)>/.dome-home-release-store/<sha256(canonical-Home)>.db`. Its
closed row binds the exact Home root. The directory is direct, owned, and 0700;
the database is direct, single-linked, owned, and 0600, with its inode held and
re-proved through open, acquisition, and release. First creation fsyncs the
coordinator directory and the parent entry that names it. All Home, coordinator
directory, and database release proofs run after both successful and throwing
owner callbacks; callback and proof failures are preserved together. Every
open replays coordinator-directory and parent durability, so a retry after a
post-rename fsync failure cannot bless a merely visible database entry. SQLite uses
DELETE/NORMAL/FULL and one `BEGIN IMMEDIATE` transaction for ownership, so
process death releases the kernel mutex. Collector acquisition is always
zero-wait; checkpoint 3 retains that behavior for the sole manual foreground
surface. Invalid,
linked, ambiguous, or nonempty unknown evidence is never repaired, recreated,
or age-broken. `inspect` does not mutate the managed release or selector
stores, but its first call intentionally initializes this persistent sibling
coordinator; it is therefore not a filesystem-byte-pure observation.

The releases inventory is closed. Only exact 64-hex verified release
directories and exact publication, repair, quarantine, or GC debris names are
understood; near misses, redirects, special entries, malformed selectors,
unknown installation entries, and missing protected payloads fail the whole
operation closed. Exact installation-record publication temporaries are known
non-pinning evidence and must still be private direct files.

Collection fully verifies each release payload once while building the initial
plan. Before every candidate it cheaply rescans exact references plus the
closed release names, directory identities, and the candidate's stable
canonical manifest fingerprint; it never repeats all payload verification per
candidate. It holds and re-proves the Home,
`releases/`, and `installations/` directory identities, requires the candidate
on the release-store device, publishes a unique `.gc-*` tombstone with atomic
no-replace directory publication, fsyncs the parent, proves the source absent
and the tombstone inode unchanged, recursively removes it, and fsyncs again.
Recognized tombstones make a crash after publication idempotently collectible.

Checkpoint 1 is deliberately not exported by `@marktoda/dome`, called by the CLI,
or scheduled. A collector holds only the global lock and must never acquire or
wait for an earlier lock. Production collection remains forbidden until every
reachability-changing writer participates as described below.

### P6 managed-release collection checkpoint 2A

The coordinator now validates and holds the exact absolute, normalized,
canonical, direct, owned Home root in addition to its sibling database. Its
owner callback receives one opaque live token bound to that exact root; forged,
expired, or cross-root tokens fail at runtime. Release writers expose owned
implementations that require the token, then acquire only their artifact-keyed
lock. Async lock-rank context rejects nested global acquisition and any
artifact-to-global reversal. The global lock hierarchy is **lifecycle →
operational → [host when applicable] → global → artifact**. Ordinary install
does not own a Product Host lock; its concrete span is **lifecycle →
operational → global → artifact → durable selector**, where the selector is a
write phase rather than another mutex rank.

`publishManagedHomeInstallation` is the one deep ordinary-install publication
interface. After lifecycle and operational ownership are already held, it
establishes and canonicalizes Home, acquires global ownership, publishes or
converges the immutable release under artifact ownership, and retains global
ownership until `installation.json` is durably published. It releases global
before plist publication, launchd bootstrap, or readiness. The same-artifact
reinstall takes the identical span; idempotence does not weaken reachability
serialization. On first install, every missing direct directory is created one
component at a time to the first existing canonical ancestor, fsyncing the new
directory and then the parent entry that names it. Home is durable relative to
its parent before coordination; `releases/`, `installations/`, and the
vault-selector directory become durable in dependency order before their
payload or selector is reported durable. Establishment replays both fsyncs for
an already-visible requested directory, so retry converges after failure at
either durability step instead of assuming the prior attempt completed. A
structural source inventory pins
all imports, exports, and mentions of coordinator, owned/convenience writers,
raw/deep selector publication, owner tokens, and rank helpers to exact reviewed
modules.

The collector remains dormant with no CLI or automatic caller. Checkpoint 2A
does **not** activate collection; upgrade and retirement integration is the next
checkpoint.

### P6 managed-release collection checkpoint 2B

Upgrade reachability writers now share the global coordinator without exposing
its owner token outside Product Host internals. The new-candidate deep
interface `prepareHomeUpgradeCandidate` runs under lifecycle Tx2, the
operational barrier, and Product Host ownership; it acquires global, publishes
or converges the candidate under artifact ownership, then retains global until
the active journal has been atomically published, its upgrade parent fsynced,
and the exact journal re-read. Global is released before migration, probation,
selector commit, activation, or readiness. The raw `prepareHomeUpgrade` test
seam also holds global through the same active proof and has no production
caller. Recovery of an existing journal skips fresh candidate preparation.

Irreversible committed repair follows lifecycle → operational → Product Host →
global → artifact. It repairs or converges the exact invoking release and
re-proves the unchanged durable active journal before releasing global.
Selector convergence and strict forward proof then continue outside global;
the active journal protects old and candidate reachability throughout.
Selector commit and restore likewise remain global-free because neither
removes active protection.

Terminal retirement follows lifecycle → operational SHARED → global. Summary
and receipt derivation can finish before global while active still pins both
releases. Under global, retirement performs a final local durable terminal
reproof, atomically renames active into intrinsic history, re-proves the
archived identity and summary, fsyncs history before upgrade, and only then
releases global. It performs no network readiness probe while global is held.
If a process dies after rename but before either parent fsync, the kernel mutex
is released; therefore every later collector first stabilizes each visible
upgrade namespace exactly once under global—history fsync and reproof, then
upgrade fsync and reproof—before initial reachability inventory. Failed
stabilization aborts before active evidence is read. This pass is linear in
installations and is not repeated by per-candidate cheap rescans.

Crash-window tests interleave the dormant collector at durable active readback
and after preparation returns, during committed repair, and at every retirement
durability seam. They pin
zero-wait contention through the final reachability proof, release before
global-free work, post-process-death namespace convergence, and idempotent
retirement after collection. Exact structural inventories keep owned writers,
candidate and raw preparation, retirement, and the collector on reviewed
modules only.

The collector remains deliberately dormant: there is still no CLI, scheduler,
SDK export, or automatic caller. Checkpoint 2B makes later activation eligible
only after lifecycle, operational, Product Host, and global ownership have all
been released; activation policy and scheduling remain a separate reviewed
checkpoint.

### P6 managed-release collection checkpoint 3 — manual activation

`dome home cleanup [--apply] [--json]` is the sole production Adapter over the
host-wide cleanup interface. It derives the standard managed Home root through
the same `homeInstallationRoot` helper used by installation and never performs
vault discovery, requires a live vault, or accepts a vault or arbitrary Home
root. Either inherited placement of `--vault` is a fixed usage error. An absent
standard Home root is a successful `not-installed` no-op.

The default is zero-wait inspection. It acquires global ownership, stabilizes
upgrade namespaces, verifies the entire closed release-store inventory, and
reports protected release and unreachable entry counts without removing
anything. Destructive collection requires explicit `--apply`, which performs a
fresh inventory rather than applying a prior report; there is no force, hidden
wait, or automatic fallback. A successful apply is all-or-throw at the public
seam: the raw removed candidates must be the exact ordered plan candidate objects, so
`status: removed` implies `candidateCount === removedCount` and every sanitized
listed candidate was removed. A crash or exception after any removal returns
unknown completion with all counts and candidate evidence `null`; the next
action is a fresh non-apply inspection, whose tombstone protocol converges the
store.

The stable `dome.home.cleanup/v1` document exposes only mode, fixed status and
reason enums, exit code, counts, next action, and candidates shaped as artifact
id, verified version (or `null` for debris), and kind. It never exposes Home or
release paths, internal entry names, installation slugs, PIDs, UUIDs, device or
inode identities, manifest hashes, or caught exceptions. Human output shortens
artifact ids and prints versions, kinds, counts, and an explicit `--apply` or
re-inspection instruction. Successful inspection—including candidates—and
successful apply/no-op exit `0`; coordinator contention is fixed temporary exit
`75`; fail-closed verification or unknown completion exits `1`; vault scope is
usage exit `64`.

The structural source inventory permits the high-level manual cleanup interface
in exactly its Product Host Module and thin lazy CLI Adapter. The raw detailed
collector remains Module-internal in production, and there is still no SDK
export, daemon, scheduler, serve, HTTP, MCP, upgrade, or retirement caller.
Automatic activation remains deferred until Dome has an explicit retention or
disk-pressure policy, execution budget, contention policy, and operational
telemetry.

### P6 managed-release collection checkpoint 4 — post-retirement advisory

The upgrade intent adds one optional manual-maintenance hint only after
`retireHomeUpgrade` has completely returned. At that point retirement has
released lifecycle, operational, and global ownership. The private
`withPostRetirementCleanupAdvisory` helper is pure result decoration: it cannot
inventory, coordinate, or remove a release. It preserves every
`dome.home.upgrade/v1` key plus the existing status and exit code, appends one
fixed count-free message, and changes the otherwise-empty next action to
`run-home-cleanup`. The CLI renders that token as the exact command
`dome home cleanup`.

Only healthy committed outcomes receive the hint: a fresh `upgraded` result,
or recovered `already-current` after this invocation retired its committed
journal. Ordinary already-current results did not retire anything. Restored
transactions receive no cleanup advice; final rolled-back outcomes keep
`candidate-failed` so the failed artifact remains available for postmortem.
Rerun, recovery, unhealthy, busy, preflight, selection, and
retirement-finalization results retain their higher-priority next action and
unchanged message.

The advice is unconditional and makes no candidate or count claim. Retirement
may unpin an old release, but another vault selector may still protect it. Only
the later explicit manual command can determine reachability. Automatically
calling even inspect mode was rejected: it is linear in every installation and
release, fully verifies each payload, stabilizes and fsyncs upgrade namespaces,
takes global ownership, and may initialize coordinator state. That cost must
not lengthen a completed foreground upgrade merely to conditionally print a
hint.

Structural source inventories continue to keep `manageHomeReleaseCleanup` in
the manual CLI Adapter and its Product Host Module only, and keep the raw
collector Module-local in production. The upgrade Module additionally fences
both cleanup symbols, the cleanup module import, and either apply mode. There
is still no automatic inspection or deletion caller, scheduler, daemon, HTTP,
MCP, or SDK export.

### P6 owner beta evidence checkpoint

The local beta measurement protocol is
`dome.home.beta-protocol/2026-07-15.1`. One manually authored
`dome.home.beta-evidence/v1` packet records one opted-in run against one public
macOS distribution receipt. The only adapter is
`bun scripts/home-beta-evidence.ts`: `validate` accepts one explicit packet and
`aggregate` accepts 5–100 explicit packet inputs. Both require the trusted
public `--expected-version` and `--expected-receipt` values; packet strings are
matched exactly and never become reflected release truth. It reads bounded local JSON
and prints JSON; it has no template command, output writer, product call,
network call, database, configuration, log, telemetry, SDK export, or automatic
caller.

Two earned product controls remain independent of this removable evidence
Adapter. The PWA always exposes `Refresh Today` whenever the shell is visible;
it performs only the runtime-validated Today request, retains prior data on
failure, and announces loading plus fresh or failed terminal state without
waiting for Activity or Ask. Its live-status node is a sibling of the busy
Refresh button, so loading and terminal announcements are never suppressed by
an `aria-busy` ancestor. It remains usable during Ask streaming. The managed
launch Adapter owns the verified `runtime/Dome Home` executable alias and
exact `Dome Home` argv0 described above. Neither
control calls, imports, records, or publishes beta evidence; deleting this
script leaves both controls intact.

Every packet has exactly these twelve timed step keys, in protocol order:

1. `install`
2. `vault-start`
3. `pair`
4. `concurrent-use`
5. `mutation-admission`
6. `external-edit`
7. `restart-reconciliation`
8. `offline-replay`
9. `revoke-isolation`
10. `backup-upgrade-rollback`
11. `blank-host-restore`
12. `projection-rebuild-audit`

All durations are elapsed milliseconds from the owner's monotonic clock. A timed
outcome is exactly `ok`, `timeout`, `failed`, or `not-run`. `ok`, `timeout`,
and `failed` carry the observed non-negative integer duration to success,
timeout, or terminal failure; `not-run` carries `null`. Failure and omission
remain valid evidence and make the packet nonqualifying rather than making its
shape invalid. A `timeout` duration is exactly its protocol budget; the budgets
terminate collection and are not latency SLOs.

The authenticated readiness predicate is exact: the current UI has
runtime-validated a fresh `dome.product.readiness/v1` document for the expected
product version, the current device and vault session; `host.state` is `ready`,
`writesAdmitted` is true, `adoption.state` is `current`, and the device has the
capability required by the observed action. Stale Connection context, a pairing
document, liveness, or a document from a prior request is never terminal
evidence.

Install-to-paired-Ask starts immediately before the owner opens the signed DMG
and ends when the paired PWA satisfies authenticated readiness and renders the
first complete, non-stale Ask response; its budget is 900,000 ms. Active-read
collection is exactly twenty sequential owner rounds, preserving round order.
In each round the desktop starts one Ask. While that same Ask visibly reports
active generation, the paired phone activates the always-visible `Refresh
Today` control and waits for the persistent status to render exactly `Today is
fresh.` or the visible Today failure terminal. Its 30,000 ms clock starts at
button activation. Next, while the same desktop Ask is still visibly
generating, the phone activates one existing Activity/citation source-opening
control for a preselected exact adopted SourceRef and waits for SourceViewer's
accessible `Source loaded` or `Source failed to load` terminal; that 30,000 ms
clock starts at source-control activation. A request whose activation begins
after Ask stops visibly generating is recorded `not-run`. The owner then lets
that Ask finish before starting the next round. Thus the arrays remain exactly
twenty ordered Today and twenty ordered source observations—one pair per Ask,
not forty unawaited requests—with no post-hoc selection. Collection uses only
the installed UI: no automation, developer tools, direct API, or script caller.
The two fixed capture cases are `online` and
`offline-replay`; each starts one monotonic clock at the capture action and
records `start-to-local`, `start-to-commit`, and `start-to-adopt`, plus lost and
duplicate logical-capture counts. Their terminal events are respectively the
durable local-queue row, the attributable committed receipt, and the same
logical capture visible at the current adopted commit. Their budgets are
10,000, 120,000, and 180,000 ms. Completed capture clocks are monotonic
across those three milestones. Those two `start-to-adopt` observations are the
protocol's sole adoption-latency samples; no separately selected adoption
sample is accepted. Restart has one owner-observable
`mid-operation-reconcile` outcome. Exactly one Home is running. While the UI
visibly shows a mediated mutation pending, the owner starts the clock, opens
Activity Monitor, selects the exact process named `Dome Home`, and chooses
Force Quit. launchd `KeepAlive` must restart it automatically; the owner must
not manually relaunch Home. The clock stops only when authenticated readiness
holds and that mutation's UI receipt has reconciled to one closed non-pending
outcome. Its budget is 300,000 ms; reaching it records `timeout` with no unsafe
fallback. A quiescent `dome home restart`, PID, launchd label, or internal
write phase is not a substitute. Internal before-ref-advance,
after-ref-advance, and checkout-repair fault injection remains installed/test
evidence and is explicitly not owner-beta input.

The three readiness clocks start immediately before initial Home launch,
quiescent restart, and restored-host launch. Each ends at the authenticated
readiness predicate above and has a 300,000 ms budget. Device timers start at
the pair/revoke/access action and end at its fresh runtime-valid UI result,
with a 120,000 ms budget. Backup/migration/rollback/restore and real
Chromium/iOS install/offline/update/accessibility timers likewise start at the
owner's named action and end at the corresponding live, runtime-valid result
(accessibility ends after the fixed live checklist); each has a 900,000 ms
budget. The twelve journey-step timers use the same owner-action/result rule
and a 900,000 ms budget.

Mutation-queue evidence is the exact integer record `scheduled`, `success`,
`timeout`, `failed`, `notRun`, `saturationEvents`, `conflictEvents`, and
`retryAttempts`; the four outcome counts must partition `scheduled`, and zero
scheduled operations is valid but nonqualifying. Device evidence has exactly
the timed keys `desktop-pair`, `phone-pair`, `phone-revoke`,
`revoked-unauthorized`, and `desktop-authorized`. Recovery has exactly
`backup`, `migration`, `rollback`, and `restore`. Each of `chromium` and `ios`
has exactly the real-client timed keys `install`, `offline`, `update`, and
`accessibility`. Any timeout, failure, or omission in these required outcomes
makes a packet nonqualifying while preserving it as evidence.

The packet binds the protocol, strict product SemVer, `darwin-arm64`, and the
expected public distribution-receipt SHA-256. It may retain only date precision
plus macOS, iOS, and Chromium major versions as raw local context. iOS or
Chromium major may be `null` only when every corresponding platform outcome is
`not-run`; a major is mandatory when any corresponding check ran. Those values,
individual rows, filenames, and every hash except the public receipt binding
are absent from aggregation output. Model and transcription cost use integer
micro-USD and the closed sources `run-ledger`, `provider-receipt`, `not-used`,
or `unavailable`; no provider or model name is recorded. Model cost must be
measured from `run-ledger` or `provider-receipt` because paired Ask and active
generation ran. Model `not-used` or `unavailable` is nonqualifying;
transcription may be `not-used`, while transcription `unavailable` is
nonqualifying.

Packets contain no packet, owner, vault, device, credential, or run identity;
no UUID, signature, wall-clock timestamp, free text, path, name, content, raw
error, provider name, or model name is accepted. Consent, external-owner truth,
and absence of developer intervention are boolean attestations: `false` is
valid evidence and nonqualifying. The validator cannot prove consent or that
five packets came from five distinct owners. The release operator verifies
those facts outside the content-free artifact.

Aggregation rejects canonically identical packets and release-binding drift,
but identical numeric measurements alone are not identity. It preserves every
outcome denominator; `attempted` excludes `not-run`, while the success-rate
denominator retains every scheduled slot. It computes nearest-rank P95 only
over pooled successful samples, and labels the maximum observed owner P95 as a
low-sample observation with no population claim. Any nonqualifying packet
produces `not-ready`. When all 5–100 packets qualify but the release operator
has not passed `--operator-reviewed`, the report is `review-required` with the
fixed `operator-review-required` blocker and `--require-ready` exits 1. Only
after the operator verifies out of band that the runs were consented, external
owner runs from five distinct owners may aggregate use `--operator-reviewed`;
then, and only then, all-qualifying evidence produces `ready`. The report stores
only the closed manual-review status and check names, never an owner or packet
identity. `validate` is aggregate-only for this review and cannot complete it.
Failures remain `not-ready` even when the operator flag is present. Latency and
cost remain reported measures with no invented SLO.

Individual counts are bounded at 1,000,000 and individual cost observations at
1,000,000,000 micro-USD so a 100-packet aggregate remains safely representable.
Input is one direct regular non-symlink file at most 64 KiB. The adapter binds
path lookup to the opened file and rejects identity, size, mtime, or ctime
drift before or during its capped nonblocking read as `input-unstable`.

### P3 device-authority foundation

`src/device-authority/` owns durable single-owner device authority behind
one deep Interface. Pairing grants bind the device name, immutable capability
set, auth epoch, expiry, attempt budget, and credential lifetime before the
code leaves the local console. Device identity and append-only credential
history are separate SQLite records; only public opaque ids, fixed-width secret
hashes, and lifecycle metadata persist. Mint, exchange, authenticate, rotate,
revoke, and epoch invalidation are serialized transactions, so two host handles
cannot both win a one-time exchange or leave multiple active credentials.

`dome devices` is the local Adapter for pair/list/rotate/revoke/invalidate-all.
The Product Host owns this store for its complete lifecycle. Its HTTP Adapter
exchanges one-time grants, authenticates each request into a device id and
scoped capability set, enforces exact Origin plus double-submit CSRF for cookie
mutations, and binds assistant sessions to their creating device. On reload the
PWA copies the non-authorizing, JavaScript-readable CSRF cookie into memory; it
does not rotate shared state or persist secrets in localStorage. Revocation,
rotation, expiry, and auth-epoch invalidation take effect on the next request.

The listener remains loopback-only. An optional canonical HTTPS
`externalOrigin` adds exactly one trusted reverse-proxy origin; an HTTP origin
is accepted only for explicit loopback Vite development. HTTPS cookies are
always `Secure`; loopback-development cookies explicitly omit it so real
browsers can use the HTTP listener. Request Host and forwarding headers never
expand authority. Static assets and pairing boot are the only unauthenticated
routes. Standalone `dome http` remains a separate compatibility Adapter with
its bearer and process-local loopback pairing.

## P0 decisions and deferrals

P0 ratifies this spec, [[wiki/concepts/client-model]], [[VISION]],
[[wiki/specs/http-surface]], and
[[wiki/matrices/pwa-product-acceptance]] as one product posture.

Deferred: shared human collaboration, tenant-aware engine state, multi-vault
host, peer sync/CRDT, generic remote Markdown editing, offline voice/chat,
public accounts/OAuth/billing, durable server chat history, and blind PWA
proposal application.
