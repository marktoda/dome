---
type: gotcha
description: "Operator surfaces (doctor checks, diagnostic repair hints) hardcode first-party bundle lists, so third-party bundles render second-class."
created: 2026-06-10
updated: 2026-06-10
sources:
  - "[[wiki/specs/sdk-surface]]"
coverage: off-matrix
enforced_at: tests/extensions/loader.test.ts
first_observed: 2026-06-10 (architecture review; loops + shared_config converted same day)
---

# Operator surfaces enumerate first-party bundles

**Symptom:** a third-party bundle's processors run, emit effects, and pass
through the broker exactly like first-party ones — but the *operator
surfaces* treat them as second-class: its diagnostics render as plain text
where `dome.markdown.*` codes get repair hints, and `dome doctor` runs no
configuration checks for it where `dome.daily`/`dome.agent`/`dome.sources`
get bespoke findings.

**Why:** the effect/capability layer is hermetic and generic, but some
cross-cutting "explain the system to the operator" surfaces were built by
enumerating the first-party bundle set instead of accepting contributions.
Each is a *shadow contribution kind* — data that behaves like a manifest
contribution but lives hardcoded in core.

## Status of each shadow kind

**Converted:**

- **Maintenance loops** *(2026-06-10)* — `manifest.yaml` `loops:` block;
  runtime composition with the core registry; status/check read the
  composed set. Cross-bundle first-party loops deliberately stay in
  `src/extensions/maintenance-loops.ts` — composition over the bundle set
  is the vault's job, not any one bundle's. See [[wiki/specs/sdk-surface]]
  §"Adding a maintenance loop".
- **Cross-bundle config keys** *(2026-06-10)* — `shared_config:` in
  `.dome/config.yaml` merges as defaults under every extension config
  (`daily_path` is the canonical case), replacing mirrored per-extension
  keys. See [[wiki/specs/vault-layout]] §"config.yaml".

- **Doctor grant-entry probes** *(2026-06-10)* — the
  `FIRST_PARTY_GRANT_ENTRY_REQUIREMENTS` table converted to a manifest
  `doctor.grantEntries:` contribution: each bundle declares its own
  probes (self-contained processor ids), the runtime composes active
  bundles' entries, and the health evaluator stays bundle-agnostic. The
  seven first-party entries live in the `dome.daily` / `dome.agent` /
  `dome.markdown` manifests.

**Deliberate core composition checks (not debt):** the
`config.daily-path-mismatch` and `config.sources-timeout-default`
findings read *across* configs (two bundles' resolved configs; an
extension config against engine config). Like the cross-bundle
maintenance loops, composition over the bundle set is the vault's job —
these stay in `src/engine/host/health.ts` by design.

**Remaining (known debt, conversion paths named):**

- **Diagnostic rendering hints** — `src/surface/diagnostic-summary.ts`
  string-matches `dome.markdown.*` codes for repair paths and
  dispositions; third-party diagnostic codes degrade to plain rendering.
  Conversion path: per-code `repair_hint` / `disposition` metadata on the
  manifest's diagnostic declarations.
- **CLI verb bindings** — `dome query` / `dome export-context` / `dome
  lint` are hardwired to `dome.search` / `dome.lint` view names. Accepted
  product curation, not debt: third-party views are reachable via
  `dome run <name>`, and first-party verbs are the product's curated
  surface.

## Mitigation

For a third-party bundle today: diagnostics and questions surface fine
(generic paths); declare a manifest loop for status/check presence; accept
plain diagnostic rendering; ship operational checks as a garden processor
emitting diagnostics rather than expecting doctor findings.

## Related

- [[wiki/specs/sdk-surface]] §"Extension bundles" — the six real
  contribution kinds.
- [[wiki/matrices/extension-bundle-shape]] — per-bundle contribution map.
- [[wiki/linters/surface-adapters-dont-import-adapters]] — the sibling
  direction fence for protocol adapters.
