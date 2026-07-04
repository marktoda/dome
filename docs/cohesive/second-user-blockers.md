---
type: ledger
tags: [v1, ws6, second-user, onboarding]
created: 2026-06-12
status: accumulating
sources:
  - "[[cohesive/brainstorms/2026-06-11-dome-v1-plan]]"
  - "[[cohesive/runbooks/2026-06-server-migration]]"
  - "[[superpowers/plans/2026-06-11-v1-chunk1-server-capture-cockpit]]"
  - "[[superpowers/plans/2026-06-11-v1-chunk3a-index-projection-git-log]]"
  - "[[superpowers/plans/2026-06-12-v1-chunk3b-core-activation-resilience]]"
  - "[[superpowers/plans/2026-06-12-v1-chunk4-sources-slack]]"
---

# Second-user blockers ledger

The WS6 input artifact promised by the v1 plan ([[cohesive/brainstorms/2026-06-11-dome-v1-plan]] §Scope decision, §WS6): every "a second user would hit this" hazard recorded one line at a time as WS1–5 land. Burning this list down is the v1 exit gate — one person who is not the owner installs Dome (`dome init` → daemon → capture → first morning brief) using only the docs.

**Convention:** one line per hazard, with a source pointer. Append as new hazards surface; strike through (with a pointer to the fix) when burned down. Don't editorialize entries after the fact — this is an accumulating ledger, not a synthesis.

## Install & distribution

- No versioned release artifact: install = clone the repo + `bun install`; updates = `git pull` + manual `dome restart`, and merged code reaches a running daemon only after that restart — an unplanned restart mid-migration can load new processors against an unmigrated vault ([[cohesive/runbooks/2026-06-server-migration]] §Chunk 3a WARNING). *Status: accepted for v1 — stated plainly in [[getting-started]] §1; a release artifact is post-v1.*
- The HTTP surface has no `dome install` story: a hand-written `dome-http.service` systemd unit with a hand-plumbed `DOME_HTTP_TOKEN` (chunk1 plan Task 10 "Server migration runbook"; [[cohesive/runbooks/2026-06-server-migration]] §3). *Status: accepted for v1 — the manual unit stays; [[getting-started]] §9 points at the runbook.*
- ~~`loginctl enable-linger $USER` is a manual Linux prerequisite for user services surviving logout — deliberately not automated by `dome install` (chunk1 plan Tasks 2/10; runbook §1).~~ Documented (chunk9): [[getting-started]] §3 states the prerequisite plainly in the daemon-install step; the installer also prints the note on Linux.
- ~~`dome recipe ios --url` needs a hand-supplied server address; nothing discovers or validates it (chunk1 plan Task 8).~~ Validation fixed (chunk8 Task 5): `--url` must parse as an http(s) URL or the command exits 64 with a corrective message ([[wiki/specs/cli]] §"`dome recipe`"); the address stays hand-supplied by design (no discovery inside a Tailscale trust domain).
- ~~A vault inheriting global GPG commit signing breaks non-interactive engine/fetch commits — first seen in the 2026-06-02 LLM smoke (vault inherited signing and failed before Dome ran; [[cohesive/reviews/2026-06-02-v1-work-vault-dogfood-ledger]] §operational result); the sources spec treats gpg failure only as a retryable "did not commit" ([[wiki/specs/sources]] §command owns the write). A second user with `commit.gpgsign=true` hits this on day one.~~ Fixed (chunk8, commit 5ec79e6): the shipped fetch templates — the only shelling `git commit` paths; engine/capture commits go through isomorphic-git and never invoke gpg — now commit with `git -c commit.gpgsign=false`, and `dome doctor` raises a `git.commit-signing` info finding when the vault's effective `commit.gpgsign` resolves true.

## Configuration footguns

