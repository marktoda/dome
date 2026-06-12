# `meta/` Generated-Surface Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move machine-owned bookkeeping files (index catalog shards, the consolidation and sweep ledgers) out of the vault root into a `meta/` directory, leaving the root holding only human/agent entry points.

**Architecture:** The root `index.md` stays at the vault root as the one-page map; the per-category shards it links to move to `meta/index-<category>.md`. The two `dome.agent` cursor ledgers change their *default* paths to `meta/…` (the existing `consolidation_ledger_path` / `sweep_ledger_path` config knobs are unchanged). Migration of existing vaults is nearly free: the render-index stale-shard retirement machinery learns to recognize legacy root-level shards and deletes them on the first run after the upgrade; ledgers are `git mv`'d by hand (they carry cursor state — there is nothing to regenerate). A key invariant to preserve: generated files stay **outside `wiki/`**, so the LLM agents' `wiki/**/*.md` write globs can never touch them by construction.

**Tech Stack:** TypeScript on Bun, `bun test`, YAML extension manifests, the Dome dogfood substrate under `docs/wiki/`.

**Worktree:** Execute in an isolated worktree per the repo convention: `git worktree add .claude/worktrees/meta-dir -b meta-dir/build`, finish with a `--no-ff` merge to `main`.

**Design decisions locked during brainstorming (do not relitigate):**
- Directory name is `meta/`. No config knob for the shard directory (YAGNI — the ledgers already have path knobs; shards get a constant).
- Root `index.md` remains at the root. Shard wikilinks in it become path-qualified: `[[meta/index-entities]]`.
- `meta/`'s *category* (per the vault-layout derivation table) stays `external` — a documented convention like `core.md`, not a new category. The spec text must carve out that `meta/` is engine-written.
- Legacy root-level `index-*.md` grant patterns stay in the manifest for one release so retirement can delete old shards in existing vaults.

---

### Task 1: Renderer emits `meta/` shard paths

**Files:**
- Modify: `assets/extensions/dome.markdown/lib/index-render.ts`
- Test: `tests/extensions/index-render.test.ts`

- [ ] **Step 1: Update the pure-renderer test expectations to the new paths**

In `tests/extensions/index-render.test.ts`, update the first test:

```ts
  test("renders a root map plus one shard per non-empty category", () => {
    const files = renderIndexFiles(entries, { shardBudgetChars: 24_000 });
    expect(Object.keys(files).sort()).toEqual([
      "index.md",
      "meta/index-concepts.md",
      "meta/index-entities.md",
    ]);
    expect(files["meta/index-entities.md"]).toContain(
      "- [[wiki/entities/alice]] — Engineer",
    );
    expect(files["index.md"]).toContain("[[meta/index-entities]]");
    expect(files["index.md"]).toContain("2"); // entity count in the root map
    // Every file's body lives inside the generated block markers.
    expect(files["index.md"]).toContain("<!-- dome.markdown:index-catalog:start -->");
    expect(files["index.md"]).toContain("<!-- dome.markdown:index-catalog:end -->");
    expect(files["meta/index-entities.md"]).toContain(
      "<!-- dome.markdown:index-catalog:start -->",
    );
    expect(files["meta/index-entities.md"]).toContain(
      "<!-- dome.markdown:index-catalog:end -->",
    );
  });
```

And the pagination test:

```ts
    const files = renderIndexFiles(many, { shardBudgetChars: 4_000 });
    expect(files["meta/index-entities.md"]).toBeDefined();
    expect(files["meta/index-entities-2.md"]).toBeDefined();
    expect(files["index.md"]).toContain("[[meta/index-entities-2]]");
```

