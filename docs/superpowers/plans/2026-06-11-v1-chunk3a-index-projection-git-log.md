# Dome v1 Chunk 3a — Index-as-Projection + Git-Native Log — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill Dome's two accreting registries — the hand-maintained `index.md` becomes a deterministic render from per-page `description:` frontmatter, and the append-only `log.md` is frozen in favor of narrative engine-commit messages surfaced by a new `dome log` command — pinned by a new `NO_ACCRETING_REGISTRIES` invariant.

**Architecture:** Index: descriptions live in page frontmatter (lint-encouraged); `dome.markdown.page-status` additionally projects `dome.page.description` facts (adoption, deterministic); a new garden processor `dome.markdown.render-index` reads the snapshot and rewrites generated index files (root map + per-category shards, size-budget pagination) inside `<!-- dome.markdown:index-catalog:* -->` generated blocks. Log: `PatchEffect.reason` (an existing field that `applyPatch` currently drops) is plumbed into the engine-commit body; agent loops pass the model's final summary as the patch reason; a CLI-native `dome log` joins `git log` trailers with the run ledger. Charters/grants stop writing `log.md` and `index.md`.

**Tech Stack:** Bun + TypeScript, gray-matter (already a dep), isomorphic-git + native-git trailer reads (existing pattern in `src/git.ts`), `bun:test`.

**Critical context constraints (verified against code):**
- Garden processors **cannot** query the projection (`ctx.projection` is view-phase-only) — the index renderer reads `ctx.snapshot` directly, like `dome.markdown.simplify-indexes` does.
- `PatchEffect` already has `reason: string` (`src/core/effect.ts:131-137`); `applyPatch` composes `engine(applyPatch): <processorId>` with **no body** (`src/engine/core/apply-patch.ts:175-185`). The narrative contract is plumbing, not a core type change. The four-concept core stays sealed.
- Agent runs emit one PatchEffect with `reason: opts.patchReason` (`assets/extensions/dome.agent/lib/agent-run-effects.ts:144-152`).
- Generated-marker handling MUST go through `src/core/generated-block.ts` — `tests/integration/generated-block-splice-guard.test.ts` structurally rejects any other file touching marker literals.
- Adding a processor = 4 edits: processor file + manifest entry (`assets/extensions/dome.markdown/manifest.yaml`) + grant (`src/cli/default-vault-config.ts`) + test. Model: `page-status` (facts) and `simplify-indexes` (garden index patches).
- Invariant lockstep: `docs/wiki/invariants/<NAME>.md` with `tier:` + `enforced_by:` ⇒ `tests/invariants/<slug>.test.ts` must exist (`tests/integration/invariant-coverage.test.ts`).
- `tests/integration/agent-prompt-regression.test.ts` pins charter text — charter edits will require updating its expectations deliberately.

---

## File structure

| File | Role |
|---|---|
| Modify `assets/extensions/dome.markdown/processors/page-status.ts` | + `dome.page.description` fact emission |
| Modify `assets/extensions/dome.markdown/processors/lint-frontmatter.ts` | + missing-description info finding (wiki pages) |
| Create `assets/extensions/dome.markdown/lib/index-render.ts` | pure: entries+config → generated index file contents (sharding, pagination) |
| Create `assets/extensions/dome.markdown/processors/render-index.ts` | garden processor: snapshot → PatchEffects for index files |
| Modify `assets/extensions/dome.markdown/manifest.yaml` | render-index entry |
| Modify `src/cli/default-vault-config.ts` | dome.markdown grant for index files; REMOVE log.md/index.md from dome.agent patch.auto |
| Create `scripts/migrate-index-descriptions.ts` | one-shot: parse index.md entries → page frontmatter descriptions |
| Modify `src/engine/core/apply-patch.ts` | commit body = PatchEffect.reason |
| Modify `assets/extensions/dome.agent/lib/agent-run-effects.ts` + callers | model summary → patchReason |
| Modify `assets/extensions/dome.agent/lib/ingest-charter.ts`, `consolidate-charter.ts` | drop log.md/index.md instructions; description-frontmatter + narrative-reason guidance |
| Create `src/surface/activity.ts` | collector: git log + trailers + runs.db join |
| Create `src/cli/commands/log.ts` + modify `src/cli/index.ts` | `dome log` verb |
| Create `docs/wiki/invariants/NO_ACCRETING_REGISTRIES.md` + `tests/invariants/no-accreting-registries.test.ts` | the invariant + structural fence |
| Modify specs: `docs/wiki/specs/adoption.md`, `autonomous-agents.md`, `vault-layout.md`, `cli.md` | lockstep |
| Tests | `tests/extensions/page-status.test.ts` (extend), `lint-frontmatter.test.ts` (extend), new `tests/extensions/index-render.test.ts`, `render-index.test.ts`, `tests/scripts/migrate-index-descriptions.test.ts`, extend `tests/engine/apply-patch.test.ts`, new `tests/surface/activity.test.ts`, `tests/cli/commands/log.test.ts` |

Run tests: `bun test <path>`; full suite `bun test`; typecheck `bun run typecheck`.

---

## Part A — Index as compiled projection

### Task 1: `dome.page.description` facts from frontmatter

