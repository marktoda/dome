# Dome compiler reframe — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) or superpowers:subagent-driven-development (one fresh subagent per task) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the locked compiler-reframe design true in code — generate AGENTS.md from vault config in `dome init`, add `dome doctor --repair` / drift checks / `--time-since-reconcile`, register a shipped-default watcher-driven `appendLog` hook for native writes, ship `inbox/review/` as a default directory, and delete code-side sensitivity plumbing.

**Architecture:** A new `src/agents-md.ts` module owns the AGENTS.md content shape (templated-section generator + delimiter-preserving merger). `src/cli/commands/init.ts` calls the generator. `src/cli/commands/doctor.ts` gains three new opts (`agentsRepair`, `timeSinceReconcile`, plus a new drift check in the existing walk). `src/hooks/log-out-of-band-write.ts` is the new shipped-default hook for `vault.out-of-band-edit`. Sensitivity removal touches `src/types.ts`, `src/shipped-defaults.ts`, `src/tools/write-document.ts`, `src/tools/schemas.ts`, `src/abstract-surface.ts` — straightforward deletions, no refactor.

**Tech Stack:** TypeScript on Bun. CLI uses commander.js. Tests use `bun:test`.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/agents-md.ts` | Create | Templated-section generator (`buildAgentsMdTemplated(config, pageTypes, workflowNames)`); delimiter parser + merger (`mergeAgentsMd(existing, templated)`); delimiter constants (`USER_PROSE_BEGIN`, `USER_PROSE_END`). |
| `src/cli/commands/init.ts` | Modify | Use the new generator instead of the hardcoded `SHIPPED_AGENTS_MD` string. Pass `vault.config` + `pageTypes` + workflow-name list. |
| `src/vault-scaffold.ts` | Modify | Add `inbox/review/` to the directory list. |
| `src/cli/commands/doctor.ts` | Modify | Add three new opts: `agentsRepair`, `timeSinceReconcile`. Add the AGENTS.md drift check to the existing walk. Drop the stale `SENSITIVE_GOES_TO_INBOX` reference in the `--show review-queue` message. |
| `src/cli/cli.ts` | Modify | Wire two new commander flags: `--repair` and `--time-since-reconcile` on `dome doctor`. |
| `src/hooks/log-out-of-band-write.ts` | Create | The new shipped-default hook handler that fires `appendLog` with `source: 'out-of-band'` on `vault.out-of-band-edit` events. |
| `src/shipped-defaults.ts` | Modify | Remove `SENSITIVE_GOES_TO_INBOX`. Add `log-out-of-band-write` to the `hooks.builtin` registry. |
| `src/types.ts` | Modify | Remove `SENSITIVE_GOES_TO_INBOX` from `INVARIANTS` const. Remove `sensitive-must-route-to-inbox` from `ToolError`. Keep `Sensitivity` type (it's referenced by a test fixture; harmless to retain). |
| `src/tools/write-document.ts` | Modify | Remove `sensitivity_classified` from input opts shape. Remove the SENSITIVE_GOES_TO_INBOX check codepath. |
| `src/tools/schemas.ts` | Modify | Remove `sensitivity_classified` from the zod schema + opts processing. |
| `src/abstract-surface.ts` | Modify | Drop the sensitivity-classify comment. |
| `tests/cli/init.test.ts` | Modify | Update existing AGENTS.md test for the new templated content + delimiters. Add a test for the user-prose delimiter pair. |
| `tests/cli/doctor-flags.test.ts` | Modify | Add tests for `--time-since-reconcile` and `--repair`. |
| `tests/cli/doctor-checks.test.ts` | Modify | Add tests for the AGENTS.md drift check. |
| `tests/agents-md.test.ts` | Create | Unit tests for `buildAgentsMdTemplated` and `mergeAgentsMd`. |
| `tests/hooks/log-out-of-band-write.test.ts` | Create | Test the new hook handler fires `appendLog` with `source: 'out-of-band'`. |
| `tests/invariants/vault-reconciles-after-native-write.test.ts` | Create | Regression test for the new axiom (native `fs.writeFile` → watcher fires → hook → `log.md` updated). |
| `tests/invariants/agents-md-is-orientation-surface.test.ts` | Create | Regression test for the new shipped-default invariant (init writes it; --repair regenerates while preserving user-prose). |

**Out of scope** (Deferred per delta ledger):
- Native mobile/desktop/web/voice client implementations.
- The "exact AGENTS.md content template" — this plan locks the *shape* (sections + delimiters); the exact prose per section is implementer judgment within the shape's constraints.

---

## Task 1: Remove `SENSITIVE_GOES_TO_INBOX` from `src/types.ts`

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Run baseline test sweep**

Run: `bun test 2>&1 | grep -cE "^\(fail\)"`
Expected: 0 fails (baseline clean before changes).

- [ ] **Step 2: Edit `src/types.ts`**

Remove these lines from the `INVARIANTS` const (around line 79):

```typescript
  SENSITIVE_GOES_TO_INBOX: "SENSITIVE_GOES_TO_INBOX",
```

Remove this line from the `ToolError` union (around line 52):

```typescript
  | { kind: "sensitive-must-route-to-inbox"; path: string }
```

Keep the `Sensitivity` type alias intact (line 62) — it's used by test fixtures; deletion can come later as cleanup.

- [ ] **Step 3: Run tests; expect compile/type errors in consuming files**

Run: `bunx tsc --noEmit 2>&1 | head -30`
Expected: type errors in `src/shipped-defaults.ts`, `src/tools/write-document.ts`, `src/tools/schemas.ts`, possibly `src/tools/registry.ts`, and various test files. These are the files Tasks 2-4 + 11 fix.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "refactor(types): remove SENSITIVE_GOES_TO_INBOX from INVARIANTS and ToolError

Per the compiler reframe (sensitivity feature retired); deletion not refactor.
Type-check breaks consumers in src/shipped-defaults.ts, src/tools/*, and
src/abstract-surface.ts; subsequent commits fix each one.

Closes delta entry: code-side sensitivity plumbing — types.ts"
```

---

## Task 2: Remove `SENSITIVE_GOES_TO_INBOX` from `src/shipped-defaults.ts`

**Files:**
- Modify: `src/shipped-defaults.ts`

- [ ] **Step 1: Edit `src/shipped-defaults.ts`**

Remove this line from the `invariants` block of `SHIPPED_VAULT_CONFIG`:

```typescript
    SENSITIVE_GOES_TO_INBOX: "disabled",
```

The final `SHIPPED_VAULT_CONFIG.invariants` block should read:

```typescript
  invariants: {
    EVERY_WRITE_IS_LOGGED: "enabled",
    PAGE_TYPE_BY_DIRECTORY: "enabled",
    WIKILINKS_ARE_FULLPATH: "enabled",
    INBOX_IS_EPHEMERAL: "enabled",
    PAGE_CREATION_REQUIRES_RECURRENCE: "disabled",
  },
```