Scan the rest of the file for any other `"index-…"` literals and qualify them with `meta/` the same way (the determinism and empty-input tests don't reference shard names and stay as-is).

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/extensions/index-render.test.ts`
Expected: FAIL — keys are still `index-concepts.md` / `index-entities.md` (no `meta/` prefix).

- [ ] **Step 3: Implement the renderer change**

In `assets/extensions/dome.markdown/lib/index-render.ts`, add the constant after the `INDEX_CATALOG_BLOCK` export (around line 31):

```ts
/**
 * Vault-relative directory for generated bookkeeping surfaces. Category
 * shards render here; the root map `index.md` stays at the vault root as
 * the entry point. Deliberately OUTSIDE wiki/ so agent write globs
 * (`wiki/**`/*.md) can never cover the renders by construction.
 */
export const META_DIR = "meta";
```

Then change the shard-name computation in `renderIndexFiles` (currently lines 63–65):

```ts
    const shardNames = pages.map((_, i) =>
      i === 0
        ? `${META_DIR}/index-${category}.md`
        : `${META_DIR}/index-${category}-${i + 1}.md`,
    );
```

No other change: the root-map summary lines already derive wikilinks from `name.replace(/\.md$/, "")`, which now yields the path-qualified `[[meta/index-entities]]` automatically. Update the file-top comment ("Key = vault-relative filename" stays true) and the module doc comment to mention `meta/`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/extensions/index-render.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add assets/extensions/dome.markdown/lib/index-render.ts tests/extensions/index-render.test.ts
git commit -m "feat(dome.markdown): render index shards under meta/"
```

---

### Task 2: Processor retires legacy root shards; manifest grants cover `meta/`

**Files:**
- Modify: `assets/extensions/dome.markdown/processors/render-index.ts:51-52`
- Modify: `assets/extensions/dome.markdown/manifest.yaml` (render-index `patch.auto` + `doctor.grantEntries`)
- Test: `tests/extensions/render-index.test.ts`

- [ ] **Step 1: Update processor test expectations and add the legacy-retirement test**

In `tests/extensions/render-index.test.ts`:

(a) In the first test (`renders root map + per-category shards…`), the expected change paths become:

```ts
    expect([...byPath.keys()].sort()).toEqual([
      "index.md",
      "meta/index-concepts.md",
      "meta/index-entities.md",
    ]);
```

and the two content lookups become `byPath.get("meta/index-entities.md")` / `byPath.get("meta/index-concepts.md")`.

(b) In `index: false frontmatter excludes the page entirely`: `changesByPath(patch).get("meta/index-entities.md")`.

(c) In `human prose outside the generated block is preserved`: the seeded prose-carrying file moves to the new location — seed key `"meta/index-entities.md"` and lookup `byPath.get("meta/index-entities.md")` (the splice-preserves-prose behavior is location-independent; testing it at the new canonical path keeps the fixture realistic).

(d) The existing `stale shards:` test keeps its root-level seeds **unchanged** — root-level `index-pure.md` / `index-projects.md` / `index-handmade.md` are exactly the legacy-shard shapes the new regex must keep retiring. Only the produced-file assertions move (none exist in that test, so it should pass untouched — verify, don't assume).

(e) Add a new test after the `stale shards:` test:

```ts
  test("legacy root shards are retired when the catalog renders under meta/", async () => {
    const effects = await runRenderIndex({
      "wiki/entities/a.md": "---\ndescription: Engineer\n---\n\n# A\n",
      // Pre-meta/ render at the old root location, entirely ours → deleted.
      "index-entities.md": `# Index — entities\n\n${START}\n- [[wiki/entities/a]] — Engineer\n${END}\n`,
      // Stale shard at the NEW location, entirely ours → deleted too.
      "meta/index-old.md": `${START}\n- [[wiki/old/x]] — Gone\n${END}\n`,
    });

    const patch = expectPatch(effects, 0);
    const byPath = changesByPath(patch);
    expect(byPath.get("index-entities.md")?.kind).toBe("delete");
    expect(byPath.get("meta/index-old.md")?.kind).toBe("delete");
    expect(byPath.get("meta/index-entities.md")?.kind).toBe("write");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/extensions/render-index.test.ts`
Expected: FAIL — produced paths lack the `meta/` prefix and `meta/index-old.md` is not scanned for retirement.

- [ ] **Step 3: Widen the shard-name pattern**

In `assets/extensions/dome.markdown/processors/render-index.ts`, replace lines 51–52:

```ts
/**
 * Generated shard names the retirement scan owns: the root map `index.md`,
 * current shards `meta/index-<category>.md` (+`-N` overflow), and LEGACY
 * root-level shards (`index-entities.md`) from before the meta/ move —
 * matched so the first post-upgrade run retires them. Anchored at ^ so
 * directory navigation pages (`wiki/entities/index.md`) never match.
 */
const SHARD_NAME_RE = /^(?:meta\/)?index(-[a-z0-9-]+)?\.md$/;
```

Update the stale-shard comment block (lines 181–186) to say "previously rendered index file (root-level legacy or under `meta/`)". Update the module-top doc comment likewise.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/extensions/render-index.test.ts`
Expected: PASS