**Files:**
- Modify: `assets/extensions/dome.markdown/processors/page-status.ts`
- Test: `tests/extensions/page-status.test.ts` (extend; read it first and mirror its fixture style)

- [ ] **Step 1: Write the failing test** — append to the existing test file, using its existing vault-fixture helpers (mirror an existing `dome.page.status` test case verbatim and adapt):

```typescript
test("emits dome.page.description fact when frontmatter carries description", async () => {
  // Use this file's existing fixture pattern: write a page with frontmatter,
  // run the processor via makeProcessorContext, collect effects.
  const content = `---\ntype: entity\ndescription: Protocol engineer at Uniswap Labs\n---\n# Page\n`;
  const effects = await runPageStatusOn({ "wiki/entities/test-person.md": content }); // adapt to the file's actual helper
  const fact = effects.find(
    (e) => e.kind === "fact" && e.predicate === "dome.page.description",
  );
  expect(fact).toBeDefined();
  expect(fact.object).toEqual({ kind: "string", value: "Protocol engineer at Uniswap Labs" });
  expect(fact.assertion).toBe("extracted");
});

test("no description fact when frontmatter lacks description or page opts out", async () => {
  const plain = await runPageStatusOn({ "wiki/entities/a.md": "---\ntype: entity\n---\n# A\n" });
  expect(plain.some((e) => e.kind === "fact" && e.predicate === "dome.page.description")).toBe(false);
});
```

The helper name (`runPageStatusOn`) is illustrative — reuse whatever harness the existing tests in that file use; do not invent a parallel harness.

- [ ] **Step 2:** Run `bun test tests/extensions/page-status.test.ts` — expect the new tests FAIL (no such fact emitted).

- [ ] **Step 3: Implement** in `page-status.ts`: where the processor already parses frontmatter per page (it reads `status:`/`superseded_by:`), additionally read `description`:

```typescript
const description = typeof data.description === "string" ? data.description.trim() : "";
if (description.length > 0) {
  effects.push(
    factEffect({
      subject: { kind: "page", path },        // match the file's existing subject construction exactly
      predicate: "dome.page.description",
      object: { kind: "string", value: description },
      assertion: "extracted",
      sourceRefs: [ctx.sourceRef(path, frontmatterRange)], // reuse the file's existing sourceRef for frontmatter
    }),
  );
}
```

Adapt identifier names to the file's actual local conventions (it already constructs `dome.page.*` facts — copy that shape). The manifest already grants `graph.write` on `dome.page.*` — no manifest/grant change needed.

- [ ] **Step 4:** Run `bun test tests/extensions/page-status.test.ts` — PASS. Also `bun test tests/integration/processor-purity.test.ts`.
- [ ] **Step 5: Commit** — `feat(dome.markdown): project dome.page.description facts from frontmatter`

### Task 2: missing-description lint (info)

**Files:**
- Modify: `assets/extensions/dome.markdown/processors/lint-frontmatter.ts`
- Test: `tests/extensions/lint-frontmatter.test.ts` (extend)

- [ ] **Step 1: Failing test** (mirror an existing finding test in that file):

```typescript
test("wiki page without description gets info-severity missing-description finding", async () => {
  const effects = await runLintOn({ "wiki/entities/no-desc.md": "---\ntype: entity\n---\n# X\n" });
  const finding = effects.find(
    (e) => e.kind === "diagnostic" && e.code === "dome.markdown.missing-description",
  );
  expect(finding).toBeDefined();
  expect(finding.severity).toBe("info");
});

test("description present or notes/ path → no missing-description finding", async () => {
  const ok = await runLintOn({ "wiki/entities/ok.md": "---\ntype: entity\ndescription: fine\n---\n# X\n" });
  expect(ok.some((e) => e.kind === "diagnostic" && e.code === "dome.markdown.missing-description")).toBe(false);
  const notes = await runLintOn({ "notes/meeting.md": "---\ntype: source\n---\n# N\n" });
  expect(notes.some((e) => e.kind === "diagnostic" && e.code === "dome.markdown.missing-description")).toBe(false);
});
```

- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement**: add `const CODE_MISSING_DESCRIPTION = "dome.markdown.missing-description";` next to the file's other code constants; in `lintContent` after the existing required-field checks, only when the path's lint mode is `"required"` (the `frontmatterLintModeForPath` result already in scope):

```typescript
if (mode === "required" && (typeof data.description !== "string" || data.description.trim().length === 0)) {
  findings.push({
    code: CODE_MISSING_DESCRIPTION,
    message: "Add a one-line `description:` — it feeds the generated index and search.",
  });
}
```

Severity: route this code to `"info"` in the file's severity logic (it must never noise up adoption — it's a gradual-fill nudge).

- [ ] **Step 4:** Run lint-frontmatter tests — PASS.
- [ ] **Step 5: Commit** — `feat(dome.markdown): info lint for missing description on wiki pages`

### Task 3: pure index renderer library

**Files:**
- Create: `assets/extensions/dome.markdown/lib/index-render.ts`
- Test: `tests/extensions/index-render.test.ts`

- [ ] **Step 1: Failing test:**

```typescript
// tests/extensions/index-render.test.ts — pure renderer, no vault needed.
import { describe, expect, test } from "bun:test";
import {
  renderIndexFiles,
  type IndexEntry,
} from "../../assets/extensions/dome.markdown/lib/index-render";

