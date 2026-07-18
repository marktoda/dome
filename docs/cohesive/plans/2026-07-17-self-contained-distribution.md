---
type: plan
created: 2026-07-17
updated: 2026-07-18
status: reviewed
description: "Remaining missions to make Dome a self-contained, source-checkout-free PWA product through one Bun package and one guided setup journey."
sources:
  - "[[cohesive/plans/2026-07-11-productization-modernization]]"
  - "[[cohesive/plans/2026-07-11-pwa-first-product]]"
  - "[[getting-started]]"
  - "[[wiki/specs/product-host]]"
  - "[[wiki/specs/vault-layout]]"
---

# Self-contained distribution and setup

## Decision and scope

The next product milestone is not another engine feature or a formal public
beta. It is a source-checkout-free path by which a technical Obsidian power
user can install Dome, safely adopt a new or existing vault, and reach the PWA
without developer intervention:

```sh
bun install -g @marktoda/dome
dome setup
```

`@marktoda/dome` is one product package. It contains the SDK, CLI, built PWA,
and complete Dome Home installation payload. There will not be a separate
bootstrap package, SDK package, or second installer architecture.

The globally installed package is the source of an installation, not the
long-lived Home execution location. `dome setup` verifies the package payload
and delegates to the existing Home artifact and lifecycle seams, which install
an immutable, content-addressed release into Dome's stable managed release
store. `launchd` runs that managed release. A later Bun global update therefore
cannot silently change the bytes of a running Home.

This plan narrows the remaining distribution and onboarding work in
[[cohesive/plans/2026-07-11-productization-modernization]] and P4/P6 of
[[cohesive/plans/2026-07-11-pwa-first-product]]. It supersedes exactly one
distribution decision in the latter plan: the npm package is no longer an
SDK-only release gate kept separate from the end-user artifact. The one npm
package now carries the install-ready Home payload. This plan does not
supersede either prior plan's engine, host-authority, upgrade, recovery,
backup, PWA, or acceptance contracts.

## Baseline: what is already shipped

The remaining work should compose the product that exists rather than rebuild
it. The repository already has:

- the sealed Vault, Proposal, Processor, and Effect engine, with one
  capability-checked mutation path;
- conservative `dome init` behavior for new and existing Git-backed vaults;
- a built PWA with Today, Capture, Ask, Activity, source reading, Connection,
  and Backlog Review;
- the one-owner/one-vault Dome Home host, per-device pairing, readiness, and
  supervised macOS lifecycle;
- immutable managed Home releases, upgrade probation, rollback and recovery,
  release cleanup, encrypted backup, and blank-host restore;
- a self-contained Apple Silicon Home artifact with a pinned runtime,
  production dependencies, PWA, manifest, and checksums;
- an installed-product acceptance gate using system Chrome;
- optional model-provider setup currently exposed through the lower-level
  `dome home setup` command; and
- a packed-package rehearsal for the current SDK/CLI payload.

The current gap is the front door. The package is still named `@dome/sdk`, its
published file inventory is not the complete Home product payload, the root
`dome setup` journey does not exist, the repository has no committed MIT
license file, and no public package has been published. Source-built artifacts
remain the only supported installation path.

## Final owner journey

The intended first-run sequence is:

```text
install one package
  -> run dome setup
  -> choose a new or existing vault
  -> inspect a read-only assessment and exact change preview
  -> consent to scaffold/adaptation and, if needed, Git initialization
  -> install the verified Home payload into the managed release store
  -> start Home and open Today
  -> pair the browser
  -> make the first text Capture
  -> optionally configure a model provider
  -> optionally configure Calendar or Slack later
```

The user reaches useful Today and Capture behavior without a model. Ask,
generated briefs, semantic gardening, and other model-backed behavior report
that their optional provider is unavailable until configured; they do not make
the whole product look broken.

For an existing vault, setup adapts to what is present. It applies only
high-confidence, additive Dome scaffolding after preview and asks about genuine
conflicts. It does not reorganize folders, rewrite notes, close tasks, import
fake content, or infer a new information architecture. For a new vault, it
creates a minimal orientation, configuration, and useful empty-state structure
without demo notes.

## Product principles