- [ ] **Step 5: Update the manifest grants and doctor probes**

In `assets/extensions/dome.markdown/manifest.yaml`, the `dome.markdown.render-index` processor entry:

```yaml
      - kind: patch.auto
        paths: ["index.md", "index-*.md", "meta/index-*.md"]
```

(`index-*.md` is retained deliberately — retirement of legacy root shards needs delete capability over them; drop it in a later release.)

In the `doctor.grantEntries` block for `render-index`, the entries and recovery text become:

```yaml
    - processorId: dome.markdown.render-index
      entries:
        - kind: patch.auto
          target: index.md
        - kind: patch.auto
          target: meta/index-*.md
      why: >-
        the generated index projection is never written, so index.md and its
        per-category shards under meta/ go stale while agents no longer
        maintain them by hand
      recovery: >-
        Add "index.md", "index-*.md", and "meta/index-*.md" to
        extensions.dome.markdown.grant.patch.auto in .dome/config.yaml.
```

- [ ] **Step 6: Run the bundle's manifest/doctor-adjacent tests**

Run: `bun test tests/extensions/render-index.test.ts tests/harness/scenarios/cli-surface/doctor-health.scenario.test.ts tests/cli/sync.test.ts`
Expected: PASS (if the doctor scenario pins the old grant-entry targets, update its expectations to the new target list — the scenario asserts on the probe targets/recovery strings).

- [ ] **Step 7: Commit**

```bash
git add assets/extensions/dome.markdown tests/extensions/render-index.test.ts tests/harness/scenarios/cli-surface/doctor-health.scenario.test.ts
git commit -m "feat(dome.markdown): retire legacy root index shards; grant meta/index-*"
```

---

### Task 3: Invariant fence covers the new registry paths

**Files:**
- Modify: `tests/invariants/no-accreting-registries.test.ts:62-75`

- [ ] **Step 1: Extend the representative registry paths**

Replace the `REGISTRY_PATHS` list (lines ~67–73):

```ts
const REGISTRY_PATHS: ReadonlyArray<string> = Object.freeze([
  "log.md",
  "index.md",
  // Current shard locations under meta/:
  "meta/index-entities.md",
  "meta/index-concepts.md",
  "meta/index-entities-2.md",
  // Legacy root-level shard (retirement window — still reserved):
  "index-entities.md",
]);
```

Update the doc comment above it: "the root index, the meta/ category shards, an overflow shard, and a legacy root-level shard."

- [ ] **Step 2: Run the invariant suite**

Run: `bun test tests/invariants/no-accreting-registries.test.ts`
Expected: PASS — `render-index`'s `meta/index-*.md` pattern matches the meta paths but the test allowlists `dome.markdown.render-index` as the sole targeted patcher; no other first-party processor's `patch.auto` should match any of the new paths. A failure here means some other manifest grant covers `meta/index-*` — fix that manifest, not the test.

- [ ] **Step 3: Commit**

```bash
git add tests/invariants/no-accreting-registries.test.ts
git commit -m "test(invariants): pin meta/ shard paths in the registry fence"
```

---

### Task 4: Ledger defaults move to `meta/` (dome.agent)

**Files:**
- Modify: `assets/extensions/dome.agent/processors/consolidate.ts:29` (+ doc comment ~45)
- Modify: `assets/extensions/dome.agent/processors/sweep.ts:74` (+ doc comment ~100)
- Modify: `assets/extensions/dome.agent/lib/consolidate-tools.ts:28`
- Modify: `assets/extensions/dome.agent/lib/sweep-tools.ts:28`
- Modify: `assets/extensions/dome.agent/manifest.yaml:93,104,140,148,150,184,194,215`
- Tests: `tests/extensions/dome.agent/*.test.ts`, `tests/core/config-path-messages.test.ts`

The two ledgers are **cursor state, not renders** — changing the default means existing vaults must `git mv` their ledgers (Task 9); a vault that doesn't will start fresh cursors at the new path and orphan the old file. Acceptable: all live vaults are migrated in lockstep by Task 9, and the ledgers are advisory by design (worst case is re-judging already-settled work).

- [ ] **Step 1: Change the four code literals**

```ts
// consolidate.ts:29
const DEFAULT_LEDGER_PATH = "meta/consolidation-ledger.md";
// sweep.ts:74
const DEFAULT_LEDGER_PATH = "meta/sweep-ledger.md";
```