- [ ] **Step 2: Run type-check; remaining errors should narrow to write-document.ts + schemas.ts + abstract-surface.ts**

Run: `bunx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add src/shipped-defaults.ts
git commit -m "refactor(shipped-defaults): remove SENSITIVE_GOES_TO_INBOX from SHIPPED_VAULT_CONFIG

Closes delta entry: code-side sensitivity plumbing — shipped-defaults.ts"
```

---

## Task 3: Remove sensitivity from `writeDocument`

**Files:**
- Modify: `src/tools/write-document.ts`
- Modify: `src/tools/schemas.ts`

- [ ] **Step 1: Edit `src/tools/write-document.ts`**

Remove the `sensitivity_classified` field from the opts type (around line 15):

```typescript
  sensitivity_classified?: Sensitivity;
```

Remove the SENSITIVE_GOES_TO_INBOX check codepath. The block currently reads (around lines 108-115):

```typescript
  // SENSITIVE_GOES_TO_INBOX — opt-in; when enabled, sensitive content can't land in wiki/.
  if (
    vault.config.invariants.SENSITIVE_GOES_TO_INBOX === "enabled" &&
    input.opts?.sensitivity_classified === "sensitive" &&
    /* (rest of the predicate) */
  ) {
    return err({ kind: "sensitive-must-route-to-inbox", path: input.path });
  }
```

Delete the entire `if` block + its surrounding comment. Verify the import of `Sensitivity` is removed if unused.

- [ ] **Step 2: Edit `src/tools/schemas.ts`**

Remove `sensitivity_classified` from the zod schema (around line 26):

```typescript
      sensitivity_classified: z.enum(["normal", "sensitive"]).optional(),
```

Remove the corresponding opts-processing block (around lines 83-85):

```typescript
    if (parsed.opts.sensitivity_classified !== undefined) {
      opts.sensitivity_classified = parsed.opts.sensitivity_classified as Sensitivity;
    }
```

- [ ] **Step 3: Run type-check; verify the consumer files compile**

Run: `bunx tsc --noEmit 2>&1 | head -10`
Expected: errors narrow to test files only (abstract-surface comment is non-functional).

- [ ] **Step 4: Run tool tests**

Run: `bun test tests/tools/ 2>&1 | tail -5`
Expected: tests pass (the sensitivity invariant test was already deleted in the spec rewrite).

- [ ] **Step 5: Commit**

```bash
git add src/tools/write-document.ts src/tools/schemas.ts
git commit -m "refactor(write-document): remove SENSITIVE_GOES_TO_INBOX codepath + sensitivity_classified opts

writeDocument no longer gates wiki/ writes on sensitivity classification.
Per the compiler reframe, sensitivity-shaped routing is retired entirely
(not deferred to post-hoc — the feature is gone).

Closes delta entry: code-side sensitivity plumbing — writeDocument + schemas"
```

---

## Task 4: Drop the sensitivity comment in `src/abstract-surface.ts`

**Files:**
- Modify: `src/abstract-surface.ts:148`

- [ ] **Step 1: Edit `src/abstract-surface.ts`**

Around line 148, remove:

```typescript
    // sensitivity-classify is a sub-workflow invoked inside ingest; not
    // exposed as a standalone MCP prompt — its behavior is meaningful only
    // as part of ingest, not as a user-facing workflow.
```

Drop the entire comment block. Verify no code change is needed (the comment was non-functional).

- [ ] **Step 2: Run type-check + full test sweep**

Run: `bunx tsc --noEmit 2>&1 | head -5 && bun test 2>&1 | grep -cE "^\(fail\)"`
Expected: TSC exit 0; 0 fails (or only fails from sensitivity test fixtures that need cleanup).

- [ ] **Step 3: Clean any sensitivity test fixtures the spec rewrite missed**

Run: `grep -rln "SENSITIVE_GOES_TO_INBOX\|sensitive_classified\|sensitivity_classified" tests/ 2>/dev/null`

For each file in the output, open it and either delete the test (if it's testing the retired invariant) or update the test to not reference sensitivity (if it's an unrelated test that incidentally mentions the field).

- [ ] **Step 4: Run full test sweep**

Run: `bun test 2>&1 | grep -cE "^\(fail\)"`
Expected: 0 fails.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(abstract-surface): drop sensitivity-classify comment + clean test fixtures

Closes delta entry: code-side sensitivity plumbing — abstract-surface.ts + tests"
```

---

## Task 5: Add `inbox/review/` to the shipped scaffold

**Files:**
- Modify: `src/vault-scaffold.ts`
- Test: existing `tests/cli/init.test.ts` (extend the directory-list assertion)

- [ ] **Step 1: Write the failing test addition**

In `tests/cli/init.test.ts`, find the existing "produces a working vault with AGENTS.md..." test. Locate the assertion that asserts `inbox/raw/` exists (around the directory tree checks). Add immediately after:

```typescript
      expect(existsSync(join(target, "inbox", "review"))).toBe(true);
