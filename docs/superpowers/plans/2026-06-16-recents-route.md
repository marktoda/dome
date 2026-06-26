# Recents Route Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a "recently-touched knowledge pages" surface — `buildRecents` collector + `GET /recents` on the ask-server — the last backend piece for the PWA's recents panel.

**Architecture:** A runtime-free surface collector (`src/surface/recents.ts`, mirroring `src/surface/activity.ts`) that walks recent git commits newest-first, finds the changed pages per commit (new `changedPathsForCommit` git helper), dedups to the newest change per page over the knowledge roots, and derives a title + human/engine label + change subject per page. Exposed as `GET /recents` on `dome ask-server` (the PWA's single backend) — net-new, no duplication of `dome http`.

**Tech Stack:** TypeScript/Bun. Reuses `src/git.ts` (`logWithTrailers`, `readBlob`, the git-spawn pattern), `src/surface/activity.ts` (human/engine classification via the `domeRun` trailer), `gray-matter` (frontmatter parse, already a dep). Tests use the `runInit` + real-commits fixture pattern from `tests/surface/activity.test.ts`.

**Scope:** Recently-*touched* pages only (git-derived). NOT recently-viewed (no view tracking — v2). Roots: `wiki/entities/`, `wiki/concepts/`, `wiki/sources/`, `wiki/syntheses/`, `notes/`. Exclude `wiki/dailies/`, `index.md`, `log.md`, `core.md`, `inbox/`. Include both human + engine changes, labeled. Default limit 20.

---

## File Structure
- `src/git.ts` — add `changedPathsForCommit({path, sha})` (spawn `git diff-tree`).
- `src/surface/recents.ts` — `buildRecents({vault?, limit?})` → `ReadonlyArray<RecentEntry>`, and the `RecentEntry` type.
- `src/agent/server.ts` — add `GET /recents` route (auth + `dome.recents/v1` envelope).
- Tests: `tests/git/changed-paths.test.ts` (or extend an existing git test), `tests/surface/recents.test.ts`, a `/recents` case in `tests/agent/ask-server-data-routes.test.ts`.
- Doc: tick recents in `docs/cohesive/brainstorms/2026-06-16-hosted-agent-and-mobile-client.md`.

**Read before starting:** `src/surface/activity.ts` (the collector pattern + `logWithTrailers` usage + human/engine classification), `src/git.ts` (`logWithTrailers` at ~733, `readBlob` at ~409, and how git is spawned — mirror it for `diff-tree`), `tests/surface/activity.test.ts` (the fixture: `runInit` + real git commits), `src/agent/server.ts` (the `/capture` route — a runtime-free route is the closest template; auth + helpers).

---

## Task 1: `changedPathsForCommit` git helper

**Files:** Modify `src/git.ts`; Test `tests/git/changed-paths.test.ts`.

- [ ] **Step 1: Write the failing test**

Use the fixture style from `tests/surface/activity.test.ts` (init a temp git repo / vault, make commits). Then:

```typescript
// tests/git/changed-paths.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedPathsForCommit, log } from "../../src/git";
// Reuse whatever commit helper the repo's git tests use; if none, shell out
// via Bun.spawn(["git", ...], {cwd}) in the test to init + commit two files.

describe("changedPathsForCommit", () => {
  test("returns the files changed by a commit (vs its parent)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dome-cp-"));
    // init repo, commit A (file x.md), commit B (file y.md) — use the repo's
    // existing test git helpers if present; else Bun.spawn git directly.
    // ... (set up two commits) ...
    const commits = await log({ path: dir, limit: 5 }); // newest-first
    const headPaths = await changedPathsForCommit({ path: dir, sha: commits[0]!.sha });
    expect(headPaths).toContain("y.md");
    expect(headPaths).not.toContain("x.md");
  });

  test("the root commit reports all its files (diff vs empty tree)", async () => {
    // ... init + a single root commit touching x.md ...
    const commits = await log({ path: dir, limit: 5 });
    const rootPaths = await changedPathsForCommit({ path: dir, sha: commits.at(-1)!.sha });
    expect(rootPaths).toContain("x.md");
  });
});
```
NOTE: verify the `log` return shape (`.sha`) and adopt the repo's existing git-test commit helper if one exists (grep `tests/git`); otherwise drive `git` via `Bun.spawn` in the test setup.

- [ ] **Step 2: Run, expect FAIL** — `cd <worktree> && bun test tests/git/changed-paths.test.ts` (changedPathsForCommit not exported).

- [ ] **Step 3: Implement in `src/git.ts`** (mirror how `logWithTrailers` spawns git — same spawn helper, cwd, error handling):

```typescript
/**
 * The paths a commit changed, relative to the repo root, vs its first parent.
 * `--root` makes the initial commit diff against the empty tree (reports all
 * its files). Mirrors the git-spawn discipline of logWithTrailers — git
 * spawning stays in this module.
 */
export async function changedPathsForCommit(opts: {
  readonly path: string;
  readonly sha: string;
}): Promise<ReadonlyArray<string>> {
  // diff-tree: no commit-id header, name-only, recurse into trees, root-aware.
  const out = await <the same spawn helper logWithTrailers uses>([
    "diff-tree", "--no-commit-id", "--name-only", "-r", "--root", opts.sha,
  ], opts.path);
  return Object.freeze(
    out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0),
  );
}
```
Match the exact spawn/exec helper and signature `logWithTrailers` uses (read it at ~733). Return `[]` on a commit with no changes.

- [ ] **Step 4: Run, expect PASS** — `bun test tests/git/changed-paths.test.ts`.

- [ ] **Step 5: Commit** — `git add src/git.ts tests/git/changed-paths.test.ts && git commit -m "feat(git): changedPathsForCommit — files a commit changed (diff-tree)"`.

---

## Task 2: `buildRecents` collector

**Files:** Create `src/surface/recents.ts`; Test `tests/surface/recents.test.ts`.

- [ ] **Step 1: Write the failing test** (fixture: `runInit` + real commits touching pages, mirroring `tests/surface/activity.test.ts`):

```typescript
// tests/surface/recents.test.ts
import { describe, expect, test } from "bun:test";
import { buildRecents } from "../../src/surface/recents";
// fixture helpers: runInit + git commits (copy the activity.test.ts setup)

describe("buildRecents", () => {
  test("dedups to the newest change per page, newest-first, over knowledge roots", async () => {
    // In a temp vault: commit 1 → wiki/entities/a.md; commit 2 → wiki/concepts/b.md;
    // commit 3 → wiki/entities/a.md again (edit). Also commit a wiki/dailies/<date>.md
    // and index.md (should be EXCLUDED).
    const recents = await buildRecents({ vault });
    const paths = recents.map((r) => r.path);
    expect(paths[0]).toBe("wiki/entities/a.md");   // most recently changed
    expect(paths).toContain("wiki/concepts/b.md");
    expect(paths).not.toContain("index.md");
    expect(paths.some((p) => p.startsWith("wiki/dailies/"))).toBe(false);
    // one entry per page (a.md not duplicated)
    expect(paths.filter((p) => p === "wiki/entities/a.md").length).toBe(1);
    const a = recents.find((r) => r.path === "wiki/entities/a.md")!;
    expect(typeof a.title).toBe("string");
    expect(a.changedBy === "human" || a.changedBy === "engine").toBe(true);
    expect(typeof a.lastChangedAt).toBe("string");
  });

  test("title comes from frontmatter description when present", async () => {
    // commit wiki/concepts/c.md with frontmatter `description: "One-line summary"`.
    const recents = await buildRecents({ vault });
    const c = recents.find((r) => r.path === "wiki/concepts/c.md")!;
    expect(c.title).toBe("One-line summary");
  });

  test("respects limit", async () => {
    const recents = await buildRecents({ vault, limit: 1 });
    expect(recents.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `bun test tests/surface/recents.test.ts`.

- [ ] **Step 3: Implement `src/surface/recents.ts`:**

```typescript
// surface/recents: "recently-touched knowledge pages" — the PWA recents panel.
// Runtime-free, git-derived (mirrors surface/activity). Per-page newest change
// over the knowledge roots; excludes dailies and generated/registry files.
import matter from "gray-matter";
import { changedPathsForCommit, logWithTrailers, readBlob } from "../git";
import { resolveVaultPath } from "./resolve-vault";

const DEFAULT_LIMIT = 20;
const COMMIT_SCAN_CAP = 400; // bound history walk; recents fills fast

export type RecentEntry = {
  readonly path: string;
  readonly title: string;
  readonly lastChangedAt: string;           // ISO, the commit time
  readonly changedBy: "human" | "engine";
  readonly subject: string;                 // the change's commit subject
};

const INCLUDE_PREFIXES = [
  "wiki/entities/", "wiki/concepts/", "wiki/sources/", "wiki/syntheses/", "notes/",
];
function isKnowledgePage(p: string): boolean {
  if (!p.endsWith(".md")) return false;
  if (p.startsWith("wiki/dailies/")) return false;
  return INCLUDE_PREFIXES.some((pre) => p.startsWith(pre));
}

async function titleFor(vault: string, sha: string, path: string): Promise<string> {
  const blob = await readBlob({ path: vault, oid: sha, filepath: path }).catch(() => null);
  const basename = path.split("/").pop() ?? path;
  if (blob === null) return basename;
  const text = typeof blob === "string" ? blob : new TextDecoder().decode(blob as Uint8Array);
  try {
    const fm = matter(text);
    const desc = fm.data?.["description"];
    if (typeof desc === "string" && desc.trim().length > 0) return desc.trim();
    const heading = fm.content.split("\n").find((l) => l.startsWith("# "));
    if (heading !== undefined) return heading.replace(/^#\s+/, "").trim();
  } catch { /* fall through */ }
  return basename;
}

export async function buildRecents(
  options: { readonly vault?: string | undefined; readonly limit?: number | undefined } = {},
): Promise<ReadonlyArray<RecentEntry>> {
  const vault = resolveVaultPath(options.vault);
  const limit = options.limit ?? DEFAULT_LIMIT;
  const commits = await logWithTrailers({ path: vault, limit: COMMIT_SCAN_CAP });

  const seen = new Set<string>();
  const out: RecentEntry[] = [];
  for (const commit of commits) {
    if (out.length >= limit) break;
    const paths = await changedPathsForCommit({ path: vault, sha: commit.sha });
    for (const p of paths) {
      if (out.length >= limit) break;
      if (!isKnowledgePage(p) || seen.has(p)) continue;
      seen.add(p);
      out.push(Object.freeze({
        path: p,
        title: await titleFor(vault, commit.sha, p),
        lastChangedAt: commit.at, // verify field name (activity uses commit.at as ISO)
        changedBy: commit.domeRun === null ? "human" : "engine",
        subject: commit.subject,
      }));
    }
  }
  return Object.freeze(out);
}
```
NOTE: verify `logWithTrailers`'s entry fields (`.sha`, `.at` (ISO?), `.subject`, `.domeRun`) and `readBlob`'s signature/return (string vs Uint8Array) against `src/git.ts`, and adjust. Keep the human/engine rule identical to `activity.ts` (`domeRun === null` → human).

- [ ] **Step 4: Run, expect PASS** — `bun test tests/surface/recents.test.ts`.

- [ ] **Step 5: Commit** — `git add src/surface/recents.ts tests/surface/recents.test.ts && git commit -m "feat(surface): buildRecents — recently-touched knowledge pages"`.

---

## Task 3: `GET /recents` route on the ask-server

**Files:** Modify `src/agent/server.ts`; Test `tests/agent/ask-server-data-routes.test.ts`.

- [ ] **Step 1: Write the failing test** (extend the existing data-routes fixture test):

```typescript
test("GET /recents returns recently-touched pages (dome.recents/v1)", async () => {
  // fixture vault already has commits from runInit + the test setup; if needed,
  // commit a wiki/entities/*.md so there's at least one knowledge page.
  const res = await fetch(`${baseUrl}/recents`, { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(res.status).toBe(200);
  const json = await res.json() as { schema: string; count: number; entries: unknown[] };
  expect(json.schema).toBe("dome.recents/v1");
  expect(Array.isArray(json.entries)).toBe(true);
  expect(json.count).toBe(json.entries.length);
});
test("GET /recents is 401 without a token", async () => {
  const res = await fetch(`${baseUrl}/recents`);
  expect(res.status).toBe(401);
});
test("GET /recents respects ?limit=", async () => {
  const res = await fetch(`${baseUrl}/recents?limit=1`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const json = await res.json() as { entries: unknown[] };
  expect(json.entries.length).toBeLessThanOrEqual(1);
});
```

- [ ] **Step 2: Run, expect FAIL** — `bun test tests/agent/ask-server-data-routes.test.ts` (no /recents route → 404).

- [ ] **Step 3: Implement** — add to `src/agent/server.ts`'s `routes()` switch a `GET /recents` case (runtime-free, like `/capture` — no `withVault`/mutex needed; `buildRecents` only reads git):

```typescript
if (route === "GET /recents") {
  const limit = positiveInt(url.searchParams.get("limit")) ?? undefined;
  const entries = await buildRecents({ vault: vaultPath, ...(limit !== undefined ? { limit } : {}) });
  return jsonResponse(200, { schema: "dome.recents/v1", count: entries.length, entries });
}
```
Import `buildRecents` from `../surface/recents`. Use the existing `positiveInt` helper + `jsonResponse`. Auth is already enforced before routing. Keep all other routes intact.

- [ ] **Step 4: Run, expect PASS** — `bun test tests/agent/ask-server-data-routes.test.ts`.

- [ ] **Step 5: Commit** — `git add src/agent/server.ts tests/agent/ask-server-data-routes.test.ts && git commit -m "feat(agent): GET /recents on the ask-server (PWA recents panel)"`.

---

## Task 4: Doc + full-suite verification

**Files:** Modify the architecture doc.

- [ ] **Step 1:** In `docs/cohesive/brainstorms/2026-06-16-hosted-agent-and-mobile-client.md`, update the "PWA backend topology" note: recents is now SHIPPED (`GET /recents` → `dome.recents/v1`, recently-touched knowledge pages), so the ask-server is the PWA's complete backend; remaining PWA work is the client + the always-on host.

- [ ] **Step 2: Fences + full suite** — `cd <worktree> && bun test tests/agent tests/surface tests/integration/bundle-deps.test.ts tests/integration/public-surface-shape.test.ts` (all pass — `src/surface/recents.ts` is pure git/fs, no LLM; reached fine), then `bun test 2>&1 | tail -5` (full suite green, same baseline).

- [ ] **Step 3: Typecheck** — `bunx tsc --noEmit 2>&1 | grep -i "src/surface/recents\|src/agent/server\|src/git\|tests/" || echo "recents clean"`.

- [ ] **Step 4: Commit** — `git add docs/cohesive/brainstorms/2026-06-16-hosted-agent-and-mobile-client.md && git commit -m "docs: recents route shipped — ask-server is the PWA's complete backend"`.

---

## Self-Review
- **Spec coverage:** design's recents = recently-touched knowledge pages, git-derived, human/engine labeled, title from `description`, excludes dailies/generated/inbox, default 20, `GET /recents` on the ask-server. Covered: changed-paths helper (T1), dedup/title/label/roots/limit (T2), route + envelope (T3), doc (T4). Deferred (recently-viewed, recent-captures) explicitly out of scope.
- **Placeholders:** the `> NOTE`s direct the implementer to verify real git API field names (`logWithTrailers` `.at`/`.domeRun`, `readBlob` return type, the git-spawn helper) and adopt the existing git/activity test fixture — verification steps, not missing logic.
- **Type consistency:** `RecentEntry` (T2) is the element of the `entries` array in the route (T3); `dome.recents/v1` schema string consistent T3↔T4; `buildRecents({vault, limit})` signature consistent T2↔T3.
- **Risk:** the only real fetch is `changedPathsForCommit` (T1, isolated + tested) and the per-commit scan cap (bounded). Title blob-read failures fall back to basename (no throw).