In `consolidate-tools.ts` `CONSOLIDATE_WRITABLE_PATHS`: `"consolidation-ledger.md"` → `"meta/consolidation-ledger.md"`.
In `sweep-tools.ts` `SWEEP_WRITABLE_PATHS`: `"sweep-ledger.md"` → `"meta/sweep-ledger.md"`.

Update the resolver doc comments ("defaulting to the top-level `consolidation-ledger.md`" → "defaulting to `meta/consolidation-ledger.md`", same for sweep).

- [ ] **Step 2: Update the dome.agent manifest grants**

In `assets/extensions/dome.agent/manifest.yaml`, replace every grant-path literal:
- `"consolidation-ledger.md"` → `"meta/consolidation-ledger.md"` (lines 93, 104, 140)
- `"sweep-ledger.md"` → `"meta/sweep-ledger.md"` (lines 150, 184, 194, 215)
- comment line 148: "Default path is meta/sweep-ledger.md; …"

The `sweep-tools` manifest-sync test (`tests/extensions/dome.agent/grant-aware-tools.test.ts`) pins `SWEEP_WRITABLE_PATHS` against the manifest — Steps 1+2 must land together.

- [ ] **Step 3: Run the dome.agent suite and fix fixture literals**

Run: `bun test tests/extensions/dome.agent tests/core/config-path-messages.test.ts`
Expected: failures in tests whose fixtures seed or assert the old root paths. Locate them all with:

```bash
grep -rn '"consolidation-ledger.md"\|"sweep-ledger.md"\|consolidation-ledger\.md\|sweep-ledger\.md' tests/extensions/dome.agent tests/core/config-path-messages.test.ts tests/harness/scenarios
```

Rule for each hit: fixture seeds and assertions on the **default** path become `meta/…`; fixtures that exercise the `*_ledger_path` config override keep their custom paths; fallback-message assertions ("falling back to …") become the new default string. Re-run until green.

- [ ] **Step 4: Run the prompt-regression snapshot test**

Run: `bun test tests/integration/agent-prompt-regression.test.ts`
Expected: snapshot diff mentioning only ledger paths. Inspect the failure output; if the only differences are `consolidation-ledger.md` / `sweep-ledger.md` → `meta/…`, re-run with `bun test tests/integration/agent-prompt-regression.test.ts --update-snapshots`. Any other diff is a regression — stop and investigate.

- [ ] **Step 5: Commit**

```bash
git add assets/extensions/dome.agent tests/extensions/dome.agent tests/core/config-path-messages.test.ts tests/integration tests/harness
git commit -m "feat(dome.agent): default ledger paths move under meta/"
```

---

### Task 5: SDK-level defaults — vault config template and maintenance loops

**Files:**
- Modify: `src/cli/default-vault-config.ts:147-148,161-162`
- Modify: `src/extensions/maintenance-loops.ts:559,571,604`
- Tests: `tests/extensions/maintenance-loops.test.ts`, `tests/cli/`

- [ ] **Step 1: Update the default vault config grants**

In `src/cli/default-vault-config.ts`, the dome.agent extension grant lists (read at 147–148, patch.auto at 161–162):

```ts
          "meta/consolidation-ledger.md",
          "meta/sweep-ledger.md",
```

- [ ] **Step 2: Update the maintenance-loop evidence/surface patterns**

In `src/extensions/maintenance-loops.ts`, all three `{ kind: "path", pattern: "sweep-ledger.md" }` entries (the `dome.meaning.integration` loop's evidence and surfaces, and the `dome.daily.edition` loop's evidence) become:

```ts
        { kind: "path", pattern: "meta/sweep-ledger.md" },
```

The `{ kind: "path", pattern: "index.md" }` entry at line 304 is **unchanged** — root `index.md` still exists.

- [ ] **Step 3: Run the affected suites**

Run: `bun test tests/extensions/maintenance-loops.test.ts tests/cli`
Expected: PASS, or failures only in tests pinning the old pattern strings / generated config text — update those literals the same way.

- [ ] **Step 4: Commit**

```bash
git add src/cli/default-vault-config.ts src/extensions/maintenance-loops.ts tests
git commit -m "feat(sdk): meta/ ledger paths in default vault config and loop charters"
```

---

### Task 6: Repo-wide literal sweep and full suite

**Files:** whatever the greps surface.

- [ ] **Step 1: Sweep for stragglers**