```

- [ ] **Step 2: Run the test; expect it to fail**

Run: `bun test tests/cli/init.test.ts 2>&1 | tail -10`
Expected: FAIL — `inbox/review/` does not exist after `dome init`.

- [ ] **Step 3: Edit `src/vault-scaffold.ts`**

In the directory-tree list (around lines 73-84), add `"inbox/review"` to the array:

```typescript
  for (const rel of [
    ".dome/state",
    ".dome/prompts",
    ".dome/hooks",
    "wiki/entities",
    "wiki/concepts",
    "wiki/sources",
    "wiki/syntheses",
    "raw",
    "notes",
    "inbox/raw",
    "inbox/review",
  ]) {
```

- [ ] **Step 4: Run the test; expect pass**

Run: `bun test tests/cli/init.test.ts 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vault-scaffold.ts tests/cli/init.test.ts
git commit -m "feat(scaffold): add inbox/review/ as shipped-default directory

Created by dome init alongside inbox/raw/. Single-purpose under the
compiler reframe (lint-report destination only; sensitivity routing
retired).

Closes delta entry: inbox/review/ creation by dome init"
```

---

## Task 6: New module `src/agents-md.ts` — templated content generator + merger

**Files:**
- Create: `src/agents-md.ts`
- Create: `tests/agents-md.test.ts`

The new module owns the AGENTS.md content shape: a *templated* section (generated from vault config) bounded by delimiters, and a *user-prose* section bounded by `<!-- BEGIN user-prose -->` / `<!-- END user-prose -->` markers that survives every `dome doctor --repair` call.

- [ ] **Step 1: Write the failing test file**

Create `tests/agents-md.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import {
  USER_PROSE_BEGIN,
  USER_PROSE_END,
  buildAgentsMdTemplated,
  mergeAgentsMd,
  buildInitialAgentsMd,
} from "../src/agents-md";
import { SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES } from "../src/shipped-defaults";

describe("buildAgentsMdTemplated", () => {
  test("includes enabled invariant names from the vault config", () => {
    const out = buildAgentsMdTemplated(SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES, ["ingest", "query", "lint"]);
    expect(out).toContain("EVERY_WRITE_IS_LOGGED");
    expect(out).toContain("PAGE_TYPE_BY_DIRECTORY");
    expect(out).toContain("WIKILINKS_ARE_FULLPATH");
    expect(out).not.toContain("SENSITIVE_GOES_TO_INBOX"); // retired feature
  });

  test("includes declared page-type defaults", () => {
    const out = buildAgentsMdTemplated(SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES, []);
    expect(out).toContain("entity");
    expect(out).toContain("concept");
    expect(out).toContain("source");
    expect(out).toContain("synthesis");
  });

  test("includes shipped workflow names passed in", () => {
    const out = buildAgentsMdTemplated(SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES, ["ingest", "lint", "export-context"]);
    expect(out).toContain("ingest");
    expect(out).toContain("lint");
    expect(out).toContain("export-context");
  });
});

describe("buildInitialAgentsMd", () => {
  test("wraps templated content with user-prose delimiters at the end (empty user-prose)", () => {
    const out = buildInitialAgentsMd(SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES, ["ingest"]);
    expect(out).toContain(USER_PROSE_BEGIN);
    expect(out).toContain(USER_PROSE_END);
    // BEGIN must appear before END.
    const beginIdx = out.indexOf(USER_PROSE_BEGIN);
    const endIdx = out.indexOf(USER_PROSE_END);
    expect(beginIdx).toBeGreaterThan(0);
    expect(endIdx).toBeGreaterThan(beginIdx);
    // Between BEGIN and END is the user-prose section — initially empty (whitespace OK).
    const userProse = out.slice(beginIdx + USER_PROSE_BEGIN.length, endIdx);
    expect(userProse.trim()).toBe("");
  });
});

describe("mergeAgentsMd", () => {
  test("preserves the user-prose section byte-for-byte when regenerating templated content", () => {
    // Start with a file containing custom user prose.
    const existing = buildInitialAgentsMd(SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES, ["ingest"]);
    const customProse = "## My personal naming conventions\n\nProject codenames use `proj-` prefix.\n";
    const withCustomProse = existing.replace(
      `${USER_PROSE_BEGIN}\n\n${USER_PROSE_END}`,
      `${USER_PROSE_BEGIN}\n${customProse}${USER_PROSE_END}`,
    );

    // Regenerate against a different config (e.g., different page types).
    const newPageTypes = { ...SHIPPED_PAGE_TYPES, defaults: [...SHIPPED_PAGE_TYPES.defaults, "person"] };
    const newTemplated = buildAgentsMdTemplated(SHIPPED_VAULT_CONFIG, newPageTypes, ["ingest", "query"]);
    const merged = mergeAgentsMd(withCustomProse, newTemplated);

    // User-prose section must be preserved verbatim.
    expect(merged).toContain(customProse);
    // Templated content reflects the new config.
    expect(merged).toContain("person"); // new page-type default
    expect(merged).toContain("query"); // new workflow name
  });

  test("when existing file has no delimiters, returns the templated content + an empty user-prose section", () => {
    // Simulating a malformed AGENTS.md that has no delimiters.
    const malformed = "# Just some prose without delimiters\n";
    const templated = buildAgentsMdTemplated(SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES, ["ingest"]);
    const merged = mergeAgentsMd(malformed, templated);

    expect(merged).toContain(USER_PROSE_BEGIN);
    expect(merged).toContain(USER_PROSE_END);
    expect(merged).toContain(templated); // templated content is present
  });
});
```

- [ ] **Step 2: Run the test; expect FAIL — module doesn't exist**

Run: `bun test tests/agents-md.test.ts 2>&1 | tail -10`
Expected: FAIL — `Cannot find module '../src/agents-md'`.

- [ ] **Step 3: Create `src/agents-md.ts`**

```typescript
// AGENTS.md content shape per docs/wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE.md.
// The file at vault root carries two sections: a templated section (generated
// from the vault's current config / page types / workflows; regenerated by
// `dome doctor --repair`) and a user-prose section (delimited by HTML comments;
// preserved verbatim across every --repair call).

import type { VaultConfig, PageTypesConfig } from "./vault";

export const USER_PROSE_BEGIN = "<!-- BEGIN user-prose -->";
export const USER_PROSE_END = "<!-- END user-prose -->";

/**
 * Generate the templated section of AGENTS.md from the vault's current state.
 * Carries: a one-line orientation header, the enabled invariant set, the
 * declared page-type defaults, and the shipped/active workflow names. The
 * content reflects what the agent needs to know about THIS vault before
 * touching any file.
 */
export function buildAgentsMdTemplated(
  config: VaultConfig,
  pageTypes: PageTypesConfig,
  workflowNames: ReadonlyArray<string>,
): string {
  const enabledInvariants = Object.entries(config.invariants)
    .filter(([_, status]) => status === "enabled")
    .map(([name]) => name)
    .sort();

  const allPageTypes = [
    ...pageTypes.defaults,
    ...pageTypes.extensions.map(e => typeof e === "string" ? e : e.name),
  ];

  const workflows = [...workflowNames].sort();

  return `# This vault

A Dome vault. Operate against the markdown directly; the compiler daemon
(\`dome serve\`) catches your writes and reconciles the vault state. For
explicit operations, use the CLI: \`dome lint\`, \`dome lint --apply <id>\`,
\`dome stats\`, \`dome doctor\`, \`dome export-context\`.

See docs/wiki/specs/ for the full normative substrate.

## Conventions

- Markdown is the source of truth. Anything Dome derives can be rebuilt from
  the markdown alone.
- Write to \`wiki/<type>/<name>.md\` for typed wiki pages; never to \`raw/\`
  (immutable); never directly mutate \`log.md\` or \`index.md\`.
- Wikilinks use full paths: \`[[wiki/entities/x]]\` not \`[[x]]\`.
- Page type comes from directory: \`wiki/entities/\` is type \`entity\`, etc.

## Enabled invariants

${enabledInvariants.map(n => `- \`${n}\``).join("\n")}

See docs/wiki/invariants/ for the canonical definitions.

## Page types

${allPageTypes.map(t => `- \`${t}\``).join("\n")}

## Workflows

${workflows.map(w => `- \`${w}\` — invoke via \`dome ${w}\` when applicable`).join("\n")}