- ~~`dome init --with-source` / `--with-model-provider` rewrites `.dome/config.yaml` through YAML parse/stringify, which **deletes every hand-written comment** in the file (runbook §Chunk 4 step 2 LOUD WARNING).~~ Fixed (chunk8, commit b681311): all three config ensure-paths edit through the yaml Document API (parseDocument → targeted node edits → stringify), so hand-written comments and formatting on untouched nodes survive ([[wiki/specs/cli]] §"`dome init`"); one caveat — an inline comment trailing a block-collection key is repositioned onto the next line, never deleted.
- ~~Per-processor default grants do NOT propagate to a vault whose config carries a user-owned `processors:`/grant block — every new shipped processor arrives capability-denied or silently inert until the grant is hand-added (runbook §Chunk 3b step 1, §Chunk 4 step 3; chunk3b plan Task 4).~~ Fixed two ways: fresh vaults now ship the `grants: standard` preset that expands to every enabled first-party bundle's shipped defaults at load time (product-review-3 Task 18); and `dome init --refresh-config` now merges each bundle's load-bearing `doctor.grantEntries` into a LEGACY ENUMERATED vault's grant blocks — the exact grants the `capability.grant-entry-missing` probe names — so a new shipped processor no longer arrives starved (product-review-3 Task 20; [[wiki/specs/cli]] §"`dome init`"). The doctor probes stay as detection + the recovery path for grants outside the first-party set.
- ~~Grant-scoped snapshot misses are silent: manifest capability ∩ vault grant returning null produces no diagnostic, so a starving processor just never acts — this is how the owner's calendar weave was silently ungranted for weeks (runbook §Chunk 4 pre-check: "fetch-works ≠ weave-works").~~ Fixed (chunk8, commit 3a78809): `dome doctor` now derives a representative concrete path from every loaded processor's manifest-declared pattern and reports zero-intersection effective grants as `capability.grant-starved` info findings — a starving processor is no longer silent.
- ~~`index_categories` config REPLACES the defaults rather than merging, so adding one category requires re-listing all of them; defaults hardcode the `wiki/entities|concepts|syntheses` layout and a differently-shaped vault drops pages from the rendered catalog (chunk3a plan Task 4; runbook §Chunk 3a step 4).~~ Fixed (chunk8 Task 4): a non-empty map now merges over the defaults, a prefix mapped to `false` removes that default, and explicit `{}` still disables rendering ([[wiki/specs/vault-layout]] §index; `render-index.ts` config resolver).

## Daemon-host environment dependencies

- The claude-calendar/claude-slack fetch templates require a `claude` CLI install, auth, and the relevant MCP connection **on the daemon host, as the service user** — none of which travels with a vault clone; after a server migration this is a whole separate setup step (chunk4 plan Task 5; runbook §Chunk 4 step 5).
- ~~The consent surface for source fetches is a shell script the user must read and edit (`.dome/bin/fetch-*.sh` runs headless Claude *as them*) — workable for the owner, embarrassing as a second user's first-week task (chunk4 plan Task 1; [[wiki/specs/sources]] slack stance).~~ Documented (chunk9): [[getting-started]] §2 states the consent stance at init time — stanzas ship `enabled: false`, the script runs headless Claude as you, read it before flipping the flag; the daemon-host `claude` CLI requirement is stated alongside. The surface itself stays a shell script for v1.

## Security posture to document

- ~~The cockpit token rides in a query parameter (`/today?token=…`), visible in URLs and server logs — acceptable only inside a loopback/Tailscale trust domain, and a second user must be told that boundary explicitly before exposing the port (chunk1 plan Task 7 design note).~~ Documented (chunk9): [[getting-started]] §8 states the query-param boundary explicitly — bearer token, loopback/Tailscale-class network only, never a public interface.
- The network surfaces (`dome http`, future remote `dome mcp`) authenticate with a **single shared static bearer token**, not per-device tokens — the v1 plan floated "per-device issuance/rotation from day one" but v1 ships the one shared secret (rotation = edit the env + restart, invalidating every device at once). *Status: OPEN, accepted for v1 — the multi-device driver (remote MCP) is deferred, so a shared secret inside the loopback/Tailscale trust domain is the actual contract; per-device issuance/rotation lands with or before remote MCP. Recorded normatively at [[wiki/specs/http-surface]] §"One shared bearer token (the v1 contract)" (chunk10 Task 3).*

## Manual operator surgery

- The index/log migration for pre-existing vaults is an operator-run script tuned to the owner's vault (expected counts, two named divergent pages picked by hand) plus a hand-`git mv` log freeze — a second user adopting an existing vault has no generic path (chunk3a plan Task 12; runbook §Chunk 3a steps 2–7). *Status: accepted for v1 — the v1 gate is a fresh `dome init` vault; a generic migration path is post-v1.*
- Re-eligibility of an escalated (poison) sweep pair = the owner hand-deletes the `escalated` ledger row; documented-by-spec manual file surgery (chunk3b plan Task 6 deliberate cut). *Status: accepted for v1 — deliberate cut, normative in [[wiki/specs/sweep]]; [[getting-started]] §9 routes surgery to the runbook/ledger rather than restating.*
- ~~core.md personalization requires the owner to run the `dome recipe core-seed` interview and paste it into a foreground session — fine, but it must appear in the install docs or the brief stays generic (chunk3b plan Task 2).~~ Documented (chunk9): [[getting-started]] §6 is the core-seed step, with the why ("without this the brief stays generic") and the foreground signal contract alongside.

## Resolved

- ~~`dome install` was launchd-only~~ — Linux systemd --user backend shipped behind the same verbs (`src/cli/commands/install-systemd.ts`; chunk1).