const entries: IndexEntry[] = [
  { path: "wiki/entities/alice.md", description: "Engineer", category: "entities" },
  { path: "wiki/entities/bob.md", description: "Designer", category: "entities" },
  { path: "wiki/concepts/flow.md", description: "A process idea", category: "concepts" },
];

describe("renderIndexFiles", () => {
  test("renders a root map plus one shard per non-empty category", () => {
    const files = renderIndexFiles(entries, { shardBudgetChars: 24_000 });
    expect(Object.keys(files).sort()).toEqual(["index-concepts.md", "index-entities.md", "index.md"]);
    expect(files["index-entities.md"]).toContain("- [[wiki/entities/alice]] — Engineer");
    expect(files["index.md"]).toContain("[[index-entities]]");
    expect(files["index.md"]).toContain("2"); // entity count in the root map
    // Every file's body lives inside the generated block markers.
    expect(files["index.md"]).toContain("<!-- dome.markdown:index-catalog:start -->");
    expect(files["index.md"]).toContain("<!-- dome.markdown:index-catalog:end -->");
  });

  test("entries sorted by path; deterministic output", () => {
    const a = renderIndexFiles(entries, { shardBudgetChars: 24_000 });
    const b = renderIndexFiles([...entries].reverse(), { shardBudgetChars: 24_000 });
    expect(a).toEqual(b);
  });

  test("paginates a shard past the size budget", () => {
    const many: IndexEntry[] = Array.from({ length: 50 }, (_, i) => ({
      path: `wiki/entities/person-${String(i).padStart(2, "0")}.md`,
      description: "x".repeat(200),
      category: "entities",
    }));
    const files = renderIndexFiles(many, { shardBudgetChars: 4_000 });
    expect(files["index-entities.md"]).toBeDefined();
    expect(files["index-entities-2.md"]).toBeDefined();
    expect(files["index.md"]).toContain("[[index-entities-2]]");
  });

  test("empty input renders nothing (no empty registry files)", () => {
    expect(renderIndexFiles([], { shardBudgetChars: 24_000 })).toEqual({});
  });

  test("missing description renders the link with a muted placeholder", () => {
    const files = renderIndexFiles(
      [{ path: "wiki/entities/c.md", description: null, category: "entities" }],
      { shardBudgetChars: 24_000 },
    );
    expect(files["index-entities.md"]).toContain("- [[wiki/entities/c]] — *(no description yet)*");
  });
});
```

- [ ] **Step 2:** Run — FAIL (module missing).
- [ ] **Step 3: Implement** `assets/extensions/dome.markdown/lib/index-render.ts`:

```typescript
// dome.markdown index renderer — pure functions from (entries, config) to the
// generated index-file contents. The catalog body of every file it produces
// lives inside a `dome.markdown:index-catalog` generated block, so owners can
// keep hand prose above/below the block and the splice-guard machinery owns
// the markers. Determinism is load-bearing: same entries → byte-identical
// output (the garden processor diffs against the snapshot to no-op).
//
// NO_ACCRETING_REGISTRIES: these files are renders, not registries — nothing
// ever appends to them; the renderer rewrites them whole from per-page
// `description:` frontmatter.

import {
  generatedBlockMarkers,
} from "../../../../src/core/generated-block";

export type IndexEntry = {
  readonly path: string;               // vault-relative .md path
  readonly description: string | null; // frontmatter description (trimmed) or null
  readonly category: string;           // shard key, e.g. "entities"
};

export type IndexRenderConfig = {
  readonly shardBudgetChars: number;   // soft cap per shard file body
};

const MARKERS = generatedBlockMarkers("dome.markdown", "index-catalog");

/** Render all index files. Key = vault-relative filename, value = full content. */
export function renderIndexFiles(
  entries: ReadonlyArray<IndexEntry>,
  config: IndexRenderConfig,
): Record<string, string> {
  if (entries.length === 0) return {};
  const byCategory = new Map<string, IndexEntry[]>();
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }

  const files: Record<string, string> = {};
  const shardSummaries: Array<{ readonly category: string; readonly count: number; readonly shards: string[] }> = [];

  for (const category of [...byCategory.keys()].sort()) {
    const lines = (byCategory.get(category) ?? []).map(entryLine);
    const pages = paginate(lines, config.shardBudgetChars);
    const shardNames = pages.map((_, i) =>
      i === 0 ? `index-${category}.md` : `index-${category}-${i + 1}.md`,
    );
    pages.forEach((pageLines, i) => {
      const name = shardNames[i] as string;
      files[name] = wrapBlock(
        `# Index — ${category}${pages.length > 1 ? ` (${i + 1}/${pages.length})` : ""}`,
        pageLines.join("\n"),
      );
    });
    shardSummaries.push({
      category,
      count: byCategory.get(category)?.length ?? 0,
      shards: shardNames.map((n) => n.replace(/\.md$/, "")),
    });
  }

  const rootLines = shardSummaries.map(
    (s) =>
      `- **${s.category}** (${s.count}) — ${s.shards.map((n) => `[[${n}]]`).join(", ")}`,
  );
  files["index.md"] = wrapBlock(
    "# Index",
    [
      "Generated map of this vault's indexed pages. Descriptions live in each",
      "page's `description:` frontmatter; edit them there, never here.",
      "",
      ...rootLines,
    ].join("\n"),
  );
  return files;
}