1. **One package, one Home.** Registry installation and managed Home
   activation are stages of one product journey, not competing distribution
   systems.
2. **Preview before authority.** Read-only discovery precedes Git
   initialization, baseline commits, vault scaffolding, service installation,
   credential changes, and integration enablement.
3. **Package bytes are not runtime state.** Home runs from a verified immutable
   release selected by the existing installation record.
4. **Existing vaults are owner material.** Ambiguity produces a question or a
   no-op, never a clever migration.
5. **Models are an enhancement.** Deterministic local behavior and recovery
   remain available without model credentials or network access.
6. **No setup state machine.** Setup composes idempotent discovery, init,
   artifact, lifecycle, readiness, and browser-opening Modules. Existing Git,
   installation, and Home records remain the durable authorities.
7. **A failed step keeps evidence.** Every failure identifies the last durable
   boundary, preserves owner content, and prints one safe retry or recovery
   command.
8. **One onboarding grammar.** `dome setup` and its subcommands are the only
   public setup language. Existing `dome home setup` behavior becomes a hidden
   or compatibility implementation route, not a second concept users must
   learn.

## Execution roadmap

Each mission is a useful checkpoint and should land only after its own tests,
review, and documentation are complete. A later mission may refine a public
surface, but it must not be required to make an earlier checkpoint truthful.

### Progress ledger

| Mission | Status | Release evidence |
| --- | --- | --- |
| M0 — Restore trustworthy CI | **Complete** | Validated implementation SHA `d9efcf53`; GitHub Actions run `29624132748`, attempts 1 and 2 both succeeded. |
| M1 — Public package and legal identity | **Complete** | Main implementation commit `286b872c` (parent `c44ff0d3`); packed-package and fresh-consumer rehearsal passed without publication. |
| M2 — Complete packed product input | **In progress** | Extend the now-truthful package with the install-ready Home payload. |
| M3–M12 | Planned | Intent and gates remain as specified below. |

### M0 — Restore trustworthy CI

**Outcome:** `main` is a reliable signal before distribution changes begin.

Work:

1. Move the GitHub test job to the `macos-15` Apple Silicon runner and assert
   `arm64`; `macos-14` is entering deprecation and is no longer the product
   host to stabilize.
2. Pin CI to Bun `1.2.13`, the runtime used by the current release evidence,
   instead of allowing `bun-version: latest` to change behavior without a
   repository commit.
3. Run `bun run test` at the repository root. Its typed orchestrator discovers
   every current `tests/**/*.test.ts` file, sorts the inventory, assigns each
   file exactly once to the ordered scripts, harness, product, or runtime area,
   and runs every file in its own fresh Bun process. Hosted run 29617625950
   showed that one 4,001-test process accumulated enough scheduler and SQLite
   pressure for late tests to exceed their own bounds even though every failure
   passed in isolation. Hosted run 29618942932 then showed that four area-sized
   processes remained too coarse: after 120 runtime files, unrelated home
   lifecycle and serve-cleanup tests cascaded. Per-file process ownership is the
   smallest uniform isolation seam and replaces both measured failure modes
   without retries, global timeout changes, allowlists, or coverage loss. The
   four areas remain progress groupings, not isolation boundaries. Each file
   owns a private POSIX process group: normal direct exit, timeout, and owner
   interruption all retire the full group before the runner advances, even
   when a wrapper exits before its descendants. POSIX exposes only a numeric
   process-group id rather than a handle-bound group capability, so the runner
   signals immediately at the ownership boundary, treats `ESRCH` as terminal,
   and never signals that id again after observing retirement; this is the
   narrow conventional defense against identifier reuse without adding
   platform FFI to the test gate. Do not use bare recursive `bun test`, which
   also crosses into nested packages.
4. Run `bun run check:pwa` as its own explicit gate, alongside typecheck and
   the root tests, so the PWA remains required without conflating test roots.
   Keep one macOS job with named attributable steps unless measured latency or
   isolation needs earn a split.
5. Repair the four verified drift classes exposed by the correctly scoped
   suite: add the `task-backlog` CLI spec route and harness scenario together;
   route both `settle.ts` `localeCompare` sites through the deterministic-sort
   fence; and register the read-only `task-backlog` maintenance-loop exemption.
   These are real product/substrate corrections, not runner noise.