```bash
grep -rn 'consolidation-ledger\.md\|sweep-ledger\.md\|index-entities\.md\|index-\*\.md\|index-concepts\.md' src assets tests --include='*.ts' --include='*.yaml' | grep -v 'meta/' | grep -v legacy
```

Judge each hit: legacy-retirement fixtures and the retained `index-*.md` manifest pattern are intentional; anything else (init scaffolding, vault AGENTS.md templates, prompt builders, CLI help text) gets the `meta/` path. Also check `dome init` scaffolding specifically:

```bash
grep -rn 'index\.md\|ledger' src/cli/commands/init.ts 2>/dev/null || grep -rln 'init' src/cli/commands | head
```

- [ ] **Step 2: Full suite**

Run: `bun test`
Expected: PASS. Fix any straggler the sweep missed (the invariant-coverage and processor-purity fences will catch structural misses).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: sweep remaining root-level bookkeeping path literals"
```

---

### Task 7: Substrate amendments (normative docs)

**Files:**
- Modify: `docs/wiki/specs/vault-layout.md`
- Modify: `docs/wiki/specs/autonomous-agents.md:169,174,205`
- Modify: `docs/wiki/specs/sweep.md:46,137`
- Modify: `docs/wiki/invariants/NO_ACCRETING_REGISTRIES.md:19,28`
- Modify: `docs/wiki/matrices/extension-bundle-shape.md:43,47`

- [ ] **Step 1: Amend vault-layout.md**

(a) Root-listing code block: replace the `index-<category>.md` line and add `meta/`:

```
  index.md            # generated render of the wiki/ catalogue map (dome.markdown.render-index)
  meta/               # generated bookkeeping — index shards + processor ledgers (engine-written; see §"meta/")
```

(b) Add a section after §"`wiki/` — the compiled wiki" (or near the `core.md` section):

```markdown
## `meta/` — generated bookkeeping (convention)

