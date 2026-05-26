# `dome stats` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `dome stats`, an 8th CLI command that prints a colorful, picocolors-styled dashboard of vault structure + activity, plus a `--json` machine-readable mode.

**Architecture:** One new command module at `src/cli/commands/stats.ts` exposing a pure `collectStats(vault)` (returns `VaultStats`), pure `renderDashboard(stats)` and `renderJson(stats)`, and a `domeStats(path, opts)` orchestrator. Wired into the existing Commander program in `src/cli/cli.ts`. Spec doc `docs/wiki/specs/cli.md` updated.

**Tech Stack:** TypeScript (ESM), Bun runtime, Bun's built-in test framework (`bun:test`), Commander 14, `isomorphic-git` via the canonical `src/git.ts` boundary, new dep `picocolors` for ANSI colors.

**Design subtlety — git stats and the dogfood case:** `isomorphic-git`'s `log()` walks from HEAD of whatever git repo the vault sits in. If the vault root is a subdirectory of an outer git repo (e.g., the dogfooded `docs/` vault inside the SDK repo), `git.ageDays`/`commits`/`contributors` will reflect the *outer* repo. v1 accepts this; document inline in source.

**Reference spec:** `docs/superpowers/specs/2026-05-26-dome-stats-design.md`

---

## File Structure

**New files:**

- `src/cli/commands/stats.ts` — command module: types, `collectStats`, `renderDashboard`, `renderJson`, `domeStats`
- `tests/cli/stats.test.ts` — unit + integration tests for the above

**Modified files:**

- `src/cli/cli.ts` — register the `stats` command on the Commander program, add an example to top-level help
- `docs/wiki/specs/cli.md` — bump headline "Seven commands" → "Eight commands"; insert a `## dome stats` section between `## dome doctor` and `## dome export-context`
- `package.json` — add `"picocolors": "^1.1.1"` to `dependencies`

---

### Task 1: Add dep, scaffold stub module, scaffold test file

**Files:**
- Modify: `package.json`
- Create: `src/cli/commands/stats.ts`
- Create: `tests/cli/stats.test.ts`

- [ ] **Step 1: Add `picocolors` to dependencies**

In `package.json`, in the `"dependencies"` block (alphabetical), add:

```json
    "picocolors": "^1.1.1",
```

The line goes between `"p-queue"` and `"remark"`.

- [ ] **Step 2: Install the dep**

Run: `bun install`
Expected: completes with `picocolors` added to `bun.lock`.

- [ ] **Step 3: Create the stub `src/cli/commands/stats.ts` with types and signatures**

Write to `src/cli/commands/stats.ts`:

```ts
import { openVault, type Vault } from "../../vault";
import { ok, type Result, type ToolError } from "../../types";

export interface VaultStats {
  vaultPath: string;
  pageCounts: Record<string, number>;
  totalPages: number;
  wikilinks: { total: number; orphans: number };
  raw: { count: number; bytes: number };
  notes: { count: number };
  log: { entries: number; lastWriteAt: string | null };
  topHubs: Array<{ target: string; incoming: number }>;
  git: { ageDays: number | null; commits: number; contributors: number };
}

export interface DomeStatsOpts {
  json?: boolean;
}

export async function collectStats(_vault: Vault): Promise<VaultStats> {
  throw new Error("not implemented");
}

export function renderDashboard(_stats: VaultStats): string {
  throw new Error("not implemented");
}

export function renderJson(_stats: VaultStats): string {
  throw new Error("not implemented");
}

export async function domeStats(
  vaultPath: string,
  opts: DomeStatsOpts,
): Promise<Result<{ output: string }, ToolError>> {
  const res = await openVault(vaultPath);
  if (!res.ok) return res;
  const stats = await collectStats(res.value);
  const output = opts.json === true ? renderJson(stats) : renderDashboard(stats);
  return ok({ output });
}
```

- [ ] **Step 4: Create the test scaffold `tests/cli/stats.test.ts`**

Write to `tests/cli/stats.test.ts`:

```ts
// Tests for `dome stats`. See src/cli/commands/stats.ts and
// docs/superpowers/specs/2026-05-26-dome-stats-design.md.

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { domeInit } from "../../src/cli/commands/init";
import { openVault } from "../../src/vault";
import { collectStats, renderJson, renderDashboard, domeStats } from "../../src/cli/commands/stats";

async function makeStatsVault(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "dome-stats-"));
  const target = join(base, "v");
  await domeInit(target);
  return {
    path: target,
    cleanup: async () => { await rm(base, { recursive: true, force: true }); },
  };
}

describe("dome stats", () => {
  test("smoke: collectStats returns a VaultStats shape on a fresh init", async () => {
    const v = await makeStatsVault();
    try {
      const vaultRes = await openVault(v.path);
      expect(vaultRes.ok).toBe(true);
      if (!vaultRes.ok) return;
      const stats = await collectStats(vaultRes.value);
      expect(stats.vaultPath).toBe(v.path);
      expect(stats.totalPages).toBe(0);
    } finally {
      await v.cleanup();
    }
  });
});
```