function entryLine(entry: IndexEntry): string {
  const link = entry.path.replace(/\.md$/, "");
  return entry.description === null
    ? `- [[${link}]] — *(no description yet)*`
    : `- [[${link}]] — ${entry.description}`;
}

function paginate(lines: ReadonlyArray<string>, budget: number): string[][] {
  const pages: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (current.length > 0 && size + line.length + 1 > budget) {
      pages.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

function wrapBlock(title: string, body: string): string {
  return `${title}\n\n${MARKERS.start}\n${body}\n${MARKERS.end}\n`;
}
```

**Splice-guard note:** this file uses `generatedBlockMarkers` from the core module, so the structural fence passes. If the guard still trips (its regex looks for literal markers), the import satisfies it — that is its documented contract.

- [ ] **Step 4:** Run `bun test tests/extensions/index-render.test.ts tests/integration/generated-block-splice-guard.test.ts` — PASS.
- [ ] **Step 5: Commit** — `feat(dome.markdown): pure index-catalog renderer with sharding`

### Task 4: `dome.markdown.render-index` garden processor

**Files:**
- Create: `assets/extensions/dome.markdown/processors/render-index.ts`
- Modify: `assets/extensions/dome.markdown/manifest.yaml`, `src/cli/default-vault-config.ts`
- Test: `tests/extensions/render-index.test.ts`

- [ ] **Step 1: Failing test** (mirror the vault-fixture harness used by `tests/extensions/` garden-processor tests — read `simplify-indexes`' test first and reuse its fixture helpers):

```typescript
// tests/extensions/render-index.test.ts — key cases:
// 1. Vault with wiki/entities/a.md (description) + wiki/concepts/b.md (no description)
//    → one PatchEffect(auto) writing index.md, index-entities.md, index-concepts.md;
//    contents match renderIndexFiles output; missing-description page included with placeholder.
// 2. index: false frontmatter → page excluded entirely.
// 3. Vault with no pages under configured categories (e.g. only docs/wiki/specs/**)
//    → ZERO effects (no empty files; the dogfood docs vault must be untouched).
// 4. Idempotency: running against a snapshot where the index files already match
//    → ZERO effects (diff-before-emit).
// 5. Human preamble above the generated block in an existing index-entities.md
//    is preserved (replaceGeneratedBlock semantics).
```

Write these as real tests against the harness; case 5's fixture seeds an `index-entities.md` containing `Hand notes.\n\n<markers>old<markers>` and asserts the patched content starts with `Hand notes.`.

- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement** `render-index.ts`:

```typescript
// dome.markdown.render-index — garden processor: compile the index catalog
// from per-page `description:` frontmatter. Deterministic, snapshot-in →
// patches-out (garden processors have no projection access; this reads
// frontmatter directly, the same posture as simplify-indexes). Index files
// are RENDERS: the processor rewrites the dome.markdown:index-catalog block
// in each file (preserving any human prose outside it) and deletes shards
// that are no longer produced. Pinned by NO_ACCRETING_REGISTRIES.

import matter from "gray-matter";
import {
  patchEffect, type Effect, type FileChange,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation, type ProcessorContext,
} from "../../../../src/core/processor";
import {
  findGeneratedBlock, replaceGeneratedBlock,
} from "../../../../src/core/generated-block";
import { renderIndexFiles, type IndexEntry } from "../lib/index-render";

const DEFAULT_CATEGORIES: Record<string, string> = {
  "wiki/entities/": "entities",
  "wiki/concepts/": "concepts",
  "wiki/syntheses/": "syntheses",
};
const DEFAULT_SHARD_BUDGET = 24_000;

const renderIndex = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const categories = categoriesFromConfig(ctx.extensionConfig); // degrade-not-crash, default above
    const budget = budgetFromConfig(ctx.extensionConfig);

    const entries: IndexEntry[] = [];
    for (const path of await ctx.snapshot.listMarkdownFiles()) {
      const category = categoryFor(path, categories);
      if (category === null) continue;
      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;
      const fm = safeFrontmatter(content);
      if (fm.index === false) continue;                       // declarative opt-out
      const description = typeof fm.description === "string" && fm.description.trim().length > 0
        ? fm.description.trim()
        : null;
      entries.push({ path, description, category });
    }

    const rendered = renderIndexFiles(entries, { shardBudgetChars: budget });
    const changes: FileChange[] = [];

    for (const [file, content] of Object.entries(rendered)) {
      const existing = await ctx.snapshot.readFile(file);
      const next = existing === null ? content : spliceInto(existing, content);
      if (next !== existing) changes.push({ kind: "write", path: file, content: next });
    }
    // Stale shards: previously rendered index-*.md no longer produced → delete.
    for (const path of await ctx.snapshot.listMarkdownFiles()) {
      if (/^index(-[a-z0-9-]+)?\.md$/.test(path) && !(path in rendered)) {
        const existing = await ctx.snapshot.readFile(path);
        if (existing !== null && findGeneratedBlock(existing, "dome.markdown", "index-catalog") !== null) {
          changes.push({ kind: "delete", path });
        }
      }
    }

    if (changes.length === 0) return [];
    return [
      patchEffect({
        mode: "auto",
        changes,
        reason: `render index catalog: ${entries.length} pages across ${new Set(entries.map((e) => e.category)).size} categories`,
        sourceRefs: [ctx.sourceRef("index.md")],
      }),
    ];
  },
});