`meta/` holds machine-owned bookkeeping files: the per-category index shards
(`meta/index-<category>.md`, `-N` suffix on overflow, rendered by
`dome.markdown.render-index`) and the dome.agent cursor ledgers
(`meta/consolidation-ledger.md`, `meta/sweep-ledger.md` — defaults; the
`*_ledger_path` config knobs still relocate them). By the category table
above `meta/*` derives `external` — like `core.md`, this is a documented
convention, not a new category, with one carve-out: unlike other external
directories, `meta/` IS engine-written, via the explicit `patch.auto` grants
each owner declares. Keeping the renders and ledgers OUTSIDE `wiki/` is
load-bearing: agent write grants are `wiki/**`-shaped, so generated surfaces
stay out of LLM blast radius by construction, not by guard code.
Root-level shards (`index-entities.md`) are the pre-meta legacy layout; the
renderer retires them on the first run after upgrade.
```

(c) Line ~195 (`core.md` section): "like `consolidation-ledger.md`" → "like `meta/consolidation-ledger.md`".

(d) Line ~531 table row: `` `index.md`, `index-*.md` `` → `` `index.md`, `meta/index-*.md` (+ legacy root `index-*.md` during retirement) ``.

(e) Line ~541 reserved-paths sentence: add `meta/index-*.md` to the reserved list.

(f) Frontmatter `updated:` → `2026-06-12`.

- [ ] **Step 2: Amend the other four docs**

- `autonomous-agents.md:169`: "(default top-level `consolidation-ledger.md`, sibling of `log.md`, outside `wiki/`)" → "(default `meta/consolidation-ledger.md`, outside `wiki/`)"; same line's "default `consolidation-ledger.md`" → "default `meta/consolidation-ledger.md`".
- `autonomous-agents.md:174,205`: ledger path literals in the grant inventories → `meta/…` forms.
- `sweep.md:46`: "(`sweep-ledger.md`, config key `sweep_ledger_path`)" → "(`meta/sweep-ledger.md`, config key `sweep_ledger_path`)".
- `sweep.md:137`: default column `sweep-ledger.md` → `meta/sweep-ledger.md`.
- `NO_ACCRETING_REGISTRIES.md:19,28`: ledger names → `meta/…`; the index-files sentence stays accurate (the render statement is location-independent) but mention shards now live under `meta/`.
- `extension-bundle-shape.md:43`: dome.markdown grant string → `patch.auto: ["**/*.md", "wiki/syntheses/*.md", "wiki/**/index.md", "index.md", "index-*.md", "meta/index-*.md"]`.
- `extension-bundle-shape.md:47`: dome.agent grant strings → `meta/consolidation-ledger.md`, `meta/sweep-ledger.md` everywhere they appear in the row.

- [ ] **Step 3: Verify the substrate self-checks pass**

Run: `bun test tests/integration`
Expected: PASS (invariant-coverage lockstep doesn't change — no invariant was added or removed).

- [ ] **Step 4: Commit**

```bash
git add docs/wiki
git commit -m "docs(specs): meta/ generated-surface convention — vault-layout amendment"
```

---

### Task 8: Merge per branch flow

- [ ] **Step 1:** `bun test` once more from the worktree root. Expected: PASS.
- [ ] **Step 2:** From the main checkout: `git merge --no-ff meta-dir/build` with a merge message summarizing the convention; then `git worktree remove .claude/worktrees/meta-dir && git branch -d meta-dir/build`.

---

### Task 9: Work-vault migration (operational — live vault at `~/vaults/work`)

The daemon is a launchd agent running the dev tree directly (`com.dome.serve.work-cda3a1f5`); new code needs a daemon restart. Ledgers move by hand; shards migrate themselves via retirement.

- [ ] **Step 1: Check daemon health before surgery**

```bash
tail -20 /Users/mark.toda/vaults/work/.dome/state/serve.log
cd /Users/mark.toda/vaults/work && git status
```

Expected: recent heartbeat lines, clean (or explainable) git status. Do not proceed mid-garden-run; wait for a quiet log tail.

- [ ] **Step 2: Stop the daemon**

```bash
launchctl unload ~/Library/LaunchAgents/com.dome.serve.work-cda3a1f5.plist
```

- [ ] **Step 3: Move the ledgers and the log archive**

```bash
cd /Users/mark.toda/vaults/work
mkdir -p meta
git mv consolidation-ledger.md sweep-ledger.md log-archive-through-2026-06.md meta/
```

(The log archive is not SDK-written — pure tidy-up. Root `index-*.md` shards are NOT moved; the renderer retires them.)

- [ ] **Step 4: Update the vault grants and inbound references**

In `/Users/mark.toda/vaults/work/.dome/config.yaml`, change the four ledger grant lines (~79–80 read, ~88–89 patch.auto) to `meta/consolidation-ledger.md` / `meta/sweep-ledger.md`. Then sweep the vault for stale references:

```bash
grep -rn 'consolidation-ledger\|sweep-ledger\|log-archive-through' AGENTS.md CLAUDE.md core.md wiki notes 2>/dev/null
```

Update any hits (wikilinks resolve by basename in Obsidian, but path-qualified references must be fixed).

- [ ] **Step 5: Commit the vault migration**

```bash
git add -A && git commit -m "chore: move ledgers and log archive under meta/"
```

- [ ] **Step 6: Restart and watch the first garden pass**

```bash
launchctl load ~/Library/LaunchAgents/com.dome.serve.work-cda3a1f5.plist
tail -f /Users/mark.toda/vaults/work/.dome/state/serve.log
```

Expected within the next render-index run: a Dome commit deleting root `index-entities.md`, `index-entities-2.md`, `index-concepts.md`, `index-sources.md`, `index-sources-2.md`, `index-syntheses.md` and writing `meta/index-*.md`; root `index.md` rewritten with `[[meta/…]]` links.

- [ ] **Step 7: Verify the end state**

```bash
ls /Users/mark.toda/vaults/work/
```

Expected root files: `AGENTS.md CLAUDE.md core.md index.md log.md Untitled.canvas` + directories (`inbox notes meta preferences raw slides sources templates wiki`). `Untitled.canvas` is user content — flag it to Mark, never auto-delete.

---

## Self-review notes

- **Spec coverage:** shards→meta (Tasks 1–3), ledger defaults (Task 4), SDK config/loops (Task 5), docs (Task 7), migration (Task 9). The log archive is migration-only (no SDK code writes it — verified by grep).
- **Deliberate non-goals:** no `index_dir` config knob; no category-table code change (`meta/*` stays `external` by derivation); docs vault unaffected (its `wiki/` has no entities/concepts/syntheses pages, so render-index emits nothing there).
- **Type consistency:** `META_DIR` is exported from `lib/index-render.ts` and used only there; `SHARD_NAME_RE` stays processor-local; `DEFAULT_LEDGER_PATH` constants stay file-local in both processors.