6. Change README and contributor guidance to the canonical scoped root command,
   `bun run test`, so local guidance, package scripts, and CI exercise the same
   exhaustive per-file plan.

Acceptance gate:

- the `macos-15`/arm64 workflow passes twice on the same commit, including a
  clean rerun, under Bun `1.2.13`;
- typecheck, `check:pwa`, and `bun run test` are named, separately
  attributable required steps in the same job;
- the root runner proves a lossless, duplicate-free inventory and a deliberate
  failing test stops at its named file rather than producing a late
  cross-suite resource cascade;
- the CI and artifact toolchain versions are explicit and reviewable; and
- no test is disabled merely to make `main` green.

Non-goal: changing test semantics, adding retries or global timeout inflation,
or broadening the platform matrix.

Checkpoint: a release-truth checkpoint after a fresh independent review. Keep
the genuine drift repair distinct from the workflow/toolchain correction when
two commits make that evidence clearer; neither commit disables coverage.

Completion evidence (evidence SHA `d9efcf53`):

- GitHub Actions run `29624132748` passed on attempts 1 and 2 on
  `macos-15`/arm64 with Bun `1.2.13`.
- The separately attributable typecheck, exhaustive root test, and PWA gates
  passed. The root runner discovered and executed all 435 root test files in
  isolated per-file Bun processes.
- The final hardening pass kept the scenario catalog metadata-only while
  collecting all 140 scenarios, accepted legal base64url request IDs
  (including credential-derived IDs), consolidated redundant status-command
  fixture lifecycles, placed the real concurrent Home-upgrade test watchdog
  beyond its product-owned 30-second coordinator wait at 35 seconds, and
  merged exact plus fuzzy Today-loop folding coverage into one scenario
  lifecycle.

### M1 — Establish the public package and legal identity

**Outcome:** the repository has one truthful package identity ready for local
release rehearsal.

Work:

1. Commit the selected MIT license and align package and README metadata.
2. Rename the package from `@dome/sdk` to `@marktoda/dome` while preserving the
   current root, `./cli`, and `./mcp` exports under the new package name.
3. Update source fences, tests, generated examples, and documentation that
   intentionally name the package. Do not preserve an unpublished
   `@dome/sdk` compatibility package.
4. Declare the portable runtime expectation with `engines.bun`. Put Home's
   macOS/Apple-Silicon/Git/browser requirements in a package-owned product-
   support contract checked by `dome setup`; do not use top-level npm `os` or
   `cpu` metadata to make otherwise portable SDK imports uninstallable.
5. Check registry name availability without publishing. A 404/unpublished
   result proves only that no public version resolves; it does not prove scope
   ownership, organization access, or publish authority.

Acceptance gate:

- a fresh consumer can import the SDK and companion exports from the packed
  `@marktoda/dome` tarball;
- the tarball exposes exactly one `dome` executable;
- no normative documentation teaches `@dome/sdk`; and
- license metadata and the committed license text agree.

Migration safety: this is a pre-publication rename. Existing vaults and Home
installation records must not depend on the npm package name and therefore
must open unchanged.

Approval boundary: registry reservation, publication, tags, and GitHub release
creation remain external actions requiring explicit owner approval.

Completion evidence (main implementation commit `286b872c`, parent
`c44ff0d3`):

- `@marktoda/dome` `0.3.9` carries the MIT license, root/`./cli`/`./mcp`
  exports, one `dome` executable, and a Bun range of `>=1.2.13 <2`.
- The 11 focused tests and all TypeScript checks passed. Run independently,
  the PWA gate passed 173 tests and its production build.
- Release rehearsal packed `marktoda-dome-0.3.9.tgz` with 436 entries,
  1,172,321 packed bytes, and 4,496,533 unpacked bytes. A fresh consumer
  passed root, CLI, and MCP imports, CLI help, scaffold, and reopen checks.
- Registry inspection returned E404/unpublished and npm was unauthenticated.
  No package publication, tag, or GitHub release was performed.

### M2 — Make the packed tarball a complete product input

**Outcome:** an exact npm tarball contains everything `dome setup` needs; no
source checkout or in-place PWA build is required.