/** Replace our block inside an existing file, preserving human prose around it. */
function spliceInto(existing: string, renderedWhole: string): string {
  const scan = findGeneratedBlock(existing, "dome.markdown", "index-catalog");
  if (scan === null) return renderedWhole; // file exists but no block → take it over whole
  const renderedScan = findGeneratedBlock(renderedWhole, "dome.markdown", "index-catalog");
  if (renderedScan === null) return renderedWhole;
  const body = renderedWhole.slice(renderedScan.bodyStart, renderedScan.bodyEnd);
  return replaceGeneratedBlock(existing, "dome.markdown", "index-catalog", body) ?? renderedWhole;
}

export default renderIndex;
```

(Adapt the exact `defineProcessorImplementation` / `FileChange` / `patchEffect` call shapes to what `simplify-indexes.ts` does — that file is the canonical garden-index-patcher; the helper functions `categoriesFromConfig` / `budgetFromConfig` / `categoryFor` / `safeFrontmatter` follow the degrade-not-crash config idiom from `sweep.ts` lines 88-120.)

Manifest entry (after simplify-indexes):

```yaml
  - id: dome.markdown.render-index
    version: 0.1.0
    phase: garden
    triggers:
      - kind: schedule
        cron: "15 5 * * *"
      - kind: signal
        name: file.created
        paths: ["wiki/**/*.md"]
      - kind: signal
        name: file.deleted
        paths: ["wiki/**/*.md"]
    capabilities:
      - kind: read
        paths: ["**/*.md"]
      - kind: patch.auto
        paths: ["index.md", "index-*.md"]
    module: processors/render-index.ts
```

Grant: in `src/cli/default-vault-config.ts`, the dome.markdown bundle's `patch.auto` already covers `**/*.md` — verify; if it does, no change needed; if scoped tighter, add `index.md` + `index-*.md`.

- [ ] **Step 4:** Run `bun test tests/extensions/render-index.test.ts tests/integration` — PASS (the bundle-matrix-lockstep test may require a matrix row for new processors; add what it demands).
- [ ] **Step 5: Commit** — `feat(dome.markdown): render-index garden processor — index files become renders`

### Task 5: one-shot migration script

**Files:**
- Create: `scripts/migrate-index-descriptions.ts`
- Test: `tests/scripts/migrate-index-descriptions.test.ts` (check whether `tests/scripts/` exists; if scripts are tested elsewhere, follow that home)

- [ ] **Step 1: Failing test:** fixture vault dir (plain temp dir, no git needed — the script only edits files) with `index.md` containing three `- [[wiki/entities/x]] — Desc` entries (one target page missing `description:`, one already having it, one whose file doesn't exist); run the exported `migrateIndexDescriptions(dir, { dryRun: false })`; assert: missing-description page gained `description: Desc` in frontmatter (and nothing else changed in its body), already-described page untouched, missing file reported in the returned `{ updated, skipped, unmatched }` summary; dry-run mode changes nothing.

- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement:** exported function + thin CLI main (`Bun.argv`), parsing entries with `/^- \[\[([^\]]+)\]\] — (.+)$/` per line, gray-matter round-trip to insert `description` (preserve existing key order by inserting before the body, letting `normalize-frontmatter` canonicalize order on next adoption). No git operations — the operator reviews and commits the result (`git add -p` friendly). Print the summary.
- [ ] **Step 4:** Run — PASS. Also `bun run typecheck` (scripts tsconfig covers `scripts/`).
- [ ] **Step 5: Commit** — `feat(scripts): one-shot index.md → description-frontmatter migration`

---

## Part B — Git-native activity log

### Task 6: PatchEffect.reason becomes the commit body

**Files:**
- Modify: `src/engine/core/apply-patch.ts` (~line 175)
- Test: `tests/engine/apply-patch.test.ts` (extend — read its existing fixture)

- [ ] **Step 1: Failing test:** in the existing apply-patch test harness, apply a patch whose `reason` is `"merged duplicate pages a+b"` and read back the created commit's message (the harness already reads commits or use `readCommit` from the git module); assert the message contains the reason as the body paragraph between subject and trailers, and the four `Dome-*` trailers still parse.

- [ ] **Step 2:** Run — FAIL (body absent today).
- [ ] **Step 3: Implement:** thread the reason through `composeCommitMessage`'s existing `body` parameter:

```typescript
const message = composeCommitMessage({
  verb: "engine(applyPatch)",
  subject: opts.runContext.processorId,
  body: commitBodyFromReason(opts.patch.reason),
  touchedPaths: [],
  runContext: { ... }, // unchanged
});
```

with a small pure helper in the same file:

```typescript
/**
 * The PatchEffect's `reason` is the narrative activity log (NO_ACCRETING_REGISTRIES:
 * git history replaces log.md). Bound and sanitize: single paragraph, no
 * trailer-spoofing `Key: value` line starts, hard cap to keep messages sane.
 */