`;
}

/**
 * Build the initial AGENTS.md for a fresh vault: templated content followed
 * by an empty user-prose section. The user edits the user-prose section over
 * time; \`dome doctor --repair\` regenerates the templated section while
 * preserving user-prose byte-for-byte.
 */
export function buildInitialAgentsMd(
  config: VaultConfig,
  pageTypes: PageTypesConfig,
  workflowNames: ReadonlyArray<string>,
): string {
  const templated = buildAgentsMdTemplated(config, pageTypes, workflowNames);
  return `${templated}\n${USER_PROSE_BEGIN}\n\n${USER_PROSE_END}\n`;
}

/**
 * Regenerate AGENTS.md from current config while preserving the user-prose
 * section. Reads the existing user-prose between BEGIN/END markers (verbatim,
 * including any whitespace) and splices it after the new templated content.
 *
 * If the existing file has no delimiters (corrupted or pre-invariant file),
 * treats the user-prose section as empty and emits a fresh skeleton.
 */
export function mergeAgentsMd(existing: string, newTemplated: string): string {
  const beginIdx = existing.indexOf(USER_PROSE_BEGIN);
  const endIdx = existing.indexOf(USER_PROSE_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    // Malformed or missing delimiters — emit fresh skeleton with empty user-prose.
    return `${newTemplated}\n${USER_PROSE_BEGIN}\n\n${USER_PROSE_END}\n`;
  }
  const userProse = existing.slice(beginIdx + USER_PROSE_BEGIN.length, endIdx);
  return `${newTemplated}\n${USER_PROSE_BEGIN}${userProse}${USER_PROSE_END}\n`;
}
```

- [ ] **Step 4: Run the test; expect pass**

Run: `bun test tests/agents-md.test.ts 2>&1 | tail -10`
Expected: PASS, 4 expect() calls minimum.

- [ ] **Step 5: Commit**

```bash
git add src/agents-md.ts tests/agents-md.test.ts
git commit -m "feat(agents-md): templated-section generator + delimiter-preserving merger

New module owns the AGENTS.md content shape per the new invariant
AGENTS_MD_IS_ORIENTATION_SURFACE: a templated section (vault conventions,
enabled invariants, declared page types, workflow names) bounded by
USER_PROSE_BEGIN/END markers, with the user-prose section preserved
byte-for-byte across regenerations.

Closes delta entries: AGENTS.md generation (the content contract);
dome doctor --repair (the merger logic — consumed by Task 9)."
```

---

## Task 7: Use the new module in `dome init`

**Files:**
- Modify: `src/cli/commands/init.ts`
- Test: `tests/cli/init.test.ts` (extend existing AGENTS.md assertions)

- [ ] **Step 1: Add the delimiter-presence assertion to existing init test**

In `tests/cli/init.test.ts`, after the existing AGENTS.md content checks, add:

```typescript
      // Per AGENTS_MD_IS_ORIENTATION_SURFACE: the file has user-prose delimiters
      // that survive future --repair runs.
      const agentsBody = await readFile(agentsPath, "utf8");
      expect(agentsBody).toContain("<!-- BEGIN user-prose -->");
      expect(agentsBody).toContain("<!-- END user-prose -->");
      // Templated content includes enabled invariants.
      expect(agentsBody).toContain("EVERY_WRITE_IS_LOGGED");
      // Templated content does NOT include the retired invariant.
      expect(agentsBody).not.toContain("SENSITIVE_GOES_TO_INBOX");
```

- [ ] **Step 2: Run the test; expect FAIL**

Run: `bun test tests/cli/init.test.ts 2>&1 | tail -10`
Expected: FAIL — the existing hardcoded `SHIPPED_AGENTS_MD` doesn't include the delimiters in the expected form.

- [ ] **Step 3: Edit `src/cli/commands/init.ts`**

Replace the hardcoded `SHIPPED_AGENTS_MD` string. Replace the top of the file (the `INTAKE_RAW_HOOK_YAML` constant stays; the `SHIPPED_AGENTS_MD` and `SHIPPED_CLAUDE_MD_SHIM` constants and their imports change):

```typescript
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initRepo, commit } from "../../git";
import { scaffoldVaultLayout } from "../../vault-scaffold";
import { buildInitialAgentsMd } from "../../agents-md";
import { SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES } from "../../shipped-defaults";
import { WORKFLOW_NAMES } from "../../workflows/workflow-name";
import { ok, err, type Result, type ToolError } from "../../types";

const INTAKE_RAW_HOOK_YAML = `# Shipped-default intake hook
event: document.written
path_pattern: "inbox/raw/*"
workflow: ingest
async: true
idempotent: true
`;

const SHIPPED_CLAUDE_MD_SHIM = `See AGENTS.md.\n`;

export async function domeInit(vaultPath: string): Promise<Result<{ path: string; sha: string }, ToolError>> {
  if (existsSync(join(vaultPath, ".dome"))) {
    return err({ kind: "already-exists", path: vaultPath });
  }
  if (existsSync(join(vaultPath, ".git"))) {
    return err({ kind: "validation", message: `Existing .git at ${vaultPath}; use dome migrate instead` });
  }

  const scaffolded = await scaffoldVaultLayout(vaultPath);

  const intakeRel = ".dome/hooks/intake-raw.yaml";
  const agentsRel = "AGENTS.md";
  const claudeRel = "CLAUDE.md";
  await writeFile(join(vaultPath, intakeRel), INTAKE_RAW_HOOK_YAML);
  await writeFile(
    join(vaultPath, agentsRel),
    buildInitialAgentsMd(SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES, [...WORKFLOW_NAMES]),
  );
  await writeFile(join(vaultPath, claudeRel), SHIPPED_CLAUDE_MD_SHIM);

  await initRepo(vaultPath);
  const sha = await commit({
    path: vaultPath,
    message: "chore: initialize Dome vault",
    files: [...scaffolded, intakeRel, agentsRel, claudeRel],
  });
  return ok({ path: vaultPath, sha });
}
```

- [ ] **Step 4: Run the test; expect pass**

Run: `bun test tests/cli/init.test.ts 2>&1 | tail -10`
Expected: PASS, all assertions including the new delimiter and invariant checks.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/init.ts tests/cli/init.test.ts
git commit -m "feat(init): generate AGENTS.md from vault config via buildInitialAgentsMd

dome init now generates AGENTS.md dynamically from SHIPPED_VAULT_CONFIG +
SHIPPED_PAGE_TYPES + WORKFLOW_NAMES instead of writing a hardcoded string.
The templated section reflects the current vault state; the user-prose
section is delimited by HTML comments per AGENTS_MD_IS_ORIENTATION_SURFACE.