The initial simplicity tradeoff is accepted explicitly: today's Home artifact
is approximately 36 MB archived and 125 MB expanded. Carrying it in one package
is larger than an SDK-only package, but it removes the bootstrap/package split
and makes the installed bytes auditable. Measure registry limits, install time,
and cache behavior during rehearsal. Split platform payloads or optional
downloads remain deferred until real distribution evidence justifies that
complexity.

Work:

1. Extend the package build so it emits and inventories the production PWA and
   a prebuilt, install-ready Home payload alongside the SDK, CLI, extensions,
   providers, source handlers, contracts, and required native/runtime inputs.
2. Make the prepack path deterministic: clean checkout in, one closed tarball
   inventory and hashes out. Generated payloads must not depend on untracked
   local files.
3. Reuse the existing Home artifact builder at package-production time and its
   manifest verifier at setup time. Add only the narrow adapter needed to
   install the prebuilt artifact from package resources; the consumer machine
   does not rebuild Home.
4. Install the tarball into an isolated Bun global prefix and prove the
   executable and all exports work after the repository directory is made
   unavailable.
5. Fail packaging on omitted runtime content, unexpected secrets, absolute
   paths, mutable development dependencies, or non-reproducible generated
   output.

Implementation checkpoint 2 now concentrates steps 1–3 and the packaging
parts of step 5 behind one complete-product assembler. It directly stages
bounded blobs from a captured clean commit, invokes the existing Home build
once, binds the verified Home build commit and PWA inventory to that same
source, and closes exact checksummed inventories in the shipped pure
`dome.product-package/v1` parser. The build-only path runs `npm pack` against
private staging and uses fixed `tar@7.5.19` to stream-verify every actual tgz
member twice without extraction before inode-bound exclusive publication.
The portable test seam cannot issue release evidence; the
production adapter hardwires all three trusted implementations. Checkpoint 3
implements step 4 as `dome.packed-product-rehearsal/v2`. A private clean clone
produces the exact package; fresh Bun global package/bin/cache and HOME/XDG
roots receive it through a production-only, scripts-disabled copyfile install.
The producer clone, package output, tarball, install cache, and producer
HOME/XDG state are then removed and proved absent before declared imports, the
direct global CLI, the closed installed PWA inventory, and strict Home
materialization run under a neutral working directory and dead-proxy execution
environment. The real rehearsal is wired once as a pinned Apple-Silicon CI
job; the progress ledger remains in progress until that hosted evidence
succeeds on the implementation commit.

Acceptance gate:

- `bun install -g <exact-packed-tarball>` succeeds in a clean prefix;
- `dome --help`, declared imports, PWA inventory verification, and Home payload
  verification work with no checkout or product build;
- package contents are closed by a reviewed allowlist and checksum manifest;
  and
- the packed-product rehearsal runs in CI.

Non-goal: publishing to npm or replacing the existing Home artifact format.

### M3 — Build a read-only setup assessment and plan

**Outcome:** `dome setup` can explain exactly what it would do before changing
the vault or host.

Work:

1. Add the root guided `dome setup` command as the sole public onboarding
   grammar. Model and integration setup later become its subcommands; existing
   `dome home setup` routes remain hidden/compatibility adapters.
2. Discover prerequisites, current package/artifact identity, existing Home
   ownership, vault path, Git state, Dome state, configuration, and obvious
   conflicts through pure inspection first.
3. Classify the vault into a closed set: new path, empty directory, existing
   non-Git vault, existing Git vault, existing Dome vault, incompatible active
   operation, or unsafe/ambiguous state.
4. Center the seam on a recomputed, revision-bound `VaultAssessment`, not a
   persisted setup record. Conceptually it carries the vault kind, Git `HEAD`
   when present, a deterministic worktree fingerprint, tracked and untracked
   Markdown inventory plus proposed content scope, Dome/Home classification, a
   closed additive `AdaptationAction` union, and blockers. Keep this shape
   narrow enough that assessment policy can evolve behind it.
5. Compile one versioned setup plan containing intended writes, commits,
   service actions, optional steps, recovery commands, and warnings. Human
   rendering and JSON consume the same plan.
6. Offer an explicit `--dry-run`; interactive setup presents the same plan and
   asks only for choices that materially change the outcome.