const REASON_BODY_MAX_CHARS = 600;
function commitBodyFromReason(reason: string): string | undefined {
  const flat = reason.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return undefined;
  return flat.slice(0, REASON_BODY_MAX_CHARS);
}
```

(Check `composeCommitMessage`'s exact optional-body contract in `src/engine-commit.ts` — it already supports a body; if `apply-patch.ts` receives the patch under a different variable name, adapt.) Add one test asserting a reason containing `"Dome-Run: fake"` text cannot inject a parseable trailer (the flatten-to-one-line sanitization guarantees this — assert the real `Dome-Run` trailer count is exactly 1).

- [ ] **Step 4:** Run `bun test tests/engine` — PASS.
- [ ] **Step 5: Commit** — `feat(engine): patch reason rides the engine commit body`

### Task 7: agent summaries flow into the patch reason; charters stop writing log.md/index.md

**Files:**
- Modify: `assets/extensions/dome.agent/lib/agent-run-effects.ts` and its callers (grep `patchReason` — ingest/consolidate/sweep/brief processors pass it)
- Modify: `assets/extensions/dome.agent/lib/ingest-charter.ts`, `consolidate-charter.ts`
- Test: existing agent tests + `tests/integration/agent-prompt-regression.test.ts` (its pinned charter text will need a deliberate update)

- [ ] **Step 1: Investigate (10 min):** `grep -rn "patchReason" assets/extensions/dome.agent/` — find each caller's static string and how the model's final text reaches the effects builder (`opts.stopReason === "final"` implies a final message exists — find its variable; `finalTextExcerpt` at `agent-run-effects.ts:129` shows the final text IS available in scope).
- [ ] **Step 2: Failing test:** extend the agent-run-effects unit test (find it via `grep -rn "agent-run-effects" tests/`): when a final text is present, the PatchEffect's `reason` is `<static prefix>: <first ~200 chars of final text, flattened>`; when absent, the static reason alone.
- [ ] **Step 3: Implement** in `agent-run-effects.ts`:

```typescript
reason: opts.finalText !== undefined && opts.finalText.trim().length > 0
  ? `${opts.patchReason}: ${opts.finalText.replace(/\s+/g, " ").trim().slice(0, 200)}`
  : opts.patchReason,