- [ ] **Step 5: Verify the test fails for the right reason**

Run: `bun test tests/cli/stats.test.ts`
Expected: FAIL with `Error: not implemented` from `collectStats`.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock src/cli/commands/stats.ts tests/cli/stats.test.ts
git commit -m "feat(cli): scaffold \`dome stats\` module + picocolors dep"
```

---

### Task 2: Implement `collectStats` — wiki walk (pages, wikilinks, top hubs)

**Files:**
- Modify: `src/cli/commands/stats.ts`
- Modify: `tests/cli/stats.test.ts`

The wiki walk is one pass that fills four `VaultStats` fields: `pageCounts`, `totalPages`, `wikilinks.{total,orphans}`, `topHubs`. We test all four together because they share one fixture and one walk.

- [ ] **Step 1: Add the failing test**

Append to `tests/cli/stats.test.ts` (inside the `describe` block):

Fixture link counts (verify against the file contents below before running):

- alice.md → bob (×2), carol (×1) — 3 outgoing
- bob.md → carol — 1 outgoing
- carol.md → ghost (unresolved) — 1 outgoing
- trust.md → alice — 1 outgoing
- memory.md — 0 outgoing
- **Total outgoing: 6.** **Orphans: 1** (carol → ghost).
- Incoming: alice 1 (from trust), bob 2 (from alice ×2), carol 2 (alice + bob).
- topHubs (after sort desc) — bob and carol tie at 2; sort order between them is implementation-defined.

```ts
test("wiki walk: pageCounts, totalPages, wikilinks, topHubs", async () => {
  const v = await makeStatsVault();
  try {
    await writeFile(
      join(v.path, "wiki", "entities", "alice.md"),
      "---\ntype: entity\n---\n# Alice\n\nKnows [[wiki/entities/bob]] and [[wiki/entities/bob]] and [[wiki/entities/carol]].",
    );
    await writeFile(
      join(v.path, "wiki", "entities", "bob.md"),
      "---\ntype: entity\n---\n# Bob\n\nKnows [[wiki/entities/carol]].",
    );
    await writeFile(
      join(v.path, "wiki", "entities", "carol.md"),
      "---\ntype: entity\n---\n# Carol\n\nMentions [[wiki/entities/ghost]].",
    );
    await writeFile(
      join(v.path, "wiki", "concepts", "trust.md"),
      "---\ntype: concept\n---\n# Trust\n\nSee [[wiki/entities/alice]].",
    );
    await writeFile(
      join(v.path, "wiki", "concepts", "memory.md"),
      "---\ntype: concept\n---\n# Memory\n",
    );

    const vaultRes = await openVault(v.path);
    if (!vaultRes.ok) throw new Error("openVault failed");
    const stats = await collectStats(vaultRes.value);

    expect(stats.totalPages).toBe(5);
    expect(stats.pageCounts.entity).toBe(3);
    expect(stats.pageCounts.concept).toBe(2);
    expect(stats.wikilinks.total).toBe(6);
    expect(stats.wikilinks.orphans).toBe(1);
    // bob and carol tie at incoming=2; alice is third at incoming=1.
    const top2Targets = new Set(stats.topHubs.slice(0, 2).map(h => h.target));
    expect(top2Targets).toEqual(new Set(["wiki/entities/bob.md", "wiki/entities/carol.md"]));
    expect(stats.topHubs.slice(0, 2).every(h => h.incoming === 2)).toBe(true);
    expect(stats.topHubs[2]).toEqual({ target: "wiki/entities/alice.md", incoming: 1 });
  } finally {
    await v.cleanup();
  }
});
```

- [ ] **Step 2: Run the test, verify it fails for the right reason**

Run: `bun test tests/cli/stats.test.ts`
Expected: FAIL with `Error: not implemented`.

- [ ] **Step 3: Implement the wiki walk in `collectStats`**

Replace the body of `collectStats` in `src/cli/commands/stats.ts` and add the necessary imports. The current imports line should become:

```ts
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { openVault, type Vault } from "../../vault";
import { ok, type Result, type ToolError } from "../../types";
import { walkMd } from "../../vault-fs";
import { parseWikilinks } from "../../wikilinks";
import { singularOf } from "../../page-type";
```

Replace the `collectStats` stub with:

```ts
export async function collectStats(vault: Vault): Promise<VaultStats> {
  const stats: VaultStats = {
    vaultPath: vault.path,
    pageCounts: {},
    totalPages: 0,
    wikilinks: { total: 0, orphans: 0 },
    raw: { count: 0, bytes: 0 },
    notes: { count: 0 },
    log: { entries: 0, lastWriteAt: null },
    topHubs: [],
    git: { ageDays: null, commits: 0, contributors: 0 },
  };

  // Wiki walk: pages, wikilinks, top hubs.
  const wikiRoot = join(vault.path, "wiki");
  const hubCounts = new Map<string, number>();
  if (existsSync(wikiRoot)) {
    const subdirs = await readdir(wikiRoot, { withFileTypes: true });
    for (const subdir of subdirs) {
      if (!subdir.isDirectory()) continue;
      const type = singularOf(subdir.name);
      const files = await readdir(join(wikiRoot, subdir.name), { withFileTypes: true });
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith(".md")) continue;
        stats.totalPages++;
        stats.pageCounts[type] = (stats.pageCounts[type] ?? 0) + 1;

        const rel = `wiki/${subdir.name}/${f.name}`;
        const out = await vault.tools.readDocument({ path: rel });
        if (!out.result.ok) continue;
        const body = out.result.value.body;
        for (const link of parseWikilinks(body)) {
          stats.wikilinks.total++;
          if (!link.isFullPath) continue;
          const targetRel = link.target.endsWith(".md") ? link.target : `${link.target}.md`;
          const absTarget = join(vault.path, targetRel);
          if (!existsSync(absTarget)) {
            stats.wikilinks.orphans++;
            continue;
          }
          hubCounts.set(targetRel, (hubCounts.get(targetRel) ?? 0) + 1);
        }
      }
    }
  }

  // Top 5 hubs by incoming count.
  stats.topHubs = [...hubCounts.entries()]
    .map(([target, incoming]) => ({ target, incoming }))
    .sort((a, b) => b.incoming - a.incoming)
    .slice(0, 5);

  return stats;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test tests/cli/stats.test.ts`
Expected: both tests PASS (smoke + wiki walk).

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/stats.ts tests/cli/stats.test.ts
git commit -m "feat(cli): collectStats wiki walk — pages, wikilinks, top hubs"
```