Closes delta entry: AGENTS.md + CLAUDE.md shim generation by dome init."
```

---

## Task 8: Add `dome doctor --time-since-reconcile`

**Files:**
- Modify: `src/cli/commands/doctor.ts`
- Modify: `src/cli/cli.ts`
- Test: `tests/cli/doctor-flags.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/cli/doctor-flags.test.ts` (mirror the existing `--recent-activity` test shape):

```typescript
  test("--time-since-reconcile reports drift age based on last-reconciled-sha.txt mtime", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-tsr-"));
    const target = join(base, "v");
    try {
      await domeInit(target);
      // Set up a known last-reconciled-sha.txt mtime: 2 hours ago.
      const reconcilePath = join(target, ".dome", "state", "last-reconciled-sha.txt");
      await writeFile(reconcilePath, "abc123");
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await utimes(reconcilePath, twoHoursAgo, twoHoursAgo);

      const res = await domeDoctor(target, { timeSinceReconcile: true });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const summary = res.value.info.find(s => s.startsWith("time-since-reconcile:"));
      expect(summary).toBeDefined();
      expect(summary!).toMatch(/2 hours?/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("--time-since-reconcile reports 'never' when last-reconciled-sha.txt is absent", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-tsr-never-"));
    const target = join(base, "v");
    try {
      await domeInit(target);
      const res = await domeDoctor(target, { timeSinceReconcile: true });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const summary = res.value.info.find(s => s.startsWith("time-since-reconcile:"));
      expect(summary).toBeDefined();
      expect(summary!.toLowerCase()).toContain("never");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
```

Make sure the test file imports `utimes` from `node:fs/promises` and `writeFile` if not already.

- [ ] **Step 2: Run the test; expect FAIL (unknown flag)**

Run: `bun test tests/cli/doctor-flags.test.ts -t "time-since-reconcile" 2>&1 | tail -10`
Expected: FAIL — `timeSinceReconcile` is not a known DoctorOpts field.

- [ ] **Step 3: Edit `src/cli/commands/doctor.ts`**

Add `timeSinceReconcile?: boolean` to the `DoctorOpts` interface (around line 32):

```typescript
  /**
   * When set, report how long it's been since the daemon last reconciled
   * (read from .dome/state/last-reconciled-sha.txt mtime). See
   * docs/wiki/gotchas/daemon-off-while-vault-mutating.md.
   */
  timeSinceReconcile?: boolean;
```

Add the flag-handler block in the body (alongside the other `if (opts.X)` blocks; right before the closing `return ok({...})`):

```typescript
  if (opts.timeSinceReconcile) {
    const reconcilePath = join(vault.path, ".dome", "state", "last-reconciled-sha.txt");
    if (!existsSync(reconcilePath)) {
      info.push("time-since-reconcile: never (dome reconcile has never run)");
    } else {
      const st = await stat(reconcilePath);
      const ageMs = Date.now() - st.mtimeMs;
      info.push(`time-since-reconcile: ${formatAge(ageMs)} (since ${new Date(st.mtimeMs).toISOString()})`);
    }
  }
```

Add the `formatAge` helper at the bottom of the file (before the final closing brace if any, or just before `return ok({...})`):

```typescript
function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)} seconds`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} minutes`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} hours`;
  return `${Math.floor(ms / 86_400_000)} days`;
}
```

- [ ] **Step 4: Edit `src/cli/cli.ts`**

Find the `dome doctor` command's commander wiring. Add the flag:

```typescript
    .option("--time-since-reconcile", "Report drift age since `dome reconcile` last ran")
```

Add to the `DoctorCliOpts` interface (in cli.ts):

```typescript
  timeSinceReconcile?: boolean;
```

Add to the `toDoctorOpts` function:

```typescript
  if (cli.timeSinceReconcile) opts.timeSinceReconcile = true;
```

- [ ] **Step 5: Run the test; expect pass**

Run: `bun test tests/cli/doctor-flags.test.ts -t "time-since-reconcile" 2>&1 | tail -10`
Expected: PASS, both tests.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/doctor.ts src/cli/cli.ts tests/cli/doctor-flags.test.ts
git commit -m "feat(doctor): add --time-since-reconcile flag

Reads .dome/state/last-reconciled-sha.txt mtime and reports drift age in
seconds/minutes/hours/days. Reports 'never' when reconcile has never run.

Closes delta entry: dome doctor --time-since-reconcile.
References: docs/wiki/gotchas/daemon-off-while-vault-mutating.md."
```

---

## Task 9: Add `dome doctor --repair` (AGENTS.md regeneration)

**Files:**
- Modify: `src/cli/commands/doctor.ts`
- Modify: `src/cli/cli.ts`
- Test: `tests/cli/doctor-flags.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/cli/doctor-flags.test.ts`:

```typescript
  test("--repair regenerates AGENTS.md templated section while preserving user-prose", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-repair-"));
    const target = join(base, "v");
    try {
      await domeInit(target);
      const agentsPath = join(target, "AGENTS.md");

      // Inject custom user-prose between the delimiters.
      const original = await readFile(agentsPath, "utf8");
      const customProse = "\n## My naming conventions\n\nProjects use `proj-` prefix.\n\n";
      const withProse = original.replace(
        /<!-- BEGIN user-prose -->\n\n<!-- END user-prose -->/,
        `<!-- BEGIN user-prose -->${customProse}<!-- END user-prose -->`,
      );
      await writeFile(agentsPath, withProse);

      // Run --repair.
      const res = await domeDoctor(target, { repair: true });
      expect(res.ok).toBe(true);

      // Verify user-prose preserved byte-for-byte.
      const after = await readFile(agentsPath, "utf8");
      expect(after).toContain(customProse);
      // Templated content still present.
      expect(after).toContain("EVERY_WRITE_IS_LOGGED");
      expect(after).toContain("<!-- BEGIN user-prose -->");
      expect(after).toContain("<!-- END user-prose -->");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("--repair recreates AGENTS.md when missing entirely", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-repair-missing-"));
    const target = join(base, "v");
    try {
      await domeInit(target);
      const agentsPath = join(target, "AGENTS.md");
      await rm(agentsPath);

      const res = await domeDoctor(target, { repair: true });
      expect(res.ok).toBe(true);
      expect(existsSync(agentsPath)).toBe(true);

      const after = await readFile(agentsPath, "utf8");
      expect(after).toContain("<!-- BEGIN user-prose -->");
      expect(after).toContain("<!-- END user-prose -->");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run the test; expect FAIL**

Run: `bun test tests/cli/doctor-flags.test.ts -t "repair" 2>&1 | tail -10`

- [ ] **Step 3: Edit `src/cli/commands/doctor.ts`**

Add to `DoctorOpts`:

```typescript
  /**
   * When set, regenerate AGENTS.md templated sections from current config
   * while preserving the user-prose section. Per
   * docs/wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE.md.
   */
  repair?: boolean;
```

Add the impl block (before the `return ok(...)`):

```typescript
  if (opts.repair) {
    const { buildAgentsMdTemplated, mergeAgentsMd, buildInitialAgentsMd } = await import("../../agents-md");
    const { WORKFLOW_NAMES } = await import("../../workflows/workflow-name");
    const agentsPath = join(vault.path, "AGENTS.md");
    const newTemplated = buildAgentsMdTemplated(vault.config, vault.pageTypes, [...WORKFLOW_NAMES]);
    if (existsSync(agentsPath)) {
      const existing = await Bun.file(agentsPath).text();
      const merged = mergeAgentsMd(existing, newTemplated);
      await Bun.write(agentsPath, merged);
      info.push(`--repair: AGENTS.md templated sections regenerated (user-prose preserved)`);
    } else {
      const fresh = buildInitialAgentsMd(vault.config, vault.pageTypes, [...WORKFLOW_NAMES]);
      await Bun.write(agentsPath, fresh);
      info.push(`--repair: AGENTS.md created (was missing)`);
    }
  }
```

- [ ] **Step 4: Edit `src/cli/cli.ts`**

Add the commander option for `--repair`:

```typescript
    .option("--repair", "Regenerate AGENTS.md templated sections (preserves user-prose)")
```

Add to `DoctorCliOpts`:

```typescript
  repair?: boolean;
```

And the toDoctorOpts mapping:

```typescript
  if (cli.repair) opts.repair = true;
```

- [ ] **Step 5: Run the test; expect pass**

Run: `bun test tests/cli/doctor-flags.test.ts -t "repair" 2>&1 | tail -10`

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/doctor.ts src/cli/cli.ts tests/cli/doctor-flags.test.ts
git commit -m "feat(doctor): add --repair flag for AGENTS.md regeneration

Regenerates the templated section of AGENTS.md from the current vault
config / page types / workflow names while preserving the user-prose
section byte-for-byte via the BEGIN/END delimiters. If AGENTS.md is
missing entirely, --repair recreates it with an empty user-prose section.

Closes delta entry: dome doctor --repair.
References: docs/wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE.md."
```

---

## Task 10: Add AGENTS.md drift checks to `dome doctor`

**Files:**
- Modify: `src/cli/commands/doctor.ts` (extend the existing structural-checks walk)
- Test: `tests/cli/doctor-checks.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/cli/doctor-checks.test.ts`:

```typescript
  test("doctor reports violation when AGENTS.md is missing", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-doc-agents-missing-"));
    const target = join(base, "v");
    try {
      await domeInit(target);
      await rm(join(target, "AGENTS.md"));
      const res = await domeDoctor(target, {});
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.violations.some(v => v.toLowerCase().includes("agents.md"))).toBe(true);
      expect(res.value.exitCode).toBe(1);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("doctor reports violation when CLAUDE.md shim is missing", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-doc-claude-missing-"));
    const target = join(base, "v");
    try {
      await domeInit(target);
      await rm(join(target, "CLAUDE.md"));
      const res = await domeDoctor(target, {});
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.violations.some(v => v.toLowerCase().includes("claude.md"))).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("doctor passes when AGENTS.md and CLAUDE.md are both present and well-formed", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-doc-ok-"));
    const target = join(base, "v");
    try {
      await domeInit(target);
      const res = await domeDoctor(target, {});
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const agentsViolations = res.value.violations.filter(v => v.toLowerCase().includes("agents.md") || v.toLowerCase().includes("claude.md"));
      expect(agentsViolations.length).toBe(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run the tests; expect FAIL**

Run: `bun test tests/cli/doctor-checks.test.ts -t "AGENTS\\|CLAUDE" 2>&1 | tail -10`

- [ ] **Step 3: Edit `src/cli/commands/doctor.ts`**

Add a new structural check (immediately after CHECK 9 — the INBOX_IS_EPHEMERAL block):

```typescript
  // CHECK 10 (new): AGENTS.md and CLAUDE.md shim per AGENTS_MD_IS_ORIENTATION_SURFACE.
  const agentsAbs = join(vault.path, "AGENTS.md");
  const claudeAbs = join(vault.path, "CLAUDE.md");
  if (!existsSync(agentsAbs)) {
    violations.push(`AGENTS.md: missing at vault root (AGENTS_MD_IS_ORIENTATION_SURFACE — run \`dome doctor --repair\`)`);
  } else {
    const agentsBody = await Bun.file(agentsAbs).text();
    // Must carry the user-prose delimiters (per AGENTS_MD_IS_ORIENTATION_SURFACE).
    if (!agentsBody.includes("<!-- BEGIN user-prose -->") || !agentsBody.includes("<!-- END user-prose -->")) {
      violations.push(`AGENTS.md: user-prose delimiters missing (\`dome doctor --repair\` regenerates them)`);
    }
  }
  if (!existsSync(claudeAbs)) {
    violations.push(`CLAUDE.md: shim missing at vault root (Claude Code auto-loads this; should contain "See AGENTS.md.")`);
  }
```

- [ ] **Step 4: Run the tests; expect pass**

Run: `bun test tests/cli/doctor-checks.test.ts -t "AGENTS\\|CLAUDE" 2>&1 | tail -10`

- [ ] **Step 5: Drop stale sensitivity reference in `--show review-queue`**

In `doctor.ts`, find the `--show review-queue` block (around lines 320-336). Change the message:

```typescript
      info.push("review-queue: (inbox/review/ not present; SENSITIVE_GOES_TO_INBOX likely disabled)");
```

to:

```typescript
      info.push("review-queue: (inbox/review/ not present — run `dome init` or `dome doctor --repair`)");
```

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/doctor.ts tests/cli/doctor-checks.test.ts
git commit -m "feat(doctor): AGENTS.md drift checks + drop sensitivity ref in review-queue msg

dome doctor (without --repair) now reports a violation when AGENTS.md is
missing, when its user-prose delimiters are missing, or when CLAUDE.md
shim is missing. Updated --show review-queue message to drop the retired
SENSITIVE_GOES_TO_INBOX reference.

Closes delta entry: dome doctor AGENTS.md drift reporting.
References: docs/wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE.md."
```

---

## Task 11: Watcher-driven `appendLog` hook for native writes

**Files:**
- Create: `src/hooks/log-out-of-band-write.ts`
- Modify: `src/shipped-defaults.ts` (add to the `hooks.builtin` registry)
- Modify: wherever shipped-default hooks get registered (find this with `grep -rln "auto-update-index" src/`)
- Test: `tests/hooks/log-out-of-band-write.test.ts`

- [ ] **Step 1: Find the shipped-default-hook registration site**

Run: `grep -rln "auto-update-index\|autoUpdateIndex" src/ 2>/dev/null`

This reveals where `autoUpdateIndex` is registered. Note the file paths for Step 3.

- [ ] **Step 2: Write the failing test**

Create `tests/hooks/log-out-of-band-write.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { logOutOfBandWrite } from "../../src/hooks/log-out-of-band-write";
import type { HookContext } from "../../src/hook-context";

describe("logOutOfBandWrite", () => {
  test("calls appendLog with source 'out-of-band' for vault.out-of-band-edit events", async () => {
    const appendLogCalls: Array<{ verb: string; subject: string; refs?: ReadonlyArray<string> }> = [];
    const ctx = {
      tools: {
        appendLog: async (input: { verb: string; subject: string; refs?: ReadonlyArray<string> }) => {
          appendLogCalls.push(input);
          return { result: { ok: true, value: {} as never }, effects: [] };
        },
      },
    } as unknown as HookContext;
    const event = { kind: "vault.out-of-band-edit", path: "wiki/entities/danny.md", fsKind: "modified" };
    await logOutOfBandWrite(event as never, ctx);
    expect(appendLogCalls.length).toBe(1);
    expect(appendLogCalls[0]!.verb).toBe("update");
    expect(appendLogCalls[0]!.subject).toContain("wiki/entities/danny.md");
    expect(appendLogCalls[0]!.subject.toLowerCase()).toContain("out-of-band");
  });
});
```

- [ ] **Step 3: Run; expect FAIL**

Run: `bun test tests/hooks/log-out-of-band-write.test.ts 2>&1 | tail -10`
Expected: Cannot find module.

- [ ] **Step 4: Create `src/hooks/log-out-of-band-write.ts`**

```typescript
import type { HookHandler } from "../hook-context";

/**
 * Shipped-default hook. Subscribes to `vault.out-of-band-edit` events fired by
 * the VaultWatcher and records each native write to log.md via appendLog —
 * the external-path enforcement of EVERY_WRITE_IS_LOGGED per
 * docs/wiki/invariants/VAULT_RECONCILES_AFTER_NATIVE_WRITE.md.
 *
 * The verb is "update" (a generic mutation verb); the subject names the path
 * and tags it as out-of-band so a reader of log.md can distinguish
 * Tool-mediated writes from native ones.
 *
 * HOOKS_CANNOT_BYPASS_TOOLS: this hook observes events and calls a Tool
 * (appendLog); it never writes directly.
 */
export const logOutOfBandWrite: HookHandler = async (event, ctx) => {
  if (event.kind !== "vault.out-of-band-edit") return;
  const path = (event as { path?: string }).path;
  if (typeof path !== "string") return;
  // Skip log.md and index.md — dispatcher-owned; the dispatcher will fire
  // its own log entries when needed; double-logging would create cycles.
  if (path === "log.md" || path === "index.md") return;
  const fsKind = (event as { fsKind?: string }).fsKind ?? "modified";
  await ctx.tools.appendLog({
    verb: "update",
    subject: `${path} (out-of-band, ${fsKind})`,
  });
};
```

- [ ] **Step 5: Run the unit test; expect pass**

Run: `bun test tests/hooks/log-out-of-band-write.test.ts 2>&1 | tail -5`

- [ ] **Step 6: Register the hook as shipped-default**

Open the file from Step 1's grep (typically `src/hooks/index.ts` or `src/vault.ts`). Add `logOutOfBandWrite` to the shipped-default hook registration list. The exact code depends on the registration pattern — mirror `autoUpdateIndex`'s registration shape.

In `src/shipped-defaults.ts`, extend the `hooks.builtin` block:

```typescript
  hooks: {
    builtin: {
      "auto-update-index": "enabled",
      "auto-cross-reference": "enabled",
      "log-out-of-band-write": "enabled",
    },
    max_causation_depth: 50,
    inbox_stale_age_hours: 24,
  },
```

- [ ] **Step 7: Commit**

```bash
git add src/hooks/log-out-of-band-write.ts src/shipped-defaults.ts tests/hooks/log-out-of-band-write.test.ts
git add -A  # picks up the registration-site file too
git commit -m "feat(hooks): shipped-default log-out-of-band-write hook

New reactive hook on vault.out-of-band-edit events: calls appendLog with
the out-of-band-tagged subject. Realizes the external-path enforcement of
EVERY_WRITE_IS_LOGGED + VAULT_RECONCILES_AFTER_NATIVE_WRITE.

Skips log.md and index.md (dispatcher-owned; would create cycles).
HOOKS_CANNOT_BYPASS_TOOLS preserved: hook calls Tool, not direct write.

Closes delta entries: watcher-driven appendLog hook; the integrity path
for VAULT_RECONCILES_AFTER_NATIVE_WRITE.

References: docs/wiki/invariants/VAULT_RECONCILES_AFTER_NATIVE_WRITE.md,
docs/wiki/invariants/EVERY_WRITE_IS_LOGGED.md §'Statement' path 2."
```

---

## Task 12: New invariant regression tests

**Files:**
- Create: `tests/invariants/vault-reconciles-after-native-write.test.ts`
- Create: `tests/invariants/agents-md-is-orientation-surface.test.ts`

- [ ] **Step 1: Create the AGENTS_MD_IS_ORIENTATION_SURFACE test**

Create `tests/invariants/agents-md-is-orientation-surface.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domeInit } from "../../src/cli/commands/init";
import { domeDoctor } from "../../src/cli/commands/doctor";

describe("AGENTS_MD_IS_ORIENTATION_SURFACE", () => {
  test("dome init writes AGENTS.md with templated sections + user-prose delimiters", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-amios-"));
    const target = join(base, "v");
    try {
      const r = await domeInit(target);
      expect(r.ok).toBe(true);
      const body = await readFile(join(target, "AGENTS.md"), "utf8");
      expect(body).toContain("<!-- BEGIN user-prose -->");
      expect(body).toContain("<!-- END user-prose -->");
      // Templated content reflects shipped defaults.
      expect(body).toContain("EVERY_WRITE_IS_LOGGED");
      expect(body).toContain("entity");
      expect(body).toContain("ingest");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("CLAUDE.md shim at vault root points at AGENTS.md", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-amios-claude-"));
    const target = join(base, "v");
    try {
      await domeInit(target);
      const body = await readFile(join(target, "CLAUDE.md"), "utf8");
      expect(body.trim()).toBe("See AGENTS.md.");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("dome doctor --repair preserves user-prose across regeneration", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-amios-repair-"));
    const target = join(base, "v");
    try {
      await domeInit(target);
      const agentsPath = join(target, "AGENTS.md");
      const before = await readFile(agentsPath, "utf8");
      const customProse = "\n## Custom\n\nMine!\n\n";
      await writeFile(
        agentsPath,
        before.replace(
          /<!-- BEGIN user-prose -->\n\n<!-- END user-prose -->/,
          `<!-- BEGIN user-prose -->${customProse}<!-- END user-prose -->`,
        ),
      );

      const r = await domeDoctor(target, { repair: true });
      expect(r.ok).toBe(true);
      const after = await readFile(agentsPath, "utf8");
      expect(after).toContain(customProse);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("dome doctor reports violation when AGENTS.md is missing", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-amios-missing-"));
    const target = join(base, "v");
    try {
      await domeInit(target);
      await rm(join(target, "AGENTS.md"));
      const r = await domeDoctor(target, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.violations.some(v => v.toLowerCase().includes("agents.md"))).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Create the VAULT_RECONCILES_AFTER_NATIVE_WRITE test**

Create `tests/invariants/vault-reconciles-after-native-write.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { makeTestVault } from "../helpers/make-test-vault";
import { openVault } from "../../src/vault";
import { logOutOfBandWrite } from "../../src/hooks/log-out-of-band-write";
import type { HookContext } from "../../src/hook-context";

describe("VAULT_RECONCILES_AFTER_NATIVE_WRITE", () => {
  test("the shipped-default log-out-of-band-write hook records native writes via appendLog", async () => {
    // Direct unit-test the hook handler — broader end-to-end with the watcher
    // is exercised by tests/gotchas/out-of-band-vault-edits.test.ts once the
    // hook is wired into VaultWatcher's hook chain.
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
      { kind: "vault.out-of-band-edit", path: "wiki/entities/danny.md", fsKind: "modified" } as never,
      ctx,
    );

    expect(calls.length).toBe(1);
    expect(calls[0]!.subject).toContain("wiki/entities/danny.md");
    expect(calls[0]!.subject.toLowerCase()).toContain("out-of-band");
  });

  test("native fs.writeFile to wiki/ produces a log.appended event when the daemon's reconcile runs", async () => {
    // Acceptance test: write directly to disk (bypassing Tools), run reconcile,
    // assert log.md contains an out-of-band entry.
    const v = await makeTestVault();
    try {
      const r = await openVault(v.path);
      if (!r.ok) throw new Error("openVault failed");
      const vault = r.value;
      await mkdir(join(v.path, "wiki", "entities"), { recursive: true });
      const targetPath = join(v.path, "wiki", "entities", "test.md");
      await writeFile(
        targetPath,
        "---\ntype: entity\ncreated: 2026-05-26\nupdated: 2026-05-26\nsources: []\n---\n# Test\n",
      );

      // Run reconcile to fire the catch-up events.
      const { reconcile } = await import("../../src/reconcile");
      await reconcile(vault, { onEvent: (e) => vault.dispatchEvents([e]) });
      await vault.drainHooks();

      // log.md should now mention the file.
      const logBody = await readFile(join(v.path, "log.md"), "utf8");
      expect(logBody.toLowerCase()).toContain("wiki/entities/test.md");
    } finally {
      await v.cleanup();
    }
  });
});
```

- [ ] **Step 3: Run the new tests**

Run: `bun test tests/invariants/vault-reconciles-after-native-write.test.ts tests/invariants/agents-md-is-orientation-surface.test.ts 2>&1 | tail -10`
Expected: PASS for all. The end-to-end test (Step 2 second test) may depend on reconcile firing the right event kind that the hook subscribes to — verify by reading `src/reconcile.ts` for the event-kind names used in the git-diff replay phase.

- [ ] **Step 4: If the end-to-end test fails due to event-kind mismatch, adjust**

The hook subscribes to `vault.out-of-band-edit`. Reconcile's git-diff phase may fire `document.written.<category>.<type>` instead. If so, either (a) add a second subscription to the hook for `document.written.*` events (and gate by some flag to avoid double-firing on Tool writes), or (b) make the test specifically write to the working tree, run the watcher (not reconcile), and assert. Choose based on the integration the existing `tests/gotchas/out-of-band-vault-edits.test.ts` uses as the pattern.

- [ ] **Step 5: Commit**

```bash
git add tests/invariants/agents-md-is-orientation-surface.test.ts tests/invariants/vault-reconciles-after-native-write.test.ts
git commit -m "test(invariants): add regression tests for the two new invariants

AGENTS_MD_IS_ORIENTATION_SURFACE: init writes file; --repair preserves
user-prose; doctor flags missing.

VAULT_RECONCILES_AFTER_NATIVE_WRITE: log-out-of-band-write hook records
native writes; end-to-end native write → reconcile → log.md update.

Closes delta entry: regression tests for the two new invariants."
```

---

## Task 13: Final type-check + full test sweep

**Files:** (none — verification only)

- [ ] **Step 1: Type-check the whole project**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Full test sweep**

Run: `bun test 2>&1 | tail -5`
Expected: all tests pass; exit 0.

If anything fails, debug and fix; the implementation pass is not complete until both type-check and the test suite are clean.

- [ ] **Step 3: Spot-check the CLI help text**

Run: `bun bin/dome doctor --help 2>&1 | head -30`
Expected: help text shows the new `--repair` and `--time-since-reconcile` flags.

- [ ] **Step 4: Verify the AGENTS.md content shape by running init**

```bash
TMPDIR=$(mktemp -d) && bun bin/dome init "$TMPDIR/v" && cat "$TMPDIR/v/AGENTS.md" | head -30 && rm -rf "$TMPDIR"
```

Eyeball the output: templated content includes enabled invariants, page types, workflow names; the `<!-- BEGIN user-prose -->` / `<!-- END user-prose -->` delimiters are present and empty in the middle.

- [ ] **Step 5: No commit if no drift fixes needed**

If type-check and tests are clean and the help text + init output look right, the implementation pass is complete; no final commit is needed.

---

## Self-Review

- **Spec coverage:** Every implementation entry from the delta ledger §"Deferred" item 1 maps to a task: AGENTS.md generation (Tasks 6, 7); CLAUDE.md shim (Task 7 — preserved from existing init.ts); inbox/review/ (Task 5); doctor --repair (Task 9); doctor AGENTS.md drift checks (Task 10); doctor --time-since-reconcile (Task 8); watcher-driven appendLog hook (Task 11); sensitivity removal (Tasks 1-4). All 6 proposed tests from §"Tests proposed" land via Tasks 8-12.

- **Placeholder scan:** No TODOs, no "implement appropriate error handling" stubs. Each code step shows actual code. Step 4 of Task 12 acknowledges the event-kind mismatch as a real-time decision the implementer makes by reading the existing integration test — this is implementation judgment, not a placeholder.

- **Type consistency:** `buildAgentsMdTemplated` and `buildInitialAgentsMd` and `mergeAgentsMd` signatures match in Task 6's test, the module impl, and Tasks 7 + 9 consumers. `USER_PROSE_BEGIN` / `USER_PROSE_END` constants used consistently. `DoctorOpts` extensions (`repair`, `timeSinceReconcile`) used the same way in tests, impl, and cli.ts mapping.

## Execution handoff

This plan is ready for `superpowers:executing-plans` (inline execution with checkpoints) or `superpowers:subagent-driven-development` (fresh subagent per task). The implement-cohesively flow dispatched this plan via writing-plans; the orchestrator's next step is invoking executing-plans against this path.