7. Immediately before apply, recompute the assessment and revalidate `HEAD`
   plus the worktree fingerprint. Refuse a stale plan and show a fresh diff;
   never apply actions inferred from an earlier vault state.

Acceptance gate:

- assessment performs no writes, credential reads, service changes, model
  calls, or network calls;
- every supported classification has an exact fixture and JSON snapshot;
- rerunning assessment against the same bytes returns the same plan; and
- changing a tracked or untracked file, `HEAD`, ignore rule, symlink, or Home
  selector after preview makes apply refuse stale and recompute;
- dirty worktrees, merge/rebase state, active upgrades, conflicting Home
  ownership, symlink ambiguity, and unsupported hosts fail closed with one
  next action.

Non-goal: a generic installer framework, setup database, or workflow engine.

### M4 — Canonicalize the vault content scope

**Outcome:** setup and every applicable processor agree on which owner
Markdown belongs to Dome's compiled knowledge universe before any existing
vault is adapted.

Today the product has a real policy split: Today, tasks, claims, and brief
behavior hard-code `wiki/` plus `notes/`, while search, graph, and lint cover
`**/*.md`. That can make a file searchable but absent from daily reasoning, or
make setup appear to adopt a vault that core workflows only partially see.
Distribution would amplify that inconsistency across arbitrary vault layouts.

Work:

1. Define one versioned content-scope contract with include and exclude globs,
   canonical path normalization, engine/private exclusions, and deterministic
   matching. Feature-specific selectors may narrow that universe, but no
   processor silently broadens it.
2. Put matching and scoped enumeration behind one deep policy Module. Today,
   tasks, claims, brief inputs, search, graph, lint, garden, and every other
   applicable owner-Markdown enumerator consume it rather than owning literal
   root lists.
3. During read-only setup assessment, inventory Markdown locations and propose
   include/exclude globs that fit the observed vault. Show covered files,
   excluded files, and material changes to tasks, claims, Today, brief, search,
   and graph. Never move files to satisfy a scope.
4. For a new vault, choose the minimal scaffold's scope directly. For an
   existing vault, require explicit acceptance of the proposed scope whenever
   unifying the current behavior changes derived results.
5. Commit the accepted policy as ordinary vault configuration and rebuild only
   rebuildable projections. Preserve Markdown, operational state, answers,
   receipts, run history, and external-action state.

Acceptance gate:

- the same path corpus produces the same in/out decision for every applicable
  processor and surface;
- no applicable first-party processor hard-codes `wiki/`, `notes/`, or
  `**/*.md` as an independent content-universe policy;
- setup previews exact counts and representative source evidence for each
  candidate scope without reading excluded sensitive content into output;
- changing scope moves no file and writes no owner Markdown; and
- an existing Dome vault cannot acquire a broader task or brief universe
  without an explicit reviewed configuration commit.

Migration safety: content scope changes derived visibility, not source truth.
The previous configuration and Git commit are the rollback boundary; a rebuild
must reproduce either policy deterministically.

Non-goal: inventing a universal page taxonomy, forcing `wiki/`/`notes/`, or
teaching setup to reorganize an Obsidian vault.

### M5 — Safely initialize or adapt the vault

**Outcome:** after consent, setup creates the minimum viable Dome vault or
adds only safe missing scaffolding to an existing vault.

Work:

1. Factor the existing init/adaptation logic behind one idempotent interface
   consumed by both `dome init` and `dome setup`.
2. For a new vault, create the minimal directories, config, AGENTS.md
   orientation, Git repository, and baseline commit without fake people,
   projects, meetings, tasks, or notes.
3. For an existing non-Git vault, inventory the proposed repository boundary
   and tracked set before initialization. Preview sensitive-name candidates,
   large files, ignored paths, nested repositories, symlinks, and links that
   escape the vault. Never follow an external symlink or assume every
   pre-existing file belongs in Git.
4. Show the exact proposed `.gitignore`, Dome additions, content-scope policy,
   and baseline tracked inventory. Only after explicit consent initialize Git,
   stage the approved set, and create the attributable baseline commit.
   Sensitive, large, ignored, ambiguous, or explicitly declined files remain
   untouched and uncommitted until the owner decides otherwise.
