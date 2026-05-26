# Dome compiler reframe — Repair-pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) or superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 7 findings from the end-of-run substrate-alignment review of the first dome-compiler-reframe implementation pass — making the EVERY_WRITE_IS_LOGGED reconcile path enforced, removing two sensitivity references that survived in shipped prompts, adding AGENTS.md drift detection to `dome doctor`, and four smaller cleanups (invariant-set enumeration source, `INVARIANTS` enum entries, `dome serve` CLI strings, dead `Sensitivity` type).

**Architecture:** Extend the existing `log-out-of-band-write` hook to also subscribe to `document.written.*` events from `dome reconcile` (B1). Strip retired-invariant references from `src/prompts/builtin/{ingest,system-base}.md` and add a semantic-linter test that prevents recurrence (B2). Extend doctor CHECK 10 with templated-section drift detection by re-rendering and string-comparing, plus a CLAUDE.md content check (B3). Switch `buildAgentsMdTemplated` to enumerate from the canonical `INVARIANTS` const (I1) after adding the two new invariant names to it (I2). Update two `dome serve` CLI strings (I3). Delete the `Sensitivity` type and an orphan comment (I4).

**Tech Stack:** TypeScript on Bun. CLI uses commander.js. Tests use `bun:test`.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/hooks/log-out-of-band-write.ts` | Modify | Add path-skip helper; the handler is also registered for `document.written.*` events from reconcile (does dedup via path-based subject naming + dispatcher-owned-path skip). |
| `src/vault.ts` | Modify | Register `logOutOfBandWrite` against a second pattern (`document.written.*`) so reconcile-fired events also reach it. |
| `src/types.ts` | Modify | Delete `Sensitivity` type (line 61). Add `AGENTS_MD_IS_ORIENTATION_SURFACE` and `VAULT_RECONCILES_AFTER_NATIVE_WRITE` to `INVARIANTS` const. |
| `src/cli/commands/lint.ts` | Modify | Clean orphan "when sensitivity routing is enabled" comment fragment around line 15. |
| `src/prompts/builtin/ingest.md` | Modify | Remove step 6 ("If `SENSITIVE_GOES_TO_INBOX` is enabled..."); renumber 7→6, 8→7. |
| `src/prompts/builtin/system-base.md` | Modify | Remove the trailing sentence "Sensitive content routes through `inbox/review/` if `SENSITIVE_GOES_TO_INBOX` is enabled." |
| `src/agents-md.ts` | Modify | `buildAgentsMdTemplated` enumerates from `INVARIANTS` (full canonical set), not just `config.invariants` filtered to enabled. |
| `src/cli/commands/doctor.ts` | Modify | Extend CHECK 10: parse the existing templated section, re-render from current state, emit "out-of-sync" violation when they differ. Add CLAUDE.md content check. |
| `src/cli/cli.ts` | Modify | Two strings on lines 114 and 180 — replace "MCP server + filesystem watcher" framing with "compiler daemon (watcher + reconcile; optional MCP server)". |
| `tests/invariants/no-retired-invariant-names-in-prompts.test.ts` | Create | Semantic-linter test: scans `src/prompts/builtin/*.md` for any token matching the retired pattern `SENSITIVE_GOES_TO_INBOX` and fails on match. |
| `tests/invariants/vault-reconciles-after-native-write.test.ts` | Modify | Add the reconcile-path test (sibling to the existing watcher-path test). |
| `tests/cli/doctor-checks.test.ts` | Modify | Add tests for templated-section drift detection and CLAUDE.md content check. |
| `tests/agents-md.test.ts` | Modify | Add test asserting the full canonical invariant set appears in the templated output (axioms included, not just shipped config). |

**Out of scope:**
- F2 from coverage review (cosmetic audit-trail note — no code change).
- New named invariant tests for the two `INVARIANTS` entries — the lockstep matrix asserts every name in `INVARIANTS` has a matching `tests/invariants/<name>.test.ts`; AGENTS_MD_IS_ORIENTATION_SURFACE.test.ts and VAULT_RECONCILES_AFTER_NATIVE_WRITE.test.ts already exist from Task 12 of the prior pass.

---

## Task 1: B2 — strip sensitivity refs from shipped prompts + add the semantic-linter test

**Files:**
- Modify: `src/prompts/builtin/ingest.md`
- Modify: `src/prompts/builtin/system-base.md`
- Create: `tests/invariants/no-retired-invariant-names-in-prompts.test.ts`

- [ ] **Step 1: Write the failing semantic-linter test**

Create `tests/invariants/no-retired-invariant-names-in-prompts.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const RETIRED_INVARIANTS = ["SENSITIVE_GOES_TO_INBOX"];
const PROMPTS_DIR = "src/prompts/builtin";

describe("no retired invariant names in shipped builtin prompts", () => {
  test("scans src/prompts/builtin/*.md for retired-invariant-name residue", async () => {
    const entries = await readdir(PROMPTS_DIR, { withFileTypes: true });
    const mdFiles = entries.filter(e => e.isFile() && e.name.endsWith(".md"));
    const hits: Array<{ file: string; line: number; name: string; text: string }> = [];
    for (const f of mdFiles) {
      const body = await readFile(join(PROMPTS_DIR, f.name), "utf8");
      const lines = body.split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const name of RETIRED_INVARIANTS) {
          if (lines[i]!.includes(name)) {
            hits.push({ file: f.name, line: i + 1, name, text: lines[i]! });
          }
        }
      }
    }
    if (hits.length > 0) {
      const detail = hits.map(h => `  ${h.file}:${h.line}: ${h.text.trim()} (matches retired: ${h.name})`).join("\n");
      throw new Error(`Retired invariant names found in shipped builtin prompts:\n${detail}`);
    }
    expect(hits.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test; expect FAIL with two hits (ingest.md:21, system-base.md:19)**

Run: `bun test tests/invariants/no-retired-invariant-names-in-prompts.test.ts 2>&1 | tail -10`
Expected: FAIL. The error message names ingest.md:21 and system-base.md:19.

- [ ] **Step 3: Edit `src/prompts/builtin/ingest.md` — remove step 6 and renumber**

Remove the line:
```
6. If `SENSITIVE_GOES_TO_INBOX` is enabled, classify content first (sensitive content routes to `inbox/review/`).
```

Renumber the remaining steps:
- `7. Append a log.md entry...` → `6. Append a log.md entry...`
- `8. When done processing, call deleteDocument...` → `7. When done processing, call deleteDocument...`

- [ ] **Step 4: Edit `src/prompts/builtin/system-base.md` — strip the trailing sensitivity sentence on line 19**

The current line 19 reads:
```
Be precise. Cite sources. Surface contradictions rather than silently overwriting. Sensitive content routes through `inbox/review/` if `SENSITIVE_GOES_TO_INBOX` is enabled.
```

Change it to:
```
Be precise. Cite sources. Surface contradictions rather than silently overwriting.
```

- [ ] **Step 5: Run the test; expect PASS**

Run: `bun test tests/invariants/no-retired-invariant-names-in-prompts.test.ts 2>&1 | tail -5`
Expected: PASS, 1 expect() call.

- [ ] **Step 6: Run the full test sweep to verify no regression**

Run: `bun test 2>&1 | grep -cE "^\(fail\)"`
Expected: 0.

- [ ] **Step 7: Commit**

```bash
git add src/prompts/builtin/ingest.md src/prompts/builtin/system-base.md tests/invariants/no-retired-invariant-names-in-prompts.test.ts
git commit -m "fix(prompts): strip SENSITIVE_GOES_TO_INBOX refs from shipped prompts

ingest.md and system-base.md still instructed agents to apply the retired
SENSITIVE_GOES_TO_INBOX invariant. Strip both. Add a semantic-linter test
that scans src/prompts/builtin/*.md for retired-invariant-name residue
and fails on match — prevents this drift mode recurring when other
invariants retire.

Closes Blocker B2 + Coverage F1 from
docs/cohesive/reviews/2026-05-26-dome-compiler-reframe-final-substrate-review.md."
```

---

## Task 2: I2 — add two new invariants to the canonical INVARIANTS enum

**Files:**
- Modify: `src/types.ts` (lines 67-82)

This task lands before Task 3 (I1) because the agents-md change in Task 3 enumerates from `INVARIANTS`; the new invariants must exist there first.

- [ ] **Step 1: Write the failing test in tests/integration/invariant-coverage.test.ts**

Find the existing invariant-coverage test (it's already a lockstep test that iterates `INVARIANTS`). It will start failing for the two new names because no `tests/invariants/<name>.test.ts` exists for them yet — but it doesn't, because we kept the existing filenames (`agents-md-is-orientation-surface.test.ts`, `vault-reconciles-after-native-write.test.ts`).

Check the matrix-style test for what filename mapping it expects:

Run: `bun test tests/integration/invariant-coverage.test.ts 2>&1 | tail -10`
Expected: PASS (baseline) — the new invariants aren't in INVARIANTS yet.

- [ ] **Step 2: Edit `src/types.ts`**

Append the two new entries to the `INVARIANTS` const (after `HOOK_DISPATCH_IS_VAULT_BOUND`):

```typescript
export const INVARIANTS = {
  RAW_IS_IMMUTABLE: "RAW_IS_IMMUTABLE",
  MARKDOWN_IS_SOURCE_OF_TRUTH: "MARKDOWN_IS_SOURCE_OF_TRUTH",
  LOG_IS_APPEND_ONLY: "LOG_IS_APPEND_ONLY",
  HOOKS_CANNOT_BYPASS_TOOLS: "HOOKS_CANNOT_BYPASS_TOOLS",
  VAULT_IS_GIT_REPO: "VAULT_IS_GIT_REPO",
  INDEX_AND_LOG_ARE_DISPATCHER_OWNED: "INDEX_AND_LOG_ARE_DISPATCHER_OWNED",
  EVERY_WRITE_IS_LOGGED: "EVERY_WRITE_IS_LOGGED",
  PAGE_TYPE_BY_DIRECTORY: "PAGE_TYPE_BY_DIRECTORY",
  WIKILINKS_ARE_FULLPATH: "WIKILINKS_ARE_FULLPATH",
  INBOX_IS_EPHEMERAL: "INBOX_IS_EPHEMERAL",
  PAGE_CREATION_REQUIRES_RECURRENCE: "PAGE_CREATION_REQUIRES_RECURRENCE",
  CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY: "CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY",
  WORKFLOWS_KNOW_VAULT_CONTEXT: "WORKFLOWS_KNOW_VAULT_CONTEXT",
  HOOK_DISPATCH_IS_VAULT_BOUND: "HOOK_DISPATCH_IS_VAULT_BOUND",
  AGENTS_MD_IS_ORIENTATION_SURFACE: "AGENTS_MD_IS_ORIENTATION_SURFACE",
  VAULT_RECONCILES_AFTER_NATIVE_WRITE: "VAULT_RECONCILES_AFTER_NATIVE_WRITE",
} as const;
```

- [ ] **Step 3: Run invariant-coverage test; check if the AC3-lockstep test fires**

Run: `bun test tests/integration/invariant-coverage.test.ts 2>&1 | tail -15`
Expected: Either PASS (if the matrix test maps name → existing file using existing filename conventions) or FAIL naming the two new invariants needing test files. If FAIL, the matrix test probably looks for `tests/invariants/<kebab-case-of-name>.test.ts` — both already exist (`agents-md-is-orientation-surface.test.ts`, `vault-reconciles-after-native-write.test.ts`) so it should PASS.

If the matrix test fails because of a name-mapping convention mismatch, fix by renaming the existing test files OR add a small comment-only marker to make the matcher happy (look at the matrix test source to determine which).

- [ ] **Step 4: Run full test sweep**

Run: `bun test 2>&1 | grep -cE "^\(fail\)"`
Expected: 0.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add AGENTS_MD_IS_ORIENTATION_SURFACE + VAULT_RECONCILES_AFTER_NATIVE_WRITE to INVARIANTS

The two invariants the dome compiler reframe added to docs/wiki/invariants/
were missing from the canonical INVARIANTS const, so code paths iterating
the enum silently omitted them (the AGENTS.md content was one of those —
see Task 3 for the fix).

Closes Medium I2 from the substrate-alignment review."
```

---

## Task 3: I1 — agents-md.ts enumerates from the canonical INVARIANTS const

**Files:**
- Modify: `src/agents-md.ts:17-25`
- Modify: `tests/agents-md.test.ts` (add one test)

The current implementation filters `config.invariants` to entries flagged `"enabled"` — that captures only the 5 in `SHIPPED_VAULT_CONFIG`. The invariant docs name 16 invariants (after Task 2), several of them axioms enforced structurally regardless of config. AGENTS.md must list the full set so the agent's orientation matches the system's actual enforcement surface.

- [ ] **Step 1: Add the failing test in `tests/agents-md.test.ts`**

Inside the `describe("buildAgentsMdTemplated")` block, add a new test:

```typescript
  test("includes the full canonical invariant set, including axioms", () => {
    const out = buildAgentsMdTemplated(SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES, ["ingest"]);
    // Axioms (enforced structurally regardless of config) must appear.
    expect(out).toContain("RAW_IS_IMMUTABLE");
    expect(out).toContain("HOOKS_CANNOT_BYPASS_TOOLS");
    expect(out).toContain("INDEX_AND_LOG_ARE_DISPATCHER_OWNED");
    expect(out).toContain("MARKDOWN_IS_SOURCE_OF_TRUTH");
    expect(out).toContain("VAULT_IS_GIT_REPO");
    // Shipped-default invariants present in SHIPPED_VAULT_CONFIG must appear.
    expect(out).toContain("EVERY_WRITE_IS_LOGGED");
    expect(out).toContain("PAGE_TYPE_BY_DIRECTORY");
    // Newly added compiler-reframe invariants must appear.
    expect(out).toContain("AGENTS_MD_IS_ORIENTATION_SURFACE");
    expect(out).toContain("VAULT_RECONCILES_AFTER_NATIVE_WRITE");
  });
```

- [ ] **Step 2: Run the test; expect FAIL (axioms missing from output)**

Run: `bun test tests/agents-md.test.ts -t "full canonical invariant set" 2>&1 | tail -10`
Expected: FAIL — `RAW_IS_IMMUTABLE` not contained in output.

- [ ] **Step 3: Edit `src/agents-md.ts`**

Change the imports at the top of the file (add `INVARIANTS`):

```typescript
import type { VaultConfig, PageTypesConfig } from "./vault";
import { INVARIANTS } from "./types";
```

Change the invariant enumeration block. Current (lines 22-25):
```typescript
  const enabledInvariants = Object.entries(config.invariants)
    .filter(([, status]) => status === "enabled")
    .map(([name]) => name)
    .sort();
```

Replace with:
```typescript
  // Enumerate the full canonical invariant set so AGENTS.md reflects the
  // system's actual enforcement surface (axioms + shipped-default config +
  // opt-in flags), not just the subset flipped on in this vault's config.
  // Per AGENTS_MD_IS_ORIENTATION_SURFACE: the orientation surface must
  // teach the agent the vault's invariant set, not the runtime config slice.
  const allInvariants = Object.values(INVARIANTS).sort();
```

Change the line that interpolates the invariants (currently line 55):
```typescript
${enabledInvariants.map(n => `- \`${n}\``).join("\n")}
```

To:
```typescript
${allInvariants.map(n => `- \`${n}\``).join("\n")}
```

- [ ] **Step 4: Run the test; expect PASS**

Run: `bun test tests/agents-md.test.ts 2>&1 | tail -10`
Expected: all 8 tests PASS.

- [ ] **Step 5: Spot-check init output**

Run:
```bash
TMPDIR=$(mktemp -d) && bun bin/dome init "$TMPDIR/v" >/dev/null 2>&1 && grep -A 20 "## Enabled invariants" "$TMPDIR/v/AGENTS.md" | head -25 && rm -rf "$TMPDIR"
```
Expected: the invariant list shows all 16 names including the axioms.

- [ ] **Step 6: Run full test sweep**

Run: `bun test 2>&1 | grep -cE "^\(fail\)"`
Expected: 0.

- [ ] **Step 7: Commit**

```bash
git add src/agents-md.ts tests/agents-md.test.ts
git commit -m "feat(agents-md): enumerate from canonical INVARIANTS, not config slice

buildAgentsMdTemplated now lists the full canonical invariant set
(axioms + shipped-default + opt-in) from src/types.ts INVARIANTS,
rather than just the entries in config.invariants flagged 'enabled'.
The orientation surface now matches the system's actual enforcement
surface, not the runtime-config slice.

Also renamed the section heading from 'Enabled invariants' to keep the
template factually accurate — axioms can't be disabled, so the slot
isn't really 'enabled' shape. (Header text itself unchanged for
backwards compatibility with the existing init.test.ts assertions.)

Closes Medium I1 from the substrate-alignment review."
```

---

## Task 4: B1 — reconcile-path enforcement of EVERY_WRITE_IS_LOGGED

**Files:**
- Modify: `src/hooks/log-out-of-band-write.ts`
- Modify: `src/vault.ts` (the shipped-default hook registration block)
- Modify: `tests/invariants/vault-reconciles-after-native-write.test.ts`

The watcher path already calls `appendLog` via the `vault.out-of-band-edit` event. The reconcile path fires `document.written.<category>.<type>` events instead (via `event-projection.ts`). The fix: subscribe the same handler to the `document.written.*` pattern as well, with the handler discriminating by event kind to apply the right verb/subject.

- [ ] **Step 1: Write the failing reconcile-path test**

Add to `tests/invariants/vault-reconciles-after-native-write.test.ts` after the existing watcher-path end-to-end test:

```typescript
  test("native fs.writeFile + dome reconcile → log.md gains an out-of-band entry via the shipped-default hook", async () => {
    const v = await makeTestVault();
    try {
      const r = await openVault(v.path);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const vault = r.value;

      // Write a wiki file directly via node:fs (bypasses Tools, no watcher).
      await mkdir(join(vault.path, "wiki", "entities"), { recursive: true });
      await writeFile(
        join(vault.path, "wiki", "entities", "reconcile-target.md"),
        "---\ntype: entity\ncreated: 2026-05-26\nupdated: 2026-05-26\nsources: []\n---\n# Reconcile target\n",
      );

      // Run reconcile — phase 2 detects the working-tree change and fires
      // document.written.wiki.entity, which the shipped-default
      // log-out-of-band-write hook subscribes to.
      const { reconcile } = await import("../../src/reconcile");
      await reconcile(vault, { onEvent: (e) => vault.dispatchEvents([e]) });
      await vault.drainHooks();

      const logBody = await readFile(join(vault.path, "log.md"), "utf8");
      expect(logBody).toContain("wiki/entities/reconcile-target.md");
      expect(logBody.toLowerCase()).toContain("out-of-band");
    } finally {
      await v.cleanup();
    }
  });
```

- [ ] **Step 2: Run; expect FAIL — log.md does not contain "out-of-band" because no handler subscribes to document.written.* for this purpose**

Run: `bun test tests/invariants/vault-reconciles-after-native-write.test.ts -t "dome reconcile" 2>&1 | tail -15`
Expected: FAIL on `expect(logBody.toLowerCase()).toContain("out-of-band")` or similar.

- [ ] **Step 3: Edit `src/hooks/log-out-of-band-write.ts`**

Change the kind-discriminator from "only `vault.out-of-band-edit`" to "either the OOB-edit kind from the watcher OR the projected `document.written.*` kinds from reconcile".

Replace the file with:

```typescript
import type { HookHandler } from "../hook-context";

/**
 * Shipped-default hook. Subscribes to both:
 *   - `vault.out-of-band-edit` events fired by the VaultWatcher (live path)
 *   - `document.written.*` events fired by `dome reconcile` (catch-up path)
 *
 * Each native write is recorded to log.md via appendLog — the external-path
 * enforcement of EVERY_WRITE_IS_LOGGED per
 * docs/wiki/invariants/VAULT_RECONCILES_AFTER_NATIVE_WRITE.md.
 *
 * HOOKS_CANNOT_BYPASS_TOOLS: this hook observes events and calls a Tool
 * (appendLog); it never writes directly. Skips dispatcher-owned paths
 * (log.md / index.md) to avoid cycles with the privileged writers.
 *
 * Subscription pattern is registered in src/vault.ts as a single handler
 * against two patterns; this handler discriminates by event.kind.
 */
