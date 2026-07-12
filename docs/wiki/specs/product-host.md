---
type: spec
created: 2026-07-11
updated: 2026-07-11
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
  contractVersions: readonly string[];
  assetVersion: string;
  vault: { id: string; name: string };
  device: { id: string; name: string; capabilities: readonly string[] };
  host: { state: "starting" | "ready" | "degraded" | "blocked"; since: string };
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
not merely an HTTP listener. Model/transcription degradation does not block
Today, text capture, owner decisions, document reads, or lexical recall.

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
audit. Blank-host restore and rollback restore credential records for audit but
increment the auth epoch and invalidate all credentials.

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

## P2 implementation status

The first Product Host checkpoint implements the small lifecycle Interface
(`start`, authenticated readiness, `close`), exclusive single-vault ownership,
recovery before the long-lived Vault opens, a stable opaque local vault id,
loopback pairing, and characterized operation admission. Model generation and
immutable adopted reads hold no global lease; view work is bounded; workspace
mutations and compiler ticks share one bounded FIFO lane. The HTTP Adapter can
consume the owned Vault and scheduler while standalone compatibility mode
retains open-per-request serialization.

P2 remains open until Dome-mediated settle, proposal apply, and assistant
authoring all use controlled mutation, the PWA frame is served by the product
command, and compatibility lifecycle commands delegate without a second
Product Host implementation.

## P0 decisions and deferrals

P0 ratifies this spec, [[wiki/concepts/client-model]], [[VISION]],
[[wiki/specs/http-surface]], and
[[wiki/matrices/pwa-product-acceptance]] as one product posture.

Deferred: shared human collaboration, tenant-aware engine state, multi-vault
host, peer sync/CRDT, generic remote Markdown editing, offline voice/chat,
public accounts/OAuth/billing, durable server chat history, and blind PWA
proposal application.