5. For an existing Git vault, preserve branch, remotes, ignore rules, owner
   files, and history. Add only missing high-confidence scaffolding. Surface
   conflicts for explicit resolution rather than overwriting them.
6. Make interruption and rerun converge: no duplicate blocks, anchors,
   commits, configuration, or initialization records.

Acceptance gate:

- byte-for-byte owner content is unchanged after new, non-Git, Git, and
  already-Dome fixtures complete setup;
- the first baseline commit and exact tracked inventory are previewed,
  consented, and attributable;
- ignored, sensitive-name, large-file, nested-repository, and internal/external
  symlink fixtures each fail closed or remain explicitly untracked;
- dirty existing Git work is never folded into an implicit setup commit;
- a fault injected after each durable boundary can be retried safely; and
- `dome check` can open and explain the resulting vault before Home starts.

Migration safety: setup never reorganizes an existing vault, invents a page
type for owner content, closes a task, resolves a conflict, enables an external
source, or installs a model credential on inference alone.

### M6 — Activate Home from the package payload

**Outcome:** the setup journey installs and starts the exact packaged Home in
the existing managed lifecycle.

Work:

1. Verify and materialize the packaged Home payload through the existing
   artifact boundary.
2. Delegate installation to the existing content-addressed managed release,
   per-vault installation record, and LaunchAgent lifecycle. Do not point
   `launchd` at Bun's global package directory.
3. Treat an identical existing release/install as success; treat a different
   installed release as an explicit upgrade choice handled by the existing
   upgrade transaction.
4. Wait for schema-valid readiness and render one recovery card when the host,
   pairing, vault, or dependency state is degraded.
5. Prove that deleting or updating the global package after activation cannot
   alter the running release bytes.

Acceptance gate:

- setup works from any current working directory with no checkout;
- installed selectors, manifest, release bytes, LaunchAgent, executable
  identity, and readiness all bind to the same artifact id and version;
- duplicate hosts and legacy foreground conflicts remain refused;
- a failed install leaves the previous Home or no Home, never a half-selected
  release; and
- existing backup, upgrade, rollback, restore, and uninstall tests remain
  unchanged or become stricter.

Non-goal: a second release store, daemon, installer receipt, or rollback
protocol.

### M7 — Deliver first value before optional setup

**Outcome:** a completed setup opens a useful PWA journey immediately.

Work:

1. Open the loopback Home/PWA URL only after readiness, using the existing
   pairing authority and without printing reusable secrets into logs.
2. Land on Today with an honest useful state. Existing vaults compile their
   current commitments and context; new empty vaults get a clear first-Capture
   action rather than demo data.
3. Guide one text Capture through local queue, send, exact receipt, and adopted
   resurfacing where applicable.
4. Keep deterministic Today, source browsing, Capture, Connection, and recovery
   usable when no model is configured.
5. Present model configuration as a skippable enhancement after core success.

Acceptance gate:

- the clean installed journey reaches Today and one Capture without a model,
  network service, manual YAML edit, source checkout, or PWA build;
- model-dependent surfaces explain their unavailable state without a global
  failure banner;
- refresh/restart preserves the vault, capture truth, pairing truth, and Home
  selection; and
- both a minimal new vault and a representative existing Obsidian vault pass
  the journey.

### M8 — Compress update, diagnosis, and removal into one lifecycle

**Outcome:** package installation and Home activation have an understandable
ongoing lifecycle.

Work:

1. Define the two explicit update stages: Bun obtains a newer
   `@marktoda/dome` package; Dome verifies and activates that package's Home
   payload through the existing transactional upgrade path.
2. Provide concise public routes for status, update, repair, backup, and
   uninstall that delegate to existing `dome home ...` operations. Keep
   advanced recovery commands available under technical disclosure rather
   than duplicating their behavior.
3. Make `dome setup` idempotently resume or repair an existing install and
   point at the correct lifecycle command when an upgrade/recovery is already
   active.
4. Preserve current uninstall semantics: stop/remove the supervised service
   while retaining the vault, operational state, installation record, and
   managed releases unless a separately previewed destructive cleanup is
   explicitly requested.
5. Render package version, active Home version, available payload version, and
   vault identity as separate truths.