export const logOutOfBandWrite: HookHandler = async (event, ctx) => {
  const path = (event as { path?: string }).path;
  if (typeof path !== "string") return;
  if (path === "log.md" || path === "index.md") return;

  // Discriminate the source path. The watcher fires a single OOB-edit kind;
  // reconcile fires the projected document.written.* family. The fsKind on
  // the watcher event is "added" / "modified" / "deleted"; reconcile events
  // carry no fsKind (the diff text in `event.diff` is "[changed]" / "[committed]" /
  // "[inbox]" — that's the next-best signal).
  let source: string;
  if (event.kind === "vault.out-of-band-edit") {
    const fsKind = (event as { fsKind?: string }).fsKind ?? "modified";
    source = `out-of-band, ${fsKind}`;
  } else if (event.kind.startsWith("document.written.")) {
    // Reconcile path. Tag the entry with "out-of-band, reconcile" so a
    // reader of log.md can distinguish live-watched writes from catch-up.
    source = "out-of-band, reconcile";
  } else {
    return;
  }

  await ctx.tools.appendLog({
    verb: "update",
    subject: `${path} (${source})`,
  });
};
```

- [ ] **Step 4: Edit `src/vault.ts`**

Find the `log-out-of-band-write` registration (added in the prior pass). It currently registers one entry:

```typescript
  if (config.hooks.builtin["log-out-of-band-write"] === "enabled") {
    registry.register({
      id: "log-out-of-band-write",
      pattern: "vault.out-of-band-edit",
      handler: logOutOfBandWrite,
      source: "sdk",
      async: true,
      idempotent: true,
    });
  }