---

### Task 3: Implement `collectStats` — raw + notes filesystem stats

**Files:**
- Modify: `src/cli/commands/stats.ts`
- Modify: `tests/cli/stats.test.ts`

- [ ] **Step 1: Add the failing test**

Append to the `describe` block in `tests/cli/stats.test.ts`:

```ts
test("raw + notes: count and bytes", async () => {
  const v = await makeStatsVault();
  try {
    // dome init does NOT create notes/; create it explicitly.
    await mkdir(join(v.path, "notes"), { recursive: true });
    await writeFile(join(v.path, "raw", "first.md"), "raw one body");      // 12 bytes
    await writeFile(join(v.path, "raw", "second.md"), "raw two body here"); // 17 bytes
    await writeFile(join(v.path, "notes", "scratch.md"), "scratch");

    const vaultRes = await openVault(v.path);
    if (!vaultRes.ok) throw new Error("openVault failed");
    const stats = await collectStats(vaultRes.value);

    expect(stats.raw.count).toBe(2);
    expect(stats.raw.bytes).toBe(29); // 12 + 17
    expect(stats.notes.count).toBe(1);
  } finally {
    await v.cleanup();
  }
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test tests/cli/stats.test.ts -t "raw + notes"`
Expected: FAIL — `raw.count` is 0.

- [ ] **Step 3: Implement raw + notes walks in `collectStats`**

In `src/cli/commands/stats.ts`, after the "Top 5 hubs" block and before `return stats`, insert:

```ts
  // Raw files: count + total bytes.
  const rawRoot = join(vault.path, "raw");
  if (existsSync(rawRoot)) {
    for await (const p of walkMd(rawRoot)) {
      const s = await stat(p);
      stats.raw.count++;
      stats.raw.bytes += s.size;
    }
  }

  // Notes files: count only.
  const notesRoot = join(vault.path, "notes");
  if (existsSync(notesRoot)) {
    for await (const _p of walkMd(notesRoot)) {
      stats.notes.count++;
    }
  }
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test tests/cli/stats.test.ts -t "raw + notes"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/stats.ts tests/cli/stats.test.ts
git commit -m "feat(cli): collectStats raw + notes filesystem stats"
```

---

### Task 4: Implement `collectStats` — log.md parsing

**Files:**
- Modify: `src/cli/commands/stats.ts`
- Modify: `tests/cli/stats.test.ts`

- [ ] **Step 1: Add the failing test**

Append to the `describe` block:

```ts
test("log: entries count and lastWriteAt", async () => {
  const v = await makeStatsVault();
  try {
    // dome init wrote one bootstrap entry. Append two more.
    const logPath = join(v.path, "log.md");
    const existing = await Bun.file(logPath).text();
    const appended = existing +
      "\n## [2026-05-26T10:00:00Z] update | thing one\n\nBody.\n" +
      "\n## [2026-05-26T11:00:00Z] update | thing two\n\nBody.\n";
    await writeFile(logPath, appended);

    const vaultRes = await openVault(v.path);
    if (!vaultRes.ok) throw new Error("openVault failed");
    const stats = await collectStats(vaultRes.value);

    expect(stats.log.entries).toBeGreaterThanOrEqual(3); // bootstrap + 2 appended
    expect(stats.log.lastWriteAt).toBe("2026-05-26T11:00:00Z");
  } finally {
    await v.cleanup();
  }
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test tests/cli/stats.test.ts -t "log:"`
Expected: FAIL — `log.entries` is 0.