```

(adding `finalText` to the opts type and threading it from each caller — the final model message is the natural narrative; the charters below sharpen what it should say).
- [ ] **Step 4: Charter edits:**
  - `ingest-charter.ts`: delete instruction step 6 (`"Append one dated line to log.md..."`); renumber; add to the final-message guidance: *"Your final message is the run's activity record — one tight line: what landed where (it becomes the engine commit message; there is no log.md)."* Also: wherever the charter tells the agent to add new pages to index.md (grep `index.md` in the charter), replace with: *"Set a one-line `description:` in each new page's frontmatter — the index is generated from it; never edit index files."*
  - `consolidate-charter.ts`: delete the `"Update index.md (...) and append a log.md entry."` bullet; replace with: *"Refresh the absorbed-into page's `description:` frontmatter if the merge changed what the page is; the index regenerates itself. Your final message is the activity record."*
- [ ] **Step 5:** Run `bun test tests/extensions tests/integration/agent-prompt-regression.test.ts` — update the regression test's pinned charter expectations to the new text (that test exists to make this edit deliberate; quote the new lines exactly).
- [ ] **Step 6: Commit** — `feat(dome.agent): final summary becomes the patch narrative; charters stop hand-feeding log.md/index.md`

### Task 8: grants drop log.md and index.md from agent patch.auto

**Files:**
- Modify: `src/cli/default-vault-config.ts` (dome.agent grants)
- Test: `tests/integration/default-vault-config.test.ts` (or wherever grants are pinned — grep `log.md` in tests/)

- [ ] **Step 1:** Grep `log.md` and `index.md` across `src/cli/default-vault-config.ts` — remove them from every dome.agent `patch.auto` array (ingest, consolidate; keep `read` entries — agents may still read history/index for context). Run the grant-pinning tests; update their expectations deliberately.
- [ ] **Step 2:** Run `bun test tests/cli tests/integration` — PASS after expectation updates.
- [ ] **Step 3: Commit** — `feat(grants): agent patch.auto excludes log.md and index files`

### Task 9: `dome log` — activity collector + CLI verb

**Files:**
- Create: `src/surface/activity.ts`
- Create: `src/cli/commands/log.ts`; modify `src/cli/index.ts`
- Test: `tests/surface/activity.test.ts`, `tests/cli/commands/log.test.ts`

- [ ] **Step 1: Failing collector test** — real temp vault fixture (initRepo + runInit + a human commit + a `dome sync` so engine commits exist), then:

```typescript
const entries = await buildActivityLog({ vault, limit: 20 });
// entries: newest-first; each { sha, when (ISO), author: "engine" | "human",
//   subject, body, runId: string | null, extensionId: string | null,
//   run: { status, durationMs, costUsd } | null }
expect(entries.length).toBeGreaterThan(0);
const engine = entries.find((e) => e.author === "engine");
expect(engine?.runId).toMatch(/^run_/);
const human = entries.find((e) => e.author === "human");
expect(human?.runId).toBeNull();
```

- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement `src/surface/activity.ts`:** CLI-native pattern (the `dome status` posture — processors deliberately have no git-history access). Read commits via the native-git trailer technique already proven in `src/git.ts` (`latestFileInfoByPath`, lines ~632-655: `git log --pretty=format:` with `%x1f` field separators and `%(trailers:key=Dome-Run,valueonly)`); extend the format string to also pull `%(trailers:key=Dome-Extension,valueonly)`, `%s`, `%b`, `%ct`, `%H`. Prefer adding a narrow exported helper to `src/git.ts` (e.g. `logWithTrailers({ path, limit, since? })`) next to the existing native-git block rather than spawning git from `src/surface/` — keep the git boundary in one file. Then open `runs.db` read-only via the ledger module's existing query surface (`queryRunSummaries`) and join on `runId`. Filters: `since` (ISO date → `--since`), `processor` (post-filter on extensionId/subject), `grep` (post-filter subject+body), `limit` (default 30). Freeze everything.
- [ ] **Step 4: CLI verb** `src/cli/commands/log.ts` — house pattern from `status.ts`/`query.ts`: `runLog(options) → exit code`; human render = one block per entry (`when · author · subject`, muted body lines, muted `run … status · 3.2s · $0.04` line when joined); `--json` emits `{ schema: "dome.log/v1", entries }`. Register in `src/cli/index.ts`: `log` with `--since <date>`, `--processor <id>`, `--grep <text>`, `--limit <n>` (parsePositiveIntegerOption), `--json`, `--vault`. Static import. Add `log` to the visible-command pins in `tests/cli/bin.test.ts` + `tests/cli/index.test.ts` (the same two files Chunk 1 touched for `today`/`recipe`).
- [ ] **Step 5:** CLI test: fixture vault → `runLog({ vault })` exit 0, output contains an engine subject (`engine(applyPatch)` or `adopt:`); `--json` parses with schema `dome.log/v1`; `--grep` narrows; `--limit 1` yields one entry.
- [ ] **Step 6:** Run `bun test tests/surface/activity.test.ts tests/cli/commands/log.test.ts tests/cli` — PASS.
- [ ] **Step 7: Commit** — `feat(cli): dome log — git-native activity view joining trailers with the run ledger`

### Task 10: NO_ACCRETING_REGISTRIES invariant

**Files:**
- Create: `docs/wiki/invariants/NO_ACCRETING_REGISTRIES.md`
- Create: `tests/invariants/no-accreting-registries.test.ts`

- [ ] **Step 1: Write the invariant doc** (mirror `PROJECTIONS_ARE_REBUILDABLE.md`'s structure: frontmatter with `type: invariant`, `tier: shipped`, `enforced_by: [tests/invariants/no-accreting-registries.test.ts]`; Statement / Why / Structural enforcement / Counter-example / Related):

Statement: *Every central vault artifact is either source-of-truth markdown a human curates, or a deterministic render from per-item sources. No file's maintenance contract is "agents append entries forever." The index files are renders from `description:` frontmatter (`dome.markdown.render-index`); the activity log is git history (`dome log`); ledgers that legitimately accrete (consolidation-ledger, sweep-ledger) are processor cursor state with explicit windows, not knowledge registries.*

- [ ] **Step 2: Write the structural fence test:**

```typescript
// tests/invariants/no-accreting-registries.test.ts
// Structural fence for NO_ACCRETING_REGISTRIES: (1) no first-party agent
// charter instructs appending to log.md or hand-editing index files;
// (2) no dome.agent default grant carries patch.auto over log.md or index*.md.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CHARTER_DIR = "assets/extensions/dome.agent/lib";

