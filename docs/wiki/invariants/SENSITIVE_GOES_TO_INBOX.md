---
type: invariant
created: 2026-05-25
updated: 2026-05-25
sources: ["[[raw/original-architecture]]", "[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
tier: opt-in
---

# SENSITIVE_GOES_TO_INBOX

**Tier:** Opt-in. Not active by default. Enabled per-vault via `.dome/config.yaml`:

```yaml
invariants:
  SENSITIVE_GOES_TO_INBOX:
    enabled: true
```

Most relevant for personal vaults (especially manager / executive vaults) containing notes about identifiable people. Project-design vaults, research bibliographies, and writing-craft vaults typically leave it disabled.

**Statement:** When enabled, content classified as sensitive — performance, compensation, HR, legal, health, interpersonal conflict, personal beliefs about identifiable people — routes through `writeDocument` to `inbox/review/`, not to a wiki page. The `sensitivity-classify` workflow (shipped opt-in) is responsible for the classification step; the invariant is the structural gate that enforces the routing.

**Why:** A second brain that silently writes interpretive judgments to people-pages corrupts trust. Users must review sensitive interpretations before they enter the wiki. This invariant is the structural bulwark for the trust principle in [[wiki/concepts/brain-companion]].

**Structural enforcement:** When the invariant is enabled, `writeDocument` consumes `opts.sensitivity_classified: 'normal' | 'sensitive'` (see [[wiki/specs/sdk-surface]] §"Tool signatures" for the canonical input shape). When `sensitive` AND the target path is under `wiki/`, the Tool refuses with `kind: 'sensitive-must-route-to-inbox'`. The agent retries with the target rewritten to `inbox/review/<file>.md`. When the invariant is disabled, the field is ignored.

The `sensitivity-classify` workflow runs the classification *before* `writeDocument` is called — as a sub-workflow inside `ingest` when this invariant is enabled. The combination of (sub-workflow + invariant) is what makes the sensitivity routing structural; activating only one of the two is not enough.

**Activation checklist:**

To turn the feature on in a personal vault:

1. Set `invariants.SENSITIVE_GOES_TO_INBOX.enabled: true` in `.dome/config.yaml`.
2. Override the `ingest` workflow prompt (or use the SDK's enabled-variant) so it runs the `sensitivity-classify` sub-workflow against extracted content before any `writeDocument` to `wiki/`.
3. Create the `inbox/review/` destination directory.

`dome doctor` reports if the invariant is enabled but the `ingest` workflow doesn't run sensitivity classification (or vice versa), so partial activation is detected.

**Counter-example (when enabled):** Agent processes a voice note expressing concern about a report's performance. Without this invariant, the agent might write the concern directly into the person's entity page. With this invariant, the sensitivity-classify sub-workflow flags the content; the agent's `writeDocument` call against the entity page (with `opts.sensitivity_classified: 'sensitive'`) refuses; the agent retries with the target rewritten to `inbox/review/<file>.md`; the user resolves the item from Obsidian or via `dome doctor --show review-queue`.

**Test guarantee:** `tests/invariants/sensitive-goes-to-inbox.test.ts` — for each sensitivity category, runs a fixture conversation against a vault with the invariant enabled; asserts mentions of identifiable people in sensitive contexts route to `inbox/review/` rather than direct entity-page writes. Separate fixture verifies the invariant is correctly ignored when disabled.

**Related:**
- [[wiki/specs/sdk-surface]] §"Tool catalog"
- [[wiki/specs/prompts-and-workflows]] §"sensitivity-classify"
- [[wiki/specs/hooks]] §"Opt-in intake patterns"
- [[wiki/concepts/brain-companion]]
- [[wiki/matrices/tool-invariant-enforcement]]