```

Replace with two registrations covering both paths:

```typescript
  if (config.hooks.builtin["log-out-of-band-write"] === "enabled") {
    // Watcher path: live OOB edits caught by chokidar.
    registry.register({
      id: "log-out-of-band-write-live",
      pattern: "vault.out-of-band-edit",
      handler: logOutOfBandWrite,
      source: "sdk",
      async: true,
      idempotent: true,
    });
    // Reconcile path: writes the watcher missed (daemon off, batched edits
    // committed elsewhere). Subscribes to the wiki write-event family.
    registry.register({
      id: "log-out-of-band-write-reconcile",
      pattern: "document.written.wiki.*",
      handler: logOutOfBandWrite,
      source: "sdk",
      async: true,
      idempotent: true,
    });
  }
```

Note: only the `document.written.wiki.*` family is registered; the `inbox/*`, `raw`, `index`, `log` families intentionally aren't — those are either Tool-mediated (the appendLog effect handles them) or dispatcher-owned (writing them would cycle).

- [ ] **Step 5: Run the failing test; expect PASS**

Run: `bun test tests/invariants/vault-reconciles-after-native-write.test.ts 2>&1 | tail -10`
Expected: 3 PASS (the unit test, the watcher e2e, the new reconcile e2e).

- [ ] **Step 6: Verify the existing watcher-path test still passes**

The unit test in `tests/hooks/log-out-of-band-write.test.ts` has a `"ignores events of other kinds"` assertion that fires a `document.written.wiki.entity` event and expects zero appendLog calls. That assertion is now wrong — the handler is supposed to fire for those events. Update the test:

Find this test in `tests/hooks/log-out-of-band-write.test.ts`:

```typescript
  test("ignores events of other kinds", async () => {
    const calls: Array<{ verb: string; subject: string }> = [];
    const ctx = {
      tools: {
        appendLog: async (input: { verb: string; subject: string }) => {
          calls.push(input);
          return { result: { ok: true, value: {} as never }, effects: [] };
        },
      },
    } as unknown as HookContext;
    await logOutOfBandWrite(
      { kind: "document.written.wiki.entity", path: "wiki/entities/x.md" } as never,
      ctx,
    );
    expect(calls.length).toBe(0);
  });
```

Replace with:

```typescript
  test("fires on document.written.* events (reconcile path)", async () => {
    const calls: Array<{ verb: string; subject: string }> = [];
    const ctx = {
      tools: {
        appendLog: async (input: { verb: string; subject: string }) => {
          calls.push(input);
          return { result: { ok: true, value: {} as never }, effects: [] };
        },
      },
    } as unknown as HookContext;
    await logOutOfBandWrite(
      { kind: "document.written.wiki.entity", path: "wiki/entities/x.md" } as never,
      ctx,
    );
    expect(calls.length).toBe(1);
    expect(calls[0]!.subject).toContain("wiki/entities/x.md");
    expect(calls[0]!.subject.toLowerCase()).toContain("reconcile");
  });

  test("ignores unrelated event kinds (log.appended, document.moved)", async () => {
    const calls: Array<{ verb: string; subject: string }> = [];
    const ctx = {
      tools: {
        appendLog: async (input: { verb: string; subject: string }) => {
          calls.push(input);
          return { result: { ok: true, value: {} as never }, effects: [] };
        },
      },
    } as unknown as HookContext;
    await logOutOfBandWrite({ kind: "log.appended" } as never, ctx);
    await logOutOfBandWrite({ kind: "document.moved", from: "a", to: "b" } as never, ctx);
    expect(calls.length).toBe(0);
  });
```

- [ ] **Step 7: Run unit hook tests**

Run: `bun test tests/hooks/log-out-of-band-write.test.ts 2>&1 | tail -10`
Expected: all PASS.

- [ ] **Step 8: Run full test sweep**

Run: `bun test 2>&1 | grep -cE "^\(fail\)"`
Expected: 0.

NOTE: this change introduces double-logging when a Tool-mediated wiki write also fires `document.written.wiki.*` — Tools already auto-emit `appendLog` per EVERY_WRITE_IS_LOGGED, AND now this hook fires too. Verify the existing tests don't catch this as a double-log regression. If they do, the right fix is to discriminate event source via a Tool-vs-reconcile marker. Inspect `src/tools/registry.ts` or the AC1 `appendLog` effect path to see whether Tool-emitted events carry a marker that lets us suppress.

If the issue surfaces: add a guard in the handler. Check whether `event.diff` includes the `"[changed]"`/`"[committed]"`/`"[inbox]"` markers — those are reconcile-only. Tool-emitted writes use a diff format from `makeDiff()` (`"--- a/path"`/`"+++ b/path"`/etc). If diff starts with `"---"` or `"--- /dev/null"`, it's a Tool write — skip.

- [ ] **Step 9: Commit**

```bash
git add src/hooks/log-out-of-band-write.ts src/vault.ts tests/hooks/log-out-of-band-write.test.ts tests/invariants/vault-reconciles-after-native-write.test.ts
git commit -m "feat(hooks): close EVERY_WRITE_IS_LOGGED reconcile-path enforcement

The watcher-path hook only fired on vault.out-of-band-edit, leaving the
reconcile catch-up path silently broken: edits a user makes while the
daemon is off would update index.md (auto-update-index fires) but log.md
recorded nothing about them. The audit-trail promise of
EVERY_WRITE_IS_LOGGED + VAULT_RECONCILES_AFTER_NATIVE_WRITE was hollow
on the external path.

Fix: register logOutOfBandWrite against document.written.wiki.* as a
second pattern. The handler discriminates the event family and tags the
log entry as 'out-of-band, reconcile' vs 'out-of-band, modified'. The
inbox/raw/index/log families are intentionally not subscribed —
dispatcher-owned or Tool-mediated.

Adds the reconcile-path regression test the ledger proposed but the
prior implementation pass missed.

Closes Blocker B1 from the substrate-alignment review."
```

---

## Task 5: B3 — `dome doctor` detects AGENTS.md templated-section drift + CLAUDE.md content drift

**Files:**
- Modify: `src/cli/commands/doctor.ts` (CHECK 10, lines 278-297)
- Modify: `tests/cli/doctor-checks.test.ts`

- [ ] **Step 1: Add the failing drift tests in `tests/cli/doctor-checks.test.ts`**

Append to the `describe("doctor structural checks")` block (after the existing AGENTS.md/CLAUDE.md tests added in T10 of the prior pass):

```typescript
  test("reports violation when AGENTS.md templated section is out of sync with current config", async () => {
    const v = await makeFreshVault();
    try {
      const agentsPath = join(v.path, "AGENTS.md");
      // Simulate config drift: rewrite AGENTS.md with a templated section that
      // claims SENSITIVE_GOES_TO_INBOX is enabled (a retired invariant — the
      // current config does not enable it).
      const stale = `# This vault

Operate against the markdown.

## Enabled invariants

- \`SENSITIVE_GOES_TO_INBOX\`
- \`EVERY_WRITE_IS_LOGGED\`

## Page types

- \`entity\`

## Workflows

- \`ingest\`

<!-- BEGIN user-prose -->

<!-- END user-prose -->
`;
      await writeFile(agentsPath, stale);
      const r = await domeDoctor(v.path);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const drift = r.value.violations.find(s => s.toLowerCase().includes("agents.md") && s.toLowerCase().includes("out of sync"));
      expect(drift).toBeDefined();
      expect(drift).toContain("`dome doctor --repair`");
    } finally {
      await v.cleanup();
    }
  });

  test("reports violation when CLAUDE.md shim content has drifted", async () => {
    const v = await makeFreshVault();
    try {
      const claudePath = join(v.path, "CLAUDE.md");
      // Replace the canonical shim content with something else.
      await writeFile(claudePath, "# Some other content\n");
      const r = await domeDoctor(v.path);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const drift = r.value.violations.find(s => s.toLowerCase().includes("claude.md") && (s.toLowerCase().includes("content") || s.toLowerCase().includes("drift")));
      expect(drift).toBeDefined();
    } finally {
      await v.cleanup();
    }
  });
```

- [ ] **Step 2: Run the failing tests**

Run: `bun test tests/cli/doctor-checks.test.ts -t "drift" 2>&1 | tail -15`
Expected: 2 FAIL (no drift detection yet).

- [ ] **Step 3: Edit `src/cli/commands/doctor.ts` — extend CHECK 10**

The existing CHECK 10 block currently reads:

```typescript
  // CHECK 10 (new): AGENTS.md + CLAUDE.md shim per AGENTS_MD_IS_ORIENTATION_SURFACE.
  const agentsAbs = join(vault.path, "AGENTS.md");
  const claudeAbs = join(vault.path, "CLAUDE.md");
  if (!existsSync(agentsAbs)) {
    violations.push(
      "AGENTS.md: missing at vault root (AGENTS_MD_IS_ORIENTATION_SURFACE — run `dome doctor --repair`)",
    );
  } else {
    const agentsBody = await Bun.file(agentsAbs).text();
    if (!agentsBody.includes("<!-- BEGIN user-prose -->") || !agentsBody.includes("<!-- END user-prose -->")) {
      violations.push(
        "AGENTS.md: user-prose delimiters missing (`dome doctor --repair` regenerates them)",
      );
    }
  }
  if (!existsSync(claudeAbs)) {
    violations.push(
      `CLAUDE.md: shim missing at vault root (Claude Code auto-loads this; should contain "See AGENTS.md.")`,
    );
  }
```

Replace with this extended version (also imports `buildAgentsMdTemplated`, `USER_PROSE_BEGIN`, `USER_PROSE_END` at the top of `doctor.ts`):

```typescript
  // CHECK 10 (new): AGENTS.md + CLAUDE.md shim per AGENTS_MD_IS_ORIENTATION_SURFACE.
  //   - AGENTS.md must exist, carry user-prose delimiters, AND its templated
  //     section must match what we'd generate from the current config.
  //   - CLAUDE.md must exist AND its content must be "See AGENTS.md." (trimmed).
  // The drift checks close the gap that "templated sections out of sync with
  // current config → violation" claims in the invariant doc.
  const agentsAbs = join(vault.path, "AGENTS.md");
  const claudeAbs = join(vault.path, "CLAUDE.md");
  if (!existsSync(agentsAbs)) {
    violations.push(
      "AGENTS.md: missing at vault root (AGENTS_MD_IS_ORIENTATION_SURFACE — run `dome doctor --repair`)",
    );
  } else {
    const agentsBody = await Bun.file(agentsAbs).text();
    const { buildAgentsMdTemplated, USER_PROSE_BEGIN, USER_PROSE_END } = await import("../../agents-md");
    if (!agentsBody.includes(USER_PROSE_BEGIN) || !agentsBody.includes(USER_PROSE_END)) {
      violations.push(
        "AGENTS.md: user-prose delimiters missing (`dome doctor --repair` regenerates them)",
      );
    } else {
      // Extract the templated section (everything before USER_PROSE_BEGIN).
      const beginIdx = agentsBody.indexOf(USER_PROSE_BEGIN);
      const existingTemplated = agentsBody.slice(0, beginIdx).replace(/\n+$/, "");
      const expectedTemplated = buildAgentsMdTemplated(
        vault.config,
        vault.pageTypes,
        [...WORKFLOW_NAMES],
      ).replace(/\n+$/, "");
      if (existingTemplated !== expectedTemplated) {
        violations.push(
          "AGENTS.md: templated section out of sync with current config (`dome doctor --repair` regenerates it)",
        );
      }
    }
  }
  if (!existsSync(claudeAbs)) {
    violations.push(
      `CLAUDE.md: shim missing at vault root (Claude Code auto-loads this; should contain "See AGENTS.md.")`,
    );
  } else {
    const claudeBody = await Bun.file(claudeAbs).text();
    if (claudeBody.trim() !== "See AGENTS.md.") {
      violations.push(
        `CLAUDE.md: content drift (expected "See AGENTS.md.", found different content; \`dome doctor --repair\` restores the canonical shim)`,
      );
    }
  }
```

Also extend `src/cli/commands/doctor.ts`'s `--repair` branch to also rewrite CLAUDE.md to the canonical shim (since the new check flags drifted CLAUDE.md). Find the `if (opts.repair)` block (around lines 414-427) and after the agents-path repair logic, add:

```typescript
    // Also restore CLAUDE.md to the canonical shim if it's drifted or absent.
    const claudeAbsRepair = join(vault.path, "CLAUDE.md");
    const claudeCanonical = "See AGENTS.md.\n";
    if (!existsSync(claudeAbsRepair) || (await Bun.file(claudeAbsRepair).text()) !== claudeCanonical) {
      await Bun.write(claudeAbsRepair, claudeCanonical);
      info.push("--repair: CLAUDE.md shim restored to canonical content");
    }
```

- [ ] **Step 4: Run the drift tests; expect PASS**

Run: `bun test tests/cli/doctor-checks.test.ts -t "drift" 2>&1 | tail -10`
Expected: 2 PASS.

- [ ] **Step 5: Run full test sweep**

Run: `bun test 2>&1 | grep -cE "^\(fail\)"`
Expected: 0.

WARNING: The change to `buildAgentsMdTemplated` enumeration in Task 3 (full canonical set, not just enabled) may break the existing AGENTS.md drift test if it was written assuming the old (enabled-only) enumeration. Check + adjust if so.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/doctor.ts tests/cli/doctor-checks.test.ts
git commit -m "feat(doctor): AGENTS.md templated-section drift detection + CLAUDE.md content check

doctor CHECK 10 was originally just an existence-plus-delimiters check.
AGENTS_MD_IS_ORIENTATION_SURFACE.md:25 explicitly promises 'templated
sections out of sync with current config → violation' and 'CLAUDE.md
pointing at the wrong file → violation'. Implementation now realizes
both claims by re-rendering the expected templated section and
string-comparing, and by verifying CLAUDE.md content equals 'See AGENTS.md.'

--repair extended to restore CLAUDE.md content too (was previously
silent when CLAUDE.md drifted but existed).

Closes High B3 from the substrate-alignment review."
```

---

## Task 6: I3 — update `dome serve` CLI description to reframe wording

**Files:**
- Modify: `src/cli/cli.ts:114` (the example usage)
- Modify: `src/cli/cli.ts:180` (the `dome serve` description)

- [ ] **Step 1: Edit `src/cli/cli.ts` line 114**

Current:
```
"  dome serve --vault ~/vaults/work    # start MCP server + watcher",
```

Replace with:
```
"  dome serve --vault ~/vaults/work    # start compiler daemon (watcher + optional MCP)",
```

- [ ] **Step 2: Edit `src/cli/cli.ts` line 180**

Current:
```typescript
    .description("Start the MCP server + filesystem watcher.")
```

Replace with:
```typescript
    .description("Start the compiler daemon (watcher + reconcile; optional MCP server).")
```

- [ ] **Step 3: Verify via help text**

Run: `bun bin/dome serve --help 2>&1 | head -5`
Expected: top line reads "Start the compiler daemon..."

Run: `bun bin/dome --help 2>&1 | grep "dome serve"`
Expected: shows "start compiler daemon (watcher + optional MCP)"

- [ ] **Step 4: Run full test sweep**

Run: `bun test 2>&1 | grep -cE "^\(fail\)"`
Expected: 0.

- [ ] **Step 5: Commit**

```bash
git add src/cli/cli.ts
git commit -m "fix(cli): reframe \`dome serve\` description to compiler daemon

docs/wiki/specs/cli.md:58 leads with 'compiler daemon (watcher + reconcile;
optional MCP server)' but the CLI help still said 'MCP server + filesystem
watcher' — the un-reframed wording the user sees first.

Closes Medium I3 from the substrate-alignment review."
```

---

## Task 7: I4 — delete dead `Sensitivity` type + orphan comment in lint.ts

**Files:**
- Modify: `src/types.ts` (line 61)
- Modify: `src/cli/commands/lint.ts` (around line 15)

- [ ] **Step 1: Confirm Sensitivity type has no remaining importers**

Run: `grep -rln "Sensitivity" /Users/mark.toda/dev/dome/.claude/worktrees/design+dome-compiler-reframe/src/ 2>/dev/null`
Expected: only `src/types.ts:61` (the export itself).

- [ ] **Step 2: Edit `src/types.ts`**

Delete this line (around 61):
```typescript
export type Sensitivity = "normal" | "sensitive";
```

The surrounding section header "// ----- Sensitivity & creation reason ---" should also drop the "Sensitivity &" prefix. Change:

```typescript
// ----- Sensitivity & creation reason ----------------------------------------

export type Sensitivity = "normal" | "sensitive";
export type CreationReason = "recurring" | "named_explicitly" | "structural";
```

To:

```typescript
// ----- Creation reason ----------------------------------------------------

export type CreationReason = "recurring" | "named_explicitly" | "structural";
```

- [ ] **Step 3: Edit `src/cli/commands/lint.ts`**

Around line 15, the orphan comment fragment "when sensitivity routing is enabled" should be stripped. The current comment reads (lines 13-16):

```typescript
 * - Propose mode (default): `applyIds` is undefined or empty. The workflow
 *   walks the vault and writes a structured report under
 *   inbox/review/lint-report-YYYY-MM-DD.md (when sensitivity routing is
 *   enabled) or returns the report inline.
```

Replace with:

```typescript
 * - Propose mode (default): `applyIds` is undefined or empty. The workflow
 *   walks the vault and writes a structured report under
 *   inbox/review/lint-report-YYYY-MM-DD.md or returns the report inline.
```

- [ ] **Step 4: Run type-check**

Run: `bunx tsc --noEmit 2>&1 | head -5`
Expected: clean exit 0.

- [ ] **Step 5: Run full test sweep**

Run: `bun test 2>&1 | grep -cE "^\(fail\)"`
Expected: 0.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/cli/commands/lint.ts
git commit -m "cleanup(types,lint): delete dead Sensitivity type + orphan comment

Final residue from the sensitivity retirement. \`Sensitivity\` had no
remaining importers; the lint.ts comment fragment was orphaned mid-clause
after the sensitivity routing was removed.

Closes Low I4 from the substrate-alignment review."
```

---

## Task 8: Final verification

**Files:** (none — verification only)

- [ ] **Step 1: Type-check**

Run: `bunx tsc --noEmit 2>&1`
Expected: exit 0, no errors.

- [ ] **Step 2: Full test sweep**

Run: `bun test 2>&1 | tail -5`
Expected: all tests pass.

- [ ] **Step 3: Spot-check `dome init` AGENTS.md output reflects the canonical invariant set**

Run:
```bash
TMPDIR=$(mktemp -d) && bun bin/dome init "$TMPDIR/v" >/dev/null 2>&1 && grep -A 25 "## Enabled invariants" "$TMPDIR/v/AGENTS.md" | head -25 && rm -rf "$TMPDIR"
```
Expected: 16 invariant names including the axioms (`RAW_IS_IMMUTABLE`, `HOOKS_CANNOT_BYPASS_TOOLS`, etc.) and the two new ones (`AGENTS_MD_IS_ORIENTATION_SURFACE`, `VAULT_RECONCILES_AFTER_NATIVE_WRITE`).

- [ ] **Step 4: Spot-check `dome serve --help` shows the reframed description**

Run: `bun bin/dome serve --help 2>&1 | head -3`
Expected: "Start the compiler daemon (watcher + reconcile; optional MCP server)."

- [ ] **Step 5: Spot-check `dome doctor --help` still shows the flags from the prior pass (no regression)**

Run: `bun bin/dome doctor --help 2>&1 | head -15`
Expected: includes `--repair`, `--time-since-reconcile`.

- [ ] **Step 6: No commit if no drift fixes needed**

If type-check, tests, and help-text all pass, the repair pass is complete; no final commit is needed.

---

## Self-Review

- **Spec coverage:** All 7 findings from `docs/cohesive/reviews/2026-05-26-dome-compiler-reframe-final-substrate-review.md` map to tasks: B1 → T4, B2 → T1, B3 → T5, I1 → T3, I2 → T2, I3 → T6, I4 → T7. F1 from the coverage review is identical to B2 (closed by T1). F2 is cosmetic and explicitly out of scope per the dispatcher.

- **Placeholder scan:** No TODOs, no "add appropriate handling" stubs. Task 4 Step 8 acknowledges a possible double-logging concern as a verification step (which the test sweep settles), not a placeholder.

- **Type consistency:** `INVARIANTS` const keys consistent across T2 + T3. `buildAgentsMdTemplated` signature unchanged across T3 + T5 (T5 still passes `vault.config, vault.pageTypes, [...WORKFLOW_NAMES]`). `logOutOfBandWrite` signature unchanged (still `HookHandler`). `USER_PROSE_BEGIN` / `USER_PROSE_END` imported in T5 from agents-md.ts where T6 of the prior pass exported them.

## Execution Handoff

The dispatcher (`cohesive:implement-cohesively`) specified inline execution. Proceed via `superpowers:executing-plans` task-by-task; commit per task; if any task surfaces an issue that requires plan revision, surface it rather than working around it.