Acceptance gate:

- N to N+1 activation uses the shipped backup/probation/rollback gate and
  retains the frozen N-1 evidence;
- interrupted install, update, rollback, and uninstall each have one tested
  retry path;
- downgrades are refused unless an existing recovery contract explicitly
  permits them; and
- no command mistakes “global package updated” for “running Home updated.”

Non-goal: automatic background package updates or silent Home activation.

### M9 — Add optional intelligence and integrations after the core journey

**Outcome:** users can deepen Dome without making credentials or external
sources a prerequisite for local value.

Work:

1. Expose optional model-provider configuration as `dome setup model` (or an
   equivalently clear `dome setup` subcommand) after the first successful
   Capture. It delegates to the existing `dome home setup` implementation,
   which becomes hidden/compatibility grammar. Preserve Keychain isolation and
   provider readiness truth.
2. Explain which features become available with a model: Ask, generated
   morning briefs, model ingestion, and semantic garden proposals.
3. Offer Calendar and Slack under the same `dome setup` grammar as separate,
   default-off post-setup recipes with explicit data scope, command/provider
   requirements, capability grants, test action, and removal path.
4. Never enable an external source because the relevant application or token
   happens to exist on the machine.

Acceptance gate:

- skipping every optional step leaves setup complete and healthy;
- adding/removing model configuration needs no Home reinstall and exposes no
  secret to the Bun host or logs;
- each source integration has a consented sample fetch and truthful degraded
  state; and
- Calendar/Slack failures cannot block Today, local Capture, backup, update,
  or uninstall.

Non-goal: adding providers, hosted accounts, OAuth, or an integration
marketplace during distribution work.

### M10 — Rehearse the exact release candidate

**Outcome:** the bytes intended for npm survive the complete source-less
product journey on a clean supported Mac.

Work:

1. Pack the exact versioned tarball that would be published and bind the
   package hash to the Home artifact, PWA, installed-product evidence, and
   source commit.
2. Run the global-install journey for new, existing Git, existing non-Git, and
   already-Dome vault fixtures.
3. Exercise setup interruption, no-model operation, pairing, first Capture,
   update/rollback from the retained predecessor, backup/blank-host restore,
   and non-destructive uninstall.
4. Run the PWA installed-Chrome gate and the manual owner-hardware checks that
   are possible without a paid Apple identity.
5. Update README and getting-started from the exact candidate commands and
   observed outputs.

Acceptance gate:

- a clean Apple Silicon Mac with Bun, Git, and Chrome needs no clone, compiler,
  manual PWA build, or repository-relative path;
- the packed-tarball checksum, installed Home artifact id, and evidence packet
  agree;
- no absolute path, credential, vault content, or private release evidence is
  present in the public tarball; and
- all portable and installed-product gates pass against the same candidate.

Signing boundary: because there is no Apple Developer ID, this milestone is an
unsigned and unnotarized Apple Silicon technical preview. It must say so
plainly, preserve macOS security behavior, and never instruct users to disable
Gatekeeper or remove quarantine. Signed DMG distribution remains deferred
until the owner obtains an appropriate Apple identity.

### M11 — Publish only after explicit owner approval

**Outcome:** the rehearsed tarball becomes the first public
`@marktoda/dome` package without changing bytes after approval.

Pre-approval packet:

- exact package name, version, tag, visibility, commit, tarball hash, size, and
  file inventory;
- MIT license and public README;
- CI, packed-product, installed-product, migration, backup/restore, and
  security evidence;
- known limitations: Apple Silicon macOS, technical power users, one owner,
  one vault per Home, separately configured private networking, Anthropic as
  the shipped model provider, and unsigned/unnotarized preview; and
- rollback/deprecation procedure for a bad registry release.

Approval boundary: `npm publish`, registry provenance/signing actions, Git tag,
GitHub release, public announcement, and any change to repository visibility
must not occur without explicit owner approval. After approval, publish the
already-rehearsed tarball rather than rebuilding it.

Acceptance gate:

- `bun install -g @marktoda/dome` resolves the approved version on a clean
  machine;
- its package hash matches the approved rehearsal;
- `dome setup` completes the no-checkout first-value journey; and
- a registry rollback can prevent new installs without pretending already
  installed managed Home releases changed.