- [ ] **Step 3: Implement log parsing in `collectStats`**

In `src/cli/commands/stats.ts`, after the notes block and before `return stats`, insert:

```ts
  // log.md: count `## [<ts>]` headings and capture the most recent timestamp.
  // Same regex doctor uses for check 7 (log monotonicity).
  const logPath = join(vault.path, "log.md");
  if (existsSync(logPath)) {
    const logText = await Bun.file(logPath).text();
    const tsRe = /^## \[([^\]]+)\]/gm;
    let last: string | null = null;
    for (const m of logText.matchAll(tsRe)) {
      stats.log.entries++;
      const ts = m[1]!;
      if (last === null || ts > last) last = ts;
    }
    stats.log.lastWriteAt = last;
  }
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test tests/cli/stats.test.ts -t "log:"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/stats.ts tests/cli/stats.test.ts
git commit -m "feat(cli): collectStats log.md entry count + last-write timestamp"
```

---

### Task 5: Implement `collectStats` — git stats

**Files:**
- Modify: `src/cli/commands/stats.ts`
- Modify: `tests/cli/stats.test.ts`

- [ ] **Step 1: Add the failing test**

Append to the `describe` block:

```ts
test("git: ageDays, commits, contributors on a fresh init", async () => {
  const v = await makeStatsVault();
  try {
    const vaultRes = await openVault(v.path);
    if (!vaultRes.ok) throw new Error("openVault failed");
    const stats = await collectStats(vaultRes.value);

    // dome init creates exactly one commit, authored by the Dome author.
    expect(stats.git.commits).toBeGreaterThanOrEqual(1);
    expect(stats.git.contributors).toBeGreaterThanOrEqual(1);
    expect(stats.git.ageDays).not.toBeNull();
    expect(stats.git.ageDays).toBeGreaterThanOrEqual(0);
  } finally {
    await v.cleanup();
  }
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test tests/cli/stats.test.ts -t "git:"`
Expected: FAIL — `git.commits` is 0.

- [ ] **Step 3: Implement git stats in `collectStats`**

Add to the imports in `src/cli/commands/stats.ts`:

```ts
import { log as gitLog } from "../../git";
```

In `src/cli/commands/stats.ts`, after the log.md block and before `return stats`, insert:

```ts
  // Git: walk log() from HEAD. In the dogfood case (vault is a subdirectory
  // of an outer git repo), isomorphic-git walks the outer repo's history —
  // commit/contributor counts reflect the outer repo. Acceptable for v1.
  try {
    const commits = await gitLog({ path: vault.path });
    stats.git.commits = commits.length;
    if (commits.length > 0) {
      const oldest = commits[commits.length - 1]!;
      const firstCommitTsSec = oldest.commit.committer.timestamp;
      const firstCommitMs = firstCommitTsSec * 1000;
      stats.git.ageDays = Math.floor((Date.now() - firstCommitMs) / (24 * 60 * 60 * 1000));
      const authors = new Set<string>();
      for (const c of commits) {
        const a = c.commit.author;
        authors.add(a.email !== "" ? a.email : a.name);
      }
      stats.git.contributors = authors.size;
    }
  } catch {
    // No git repo or read error — leave defaults (ageDays=null, commits=0, contributors=0).
  }
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test tests/cli/stats.test.ts -t "git:"`
Expected: PASS.

- [ ] **Step 5: Run the full stats test file to confirm no regressions**

Run: `bun test tests/cli/stats.test.ts`
Expected: all five tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/stats.ts tests/cli/stats.test.ts
git commit -m "feat(cli): collectStats git age, commit count, contributors"
```

---

### Task 6: Implement `renderJson`

**Files:**
- Modify: `src/cli/commands/stats.ts`
- Modify: `tests/cli/stats.test.ts`

- [ ] **Step 1: Add the failing test**

Append to the `describe` block:

```ts
test("renderJson round-trips through JSON.parse", async () => {
  const v = await makeStatsVault();
  try {
    const vaultRes = await openVault(v.path);
    if (!vaultRes.ok) throw new Error("openVault failed");
    const stats = await collectStats(vaultRes.value);
    const json = renderJson(stats);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual(stats);
  } finally {
    await v.cleanup();
  }
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test tests/cli/stats.test.ts -t "renderJson"`
Expected: FAIL with `Error: not implemented`.

- [ ] **Step 3: Implement `renderJson`**

Replace the `renderJson` stub in `src/cli/commands/stats.ts`:

```ts
export function renderJson(stats: VaultStats): string {
  return JSON.stringify(stats, null, 2);
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test tests/cli/stats.test.ts -t "renderJson"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/stats.ts tests/cli/stats.test.ts
git commit -m "feat(cli): renderJson — JSON serialization of VaultStats"
```

---

### Task 7: Implement `renderDashboard`

**Files:**
- Modify: `src/cli/commands/stats.ts`
- Modify: `tests/cli/stats.test.ts`

This is the visual core. Renders the multi-line dashboard with picocolors. Bars are 12 cells, scaled per-row. Layout matches the design spec.

- [ ] **Step 1: Add the failing tests**

Append to the `describe` block:

```ts
function stripAnsi(s: string): string {
  // Match CSI escape sequences.
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

test("renderDashboard contains the vault path, DOME header, and headline numbers", async () => {
  const v = await makeStatsVault();
  try {
    await writeFile(
      join(v.path, "wiki", "entities", "alice.md"),
      "---\ntype: entity\n---\n# Alice\n",
    );
    const vaultRes = await openVault(v.path);
    if (!vaultRes.ok) throw new Error("openVault failed");
    const stats = await collectStats(vaultRes.value);
    const out = stripAnsi(renderDashboard(stats));

    expect(out).toContain("DOME");
    expect(out).toContain(v.path);
    expect(out).toContain("pages");
    expect(out).toContain("Wikilinks");
    expect(out).toContain("Raw files");
    expect(out).toContain("Log");
    expect(out).toContain("Vault age");
    expect(out).toMatch(/\b1\b/); // 1 entity page exists
  } finally {
    await v.cleanup();
  }
});

test("renderDashboard formats last-write age relative to lastWriteAt", async () => {
  // Hand-craft a VaultStats — no need for a real vault.
  const recent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
  const stats: VaultStats = {
    vaultPath: "/tmp/v",
    pageCounts: {},
    totalPages: 0,
    wikilinks: { total: 0, orphans: 0 },
    raw: { count: 0, bytes: 0 },
    notes: { count: 0 },
    log: { entries: 1, lastWriteAt: recent },
    topHubs: [],
    git: { ageDays: 0, commits: 1, contributors: 1 },
  };
  const out = stripAnsi(renderDashboard(stats));
  expect(out).toMatch(/last: 2h ago/);
});

test("renderDashboard renders bytes with KB/MB suffix", async () => {
  const stats: VaultStats = {
    vaultPath: "/tmp/v",
    pageCounts: {},
    totalPages: 0,
    wikilinks: { total: 0, orphans: 0 },
    raw: { count: 3, bytes: 2_500_000 }, // ~2.4 MB
    notes: { count: 0 },
    log: { entries: 0, lastWriteAt: null },
    topHubs: [],
    git: { ageDays: 0, commits: 0, contributors: 0 },
  };
  const out = stripAnsi(renderDashboard(stats));
  expect(out).toMatch(/2\.4 MB/);
});

test("renderDashboard emits no ANSI when picocolors detects no color support", async () => {
  // picocolors honors NO_COLOR / FORCE_COLOR / !isTTY. Bun tests run with
  // stdout piped (not a TTY), so picocolors.isColorSupported should be false
  // by default and no escape codes should appear.
  const stats: VaultStats = {
    vaultPath: "/tmp/v",
    pageCounts: { entity: 1 },
    totalPages: 1,
    wikilinks: { total: 0, orphans: 0 },
    raw: { count: 0, bytes: 0 },
    notes: { count: 0 },
    log: { entries: 0, lastWriteAt: null },
    topHubs: [],
    git: { ageDays: 0, commits: 0, contributors: 0 },
  };
  const out = renderDashboard(stats);
  expect(out).not.toMatch(/\x1b\[/);
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `bun test tests/cli/stats.test.ts -t "renderDashboard"`
Expected: all FAIL with `Error: not implemented`.

- [ ] **Step 3: Implement `renderDashboard`**

In `src/cli/commands/stats.ts`, add to the imports:

```ts
import pc from "picocolors";
```

Replace the `renderDashboard` stub with:

```ts
// Cells in each bar.
const BAR_WIDTH = 12;

function bar(filledFrac: number, fillColor: (s: string) => string): string {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(filledFrac * BAR_WIDTH)));
  const empty = BAR_WIDTH - filled;
  return fillColor("▓".repeat(filled)) + pc.dim("░".repeat(empty));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

// Map a page-type singular to its plural label for display.
function pluralLabel(typeName: string, n: number): string {
  // Special-case the four shipped types + common substrate extensions whose
  // English plurals aren't a simple "+s".
  const overrides: Record<string, string> = {
    entity: "entities",
    matrix: "matrices",
    synthesis: "syntheses",
    gotcha: "gotchas",
  };
  const label = overrides[typeName] ?? `${typeName}s`;
  return n === 1 ? typeName : label;
}

export function renderDashboard(stats: VaultStats): string {
  const headline = pc.bold(pc.cyan("DOME")) + " · " + pc.dim(stats.vaultPath);
  const divider = pc.dim("─".repeat(45));

  const countParts: string[] = [pc.bold(pc.yellow(String(stats.totalPages))) + " pages"];
  // Sort types by count desc; show non-zero ones inline.
  const sortedTypes = Object.entries(stats.pageCounts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5); // top 5 types
  for (const [type, n] of sortedTypes) {
    countParts.push(pc.bold(pc.yellow(String(n))) + " " + pluralLabel(type, n));
  }
  const countLine = "  " + countParts.join("  ·  ");

  // Bar denominators are heuristics — bars are texture, not precise.
  const wikiDenom = Math.max(1, stats.totalPages * 10);
  const wikiFrac = stats.wikilinks.total / wikiDenom;
  const rawDenom = Math.max(1, stats.raw.count + stats.totalPages);
  const rawFrac = stats.raw.count / rawDenom;
  const logFrac = stats.log.entries === 0 ? 0 : Math.min(1, stats.log.entries / 50);

  const wikiLine =
    "  Wikilinks  " + bar(wikiFrac, pc.green) + "  " +
    `${stats.wikilinks.total} links` +
    (stats.wikilinks.orphans > 0 ? ` · ${pc.red(String(stats.wikilinks.orphans))} orphans` : "");

  const rawLine =
    "  Raw files  " + bar(rawFrac, pc.yellow) + "  " +
    `${stats.raw.count} sources · ${formatBytes(stats.raw.bytes)}`;

  const logLastBit = stats.log.lastWriteAt !== null ? ` · last: ${formatAgo(stats.log.lastWriteAt)}` : "";
  const logLine =
    "  Log        " + bar(logFrac, pc.cyan) + "  " +
    `${stats.log.entries} entries${logLastBit}`;

  const topHubsBit = stats.topHubs.slice(0, 3)
    .map(h => {
      // Strip the wiki/<type>/ prefix and .md suffix for display.
      const trimmed = h.target.replace(/^wiki\/[^/]+\//, "").replace(/\.md$/, "");
      return `${trimmed} (${h.incoming})`;
    })
    .join(" · ");
  const topHubsLine = stats.topHubs.length > 0 ? `  Top hubs:  ${topHubsBit}` : null;

  const ageBit = stats.git.ageDays !== null ? `${stats.git.ageDays} days` : "?";
  const vaultAgeLine =
    `  Vault age: ${ageBit} · ${stats.git.commits} commits · ${stats.git.contributors} contributors`;

  const notesLine = stats.notes.count > 0
    ? `  Notes:     ${stats.notes.count} files`
    : null;

  return [
    "",
    headline,
    "  " + divider,
    countLine,
    "",
    wikiLine,
    rawLine,
    logLine,
    notesLine,
    "",
    topHubsLine,
    vaultAgeLine,
    "",
  ].filter(l => l !== null).join("\n");
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `bun test tests/cli/stats.test.ts -t "renderDashboard"`
Expected: all 4 renderDashboard tests PASS.

- [ ] **Step 5: Run the full stats test file**

Run: `bun test tests/cli/stats.test.ts`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/stats.ts tests/cli/stats.test.ts
git commit -m "feat(cli): renderDashboard — colored, picocolors-styled visual"
```

---

### Task 8: Test the `domeStats` orchestrator (happy path + failure path)

**Files:**
- Modify: `tests/cli/stats.test.ts`

`domeStats` was already implemented in Task 1's stub (openVault → collectStats → renderDashboard | renderJson). Now we test it.

- [ ] **Step 1: Add the failing test**

Append to the `describe` block:

```ts
test("domeStats returns dashboard output for an existing vault", async () => {
  const v = await makeStatsVault();
  try {
    const r = await domeStats(v.path, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.output).toContain("DOME");
    expect(r.value.output).toContain(v.path);
  } finally {
    await v.cleanup();
  }
});

test("domeStats with --json returns JSON output", async () => {
  const v = await makeStatsVault();
  try {
    const r = await domeStats(v.path, { json: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = JSON.parse(r.value.output);
    expect(parsed.vaultPath).toBe(v.path);
    expect(typeof parsed.totalPages).toBe("number");
  } finally {
    await v.cleanup();
  }
});

test("domeStats returns err when vault path is not a vault", async () => {
  const base = await mkdtemp(join(tmpdir(), "dome-stats-novault-"));
  try {
    const r = await domeStats(base, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Any vault-open error kind is acceptable; the orchestrator just forwards.
    expect(typeof r.error.kind).toBe("string");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests, verify they pass**

Since `domeStats` is already implemented (it called `collectStats` and the renderers, all of which now work), these tests should pass without further code changes.

Run: `bun test tests/cli/stats.test.ts -t "domeStats"`
Expected: all 3 PASS.

- [ ] **Step 3: Run the full stats test file**

Run: `bun test tests/cli/stats.test.ts`
Expected: all tests PASS (no regressions).

- [ ] **Step 4: Commit**

```bash
git add tests/cli/stats.test.ts
git commit -m "test(cli): domeStats orchestrator happy + failure paths"
```

---

### Task 9: Wire `stats` into the Commander CLI

**Files:**
- Modify: `src/cli/cli.ts`
- Modify: `tests/cli/stats.test.ts`

- [ ] **Step 1: Add a failing CLI integration test**

First, update the imports at the top of `tests/cli/stats.test.ts` to include `runCli` and `ExitCode`. Change the existing imports block from:

```ts
import { domeInit } from "../../src/cli/commands/init";
import { openVault } from "../../src/vault";
import { collectStats, renderJson, renderDashboard, domeStats } from "../../src/cli/commands/stats";
```

to:

```ts
import { domeInit } from "../../src/cli/commands/init";
import { openVault } from "../../src/vault";
import { collectStats, renderJson, renderDashboard, domeStats } from "../../src/cli/commands/stats";
import { runCli, ExitCode } from "../../src/cli/cli";
```

Then append to the `describe` block:

```ts
test("runCli stats --vault exits Success on a real vault", async () => {
  const v = await makeStatsVault();
  try {
    // Exit code matters for plumbing; the dashboard output is already
    // covered by the renderDashboard / renderJson unit tests above.
    const code = await runCli(["stats", "--vault", v.path]);
    expect(code).toBe(ExitCode.Success);
    const codeJson = await runCli(["stats", "--vault", v.path, "--json"]);
    expect(codeJson).toBe(ExitCode.Success);
  } finally {
    await v.cleanup();
  }
});

test("runCli stats --help exits Success", async () => {
  const code = await runCli(["stats", "--help"]);
  expect(code).toBe(ExitCode.Success);
});

test("runCli stats on a non-vault path exits Failure", async () => {
  const base = await mkdtemp(join(tmpdir(), "dome-stats-cli-novault-"));
  try {
    const code = await runCli(["stats", "--vault", base]);
    expect(code).toBe(ExitCode.Failure);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test, verify the integration test fails**

Run: `bun test tests/cli/stats.test.ts -t "runCli stats"`
Expected: FAIL — Commander reports unknown command `stats` (ExitCode.Usage).

- [ ] **Step 3: Register the `stats` command in `src/cli/cli.ts`**

In `src/cli/cli.ts`, after the imports of the other command modules (around line 8), add:

```ts
import { domeStats } from "./commands/stats";
```

In the `buildProgram` function, insert a new `program.command("stats")` block immediately after the `// ------ doctor ------` block ends (after line 319). Mirroring the style of the other commands:

```ts
  // ------ stats ------
  program
    .command("stats")
    .description("Print a visual dashboard of vault structure and activity.")
    .option("--vault <path>", "Vault path (defaults to current directory)")
    .option("--json", "Emit JSON to stdout (no colors, no dashboard)")
    .addHelpText(
      "after",
      [
        "",
        "Read-only summary of the vault: page counts by type, wikilink graph",
        "health, raw file footprint, log activity, top hubs, and git history.",
        "",
        "  dome stats                          # colored dashboard",
        "  dome stats --json | jq .totalPages  # machine-readable",
        "",
        "Like `dome doctor`, this command is deterministic and runs no LLM.",
      ].join("\n"),
    )
    .action(async (opts: { vault?: string; json?: boolean }) => {
      const path = opts.vault ?? process.cwd();
      const r = await domeStats(path, { json: opts.json === true });
      if (!r.ok) { console.error(renderCliError(r.error)); outcome.code = ExitCode.Failure; return; }
      console.log(r.value.output);
    });
```

Also add a line to the top-level program's `Examples:` block (around line 100, in the `.addHelpText("after", ...)` array). Find:

```ts
        "  dome serve --vault ~/vaults/work    # start MCP server + watcher",
```

And insert directly after it:

```ts
        "  cd ~/vaults/work && dome stats      # visual dashboard",
```

- [ ] **Step 4: Run the integration tests, verify they pass**

Run: `bun test tests/cli/stats.test.ts -t "runCli stats"`
Expected: both PASS.

- [ ] **Step 5: Run the full test suite to catch any regressions**

Run: `bun test`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/cli.ts tests/cli/stats.test.ts
git commit -m "feat(cli): register \`dome stats\` command in Commander program"
```

---

### Task 10: Update `docs/wiki/specs/cli.md`

**Files:**
- Modify: `docs/wiki/specs/cli.md`

The CLI spec lives in the dogfooded vault. Update the headline count and insert a new `## dome stats` section.

- [ ] **Step 1: Bump "Seven commands" → "Eight commands"**

In `docs/wiki/specs/cli.md`, around line 12, change:

```
The CLI is intentionally small. **Seven commands**. Each maps to a concrete user action; commands that would map to "chat-with-the-brain" or "browse-the-vault" do not exist (use a harness or Obsidian respectively).
```

to:

```
The CLI is intentionally small. **Eight commands**. Each maps to a concrete user action; commands that would map to "chat-with-the-brain" or "browse-the-vault" do not exist (use a harness or Obsidian respectively). A glanceable summary (`dome stats`) is neither — it's a snapshot of structural state.
```

- [ ] **Step 2: Insert the `## dome stats` section**

Find the section heading `## dome doctor` in `docs/wiki/specs/cli.md`. After the last paragraph of that section (immediately before the next `##` heading — likely `## dome export-context`), insert:

```markdown
## `dome stats`

Print a visually appealing, read-only dashboard summarizing the vault's structure and activity. No LLM; deterministic; safe to run anywhere `dome doctor` is safe.

```bash
dome stats                # colored dashboard to stdout (default)
dome stats --json         # JSON to stdout, no colors
dome stats --vault <path> # override CWD vault detection
```

The dashboard shows:

- **Page counts** by type — entities, concepts, specs, invariants, matrices, syntheses, gotchas, and any custom page-type extensions declared in `.dome/page-types.yaml`.
- **Wikilink graph health** — total link count and orphan count (full-path links whose target file doesn't exist).
- **Raw files** — count and total bytes.
- **Log activity** — total entries and age of the most recent entry (`Nm ago` / `Nh ago` / `Nd ago`).
- **Top hubs** — the 3 most-linked-to pages.
- **Git** — vault age in days, total commits, distinct contributor count.

`--json` emits the same data as a structured object whose shape (`VaultStats`) is the stable serialization contract for cross-tool consumption.

When the vault sits inside a larger git repo (the dogfood case), git stats reflect the outer repo's history. v1 documents this; a future `--commit-scope <vault|repo>` flag could specialize.

Exit code is 0 on success, 1 if vault open fails, 2 on usage error. A future `dome stats graph` subcommand will add a knowledge-graph visualization; v1 ships only the dashboard.
```

- [ ] **Step 3: Verify the change reads clearly**

Run: `head -120 docs/wiki/specs/cli.md`
Expected: "Eight commands" appears on line 12; `## dome stats` section appears after `## dome doctor`.

- [ ] **Step 4: Commit**

```bash
git add docs/wiki/specs/cli.md
git commit -m "docs(specs): document \`dome stats\` in cli.md; bump command count to 8"
```

---

### Task 11: Manual smoke test on the dogfooded vault

**Files:**
- None modified.

- [ ] **Step 1: Run `dome stats` on this repo's `docs/` vault**

Run: `bun bin/dome stats --vault docs`
Expected: a multi-line dashboard with `DOME · /…/docs`, headline page counts, three bar lines, top hubs, vault age. Colors render if your terminal supports them.

- [ ] **Step 2: Run `dome stats --json` on the same vault**

Run: `bun bin/dome stats --vault docs --json`
Expected: a pretty-printed JSON object with all `VaultStats` fields.

- [ ] **Step 3: Pipe through `jq` to confirm machine-readability**

Run: `bun bin/dome stats --vault docs --json | jq .totalPages`
Expected: a number printed.

- [ ] **Step 4: Run `dome stats --help`**

Run: `bun bin/dome stats --help`
Expected: per-command help text including the example block from Task 9.

- [ ] **Step 5: Run the full test suite once more**

Run: `bun test`
Expected: all tests PASS.

- [ ] **Step 6: No commit needed — this is verification only.**

---

## Self-Review

**Spec coverage:**

- Surface (`dome stats`, `--json`, `--vault`, exit codes) → Task 9 (CLI), Task 8 (orchestrator failure path).
- Rendered layout (colors, bars, sections, formatBytes, formatAgo) → Task 7.
- VaultStats schema (every field) → Tasks 2–6, JSON output → Task 6.
- collectStats decomposition (wiki, raw, notes, log, git, hubs) → Tasks 2–5.
- Spec update in `cli.md` → Task 10.
- Test plan (all 8 test categories from the spec) → covered across Tasks 1–9.
- Out-of-scope items (graph subcommand, `--since`, drilldowns, `--watch`) → explicitly deferred in the design doc, not in the plan.

**Placeholder scan:** All steps contain concrete code or commands. No "TBD", "TODO", or "see Task N" references.

**Type consistency:** `VaultStats` defined in Task 1 is the type referenced unchanged by every later task. `topHubs` is `Array<{ target; incoming }>` everywhere. `git.ageDays` is `number | null` everywhere. `collectStats`/`renderDashboard`/`renderJson`/`domeStats` signatures fixed in Task 1 don't change.

**Test-fixture consistency:** All tests use the `makeStatsVault` helper (Task 1) which calls `domeInit` for a real git history. The Task 4 log test reads `dome init`'s bootstrap log entry, so it asserts `>=3` rather than `==3` — handles future additions to the bootstrap log.