describe("NO_ACCRETING_REGISTRIES", () => {
  test("no charter instructs log.md appends or index edits", () => {
    for (const file of readdirSync(CHARTER_DIR).filter((f) => f.endsWith("charter.ts"))) {
      const text = readFileSync(join(CHARTER_DIR, file), "utf8");
      expect(text).not.toMatch(/appendToPage\(["']log\.md/);
      expect(text).not.toMatch(/append .*log\.md/i);
      expect(text).not.toMatch(/update .*index\.md/i);
    }
  });

  test("dome.agent default grants exclude log.md and index files from patch.auto", () => {
    const config = readFileSync("src/cli/default-vault-config.ts", "utf8");
    // Crude but effective: within the dome.agent extension block, patch.auto
    // arrays must not name log.md or index files. Refine the slice if the
    // file's structure makes this over-broad.
    const agentBlock = config.slice(config.indexOf('"dome.agent"'), config.indexOf('"dome.daily"'));
    const patchAutoArrays = agentBlock.match(/"patch\.auto":\s*\[[^\]]*\]/g) ?? [];
    for (const arr of patchAutoArrays) {
      expect(arr).not.toContain("log.md");
      expect(arr).not.toMatch(/index[-.*]/);
    }
  });
});
```

(Adapt the slice boundaries to the real structure of `default-vault-config.ts`; the bundle order may differ — locate the dome.agent block robustly.)

- [ ] **Step 3:** Run `bun test tests/invariants/no-accreting-registries.test.ts tests/integration/invariant-coverage.test.ts` — PASS (coverage test requires the doc/test pairing you just created).
- [ ] **Step 4: Commit** — `feat(invariants): NO_ACCRETING_REGISTRIES — registries are renders or git history`

### Task 11: spec lockstep + dogfood log freeze

**Files:**
- Modify: `docs/wiki/specs/adoption.md` (§"Engine commit trailers" — body contract), `docs/wiki/specs/autonomous-agents.md` (charter vocab + grants tables), `docs/wiki/specs/vault-layout.md` (log.md → frozen/archive pattern; index files → generated), `docs/wiki/specs/cli.md` (§"dome log"), `docs/index.md` (note that the dogfood index stays curated — `render-index` no-ops on it since it has no entities/concepts categories), `docs/log.md` (freeze header)

- [ ] **Step 1:** Read each spec's current section before editing (house voice). Content requirements:
  - **adoption.md**: the commit body between subject and trailers carries the PatchEffect's sanitized `reason` (single flattened paragraph, ≤600 chars, cannot spoof trailers); closure-commit subject unchanged.
  - **autonomous-agents.md**: ingest/consolidate write-vocabulary tables drop log.md and index.md from patch.auto; the final-message-is-the-activity-record contract; description-frontmatter-instead-of-index-edits.
  - **vault-layout.md**: `log.md` section becomes historical ("frozen <date>; activity lives in git — `dome log`; existing content archived in place"); index files documented as generated renders with the `index: false` opt-out and `description:` source-of-truth.
  - **cli.md**: §"dome log" (CLI-native, reads git + run ledger, no runtime lock; options; exit codes; tests pointer) + surface-block line.
  - **docs/log.md**: prepend a short frozen banner (keep all content).
- [ ] **Step 2:** Run `bun test tests/integration` (docs-coupled pins) and fix whatever they demand; then full `bun test`.
- [ ] **Step 3: Commit** — `docs(specs): index-as-render, narrative commit bodies, dome log, log.md freeze`

### Task 12: full-suite verification + work-vault migration runbook note

- [ ] **Step 1:** `bun test` (full) + `bun run typecheck` — green.
- [ ] **Step 2: E2E smoke** against a scratch vault:

```bash
DIR=$(mktemp -d) && bin/dome init "$DIR" >/dev/null && mkdir -p "$DIR/wiki/entities"
printf -- '---\ntype: entity\ndescription: Test person\n---\n# Alice\n' > "$DIR/wiki/entities/alice.md"
git -C "$DIR" add -A && git -C "$DIR" commit -qm seed && bin/dome sync --vault "$DIR" -q
bin/dome run dome.markdown.render-index --vault "$DIR" && bin/dome sync --vault "$DIR" -q
cat "$DIR/index-entities.md"          # expect: - [[wiki/entities/alice]] — Test person
bin/dome log --vault "$DIR" --limit 5 # expect: engine commits with narrative bodies
rm -rf "$DIR"
```

(Adjust to the real `dome run` invocation semantics for garden processors.)
- [ ] **Step 3:** Append a "Chunk 3a — work-vault migration" section to `docs/cohesive/runbooks/2026-06-server-migration.md` (or a sibling runbook): steps = check daemon heartbeat → `bun scripts/migrate-index-descriptions.ts ~/vaults/work --dry-run` → review → run for real → `git add -p` + commit → let render-index produce the new index files on next garden tick → verify with `dome log` → rename `log.md` → `log-archive-through-2026-06.md` + commit. Explicitly note: the live work vault is NOT migrated by this plan's execution — it is an operator step (daemon runs this dev tree; restart required to pick up new processors).
- [ ] **Step 4: Commit** — `docs(runbook): chunk 3a work-vault migration steps`

---

## Self-review notes (already applied)

- **Spec coverage:** description frontmatter + facts (T1), lint nudge (T2), generated renderer with sharding/pagination/opt-out (T3-4), migration (T5), narrative closure-commit contract (T6-7), grants freeze (T8), `dome log` (T9), invariant (T10), spec lockstep + log.md freeze (T11), verification + ops runbook (T12). The v1 spec's "no model ever edits an index file again" is enforced by T7 (charters) + T8 (grants) + T10 (fence).
- **Deliberate scope cuts:** `dome log` joins runs.db but does not paginate git reads beyond `--limit`; no MCP/HTTP `log` surface yet (collector lives in `src/surface/` so adapters can adopt it later); `simplify-indexes` (per-directory wiki child indexes) is left as-is — it owns `wiki/*/index.md` child lists, a different artifact from the root catalog; revisit only if the two collide in practice.
- **Verify-against-reality flags for the executor:** (a) test-harness helper names in extension tests; (b) `composeCommitMessage` body parameter shape; (c) how `patchReason`/final text actually thread through each agent caller; (d) `default-vault-config.ts` structure for the grant edits + invariant test slice; (e) whether `bundle-matrix-lockstep`/`gotcha-coverage` demand docs rows for the new processor; (f) `dome run` semantics for garden processors in the smoke test; (g) `tests/scripts/` existence.
- **Type consistency:** `IndexEntry`/`IndexRenderConfig` (T3) match the renderer use in T4; `buildActivityLog` entry shape (T9 Step 1) matches the render in T9 Step 4.