### M12 — Friend-scale self-serve validation

**Outcome:** three to five technical friends or coworkers can use the public
repository/package instructions without live developer intervention.

Work:

1. Give each user the README, supported-host requirements, and a bounded
   recovery/contact route; do not conduct a sales-style beta program.
2. Include both from-scratch and existing-vault users. Existing-vault evidence
   must record only structure/classification outcomes, never private content.
3. Record setup completion, time to Today, time to first Capture, optional
   provider completion, recovery commands used, and whether the user could
   resume after interruption.
4. Convert recurring failures into deeper assessment, setup, lifecycle, or
   documentation behavior. Do not create a second onboarding path for one
   user's local workaround.

Exit gate:

- all users reach Today and Capture without a source checkout;
- at least one new vault and one existing vault complete setup;
- no owner content is lost, silently rewritten, or ambiguously committed;
- every encountered setup failure has one truthful recovery route; and
- the findings identify whether the next product mission is onboarding polish,
  broader host support, or renewed P6 appliance evidence.

Non-goal: growth, telemetry collection without consent, multi-owner
collaboration, or a hosted service.

## Cross-cutting release gates

Every mission that changes installation or first-run behavior must preserve:

- one owner, one vault, one supervised Home process, and many paired clients;
- Markdown/Git authority and the adopted-ref contract;
- a single capability-checked mutation path;
- no long-lived execution from Bun's mutable global package location;
- manifest-bound package, artifact, runtime, PWA, and evidence identities;
- preview-before-write behavior and byte-preserving existing-vault adaptation;
- idempotent reruns and crash recovery at every durable boundary;
- useful local operation without a model or external integration;
- path-free, secret-free public diagnostics and receipts;
- backup before schema-changing upgrade and exact N-1 rollback evidence;
- uninstall that preserves owner data by default; and
- a clean source-less installed-product journey on the supported host.

The root release command should aggregate these gates. A narrower test may
improve iteration speed, but no narrower green result is a release claim.

## Explicit deferrals

Do not add these while executing M0–M11:

- a bootstrap package, separate end-user installer package, or parallel Home
  release store;
- a setup database, generic setup workflow/state-machine framework, or new
  engine primitive;
- automatic folder reorganization or semantic migration of existing vaults;
- fake sample notes, people, projects, meetings, or tasks;
- required model credentials, Calendar access, or Slack access;
- automatic package updates or silent Home activation;
- Intel macOS, Linux, Windows, native mobile wrappers, or public-internet
  hosting;
- multiple owners, multiple vaults per Home, tenant concepts, accounts,
  billing, OAuth, or collaboration;
- Apple signing/notarization before a Developer ID exists; and
- embeddings, reranking, another model layer, or new garden intelligence
  without the evidence required by the prior plans.

## Commit and review discipline

Each mission lands as one or more small commits with a coherent user-visible
claim. Before merging a checkpoint:

1. capture the failing or absent journey;
2. update the narrow normative contract;
3. implement behind an existing deep Module where possible;
4. run targeted, root, package, and installed-product gates proportional to
   the claim;
5. have a fresh reviewer pressure-test complexity, migration safety, and
   failure truth;
6. exercise the representative vault fixture without private-content output;
   and
7. record what shipped, what remains, and the exact next mission.

Delete superseded internal paths instead of retaining parallel setup or
installer behavior. Compatibility is valuable at public and durable-state
boundaries; it is not a reason to keep two internal product models.

## Recommended immediate sequence

Execute M0 through M7 in order. M0 restores the signal; M1–M2 make the exact
package real; M3 compiles the read-only setup plan; M4 gives arbitrary vault
layouts one coherent content universe; M5 establishes the conservative vault
and Git boundary; M6 activates the already-built appliance; and M7 proves the
first useful loop. At that point a source-less internal candidate exists and
can be dogfooded before lifecycle compression, optional integrations, and
public publication work continue.

The first owner-visible checkpoint is not “package published.” It is:

> From an exact locally packed `@marktoda/dome` tarball, a clean Apple Silicon
> Mac can safely adopt a new or existing vault, open Today, and file one text
> Capture without a source checkout or model credential.
