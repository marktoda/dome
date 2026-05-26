# Cold-Start Agent Orientation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current Claude-Code-config `CLAUDE.md` shipped by `dome init` with a three-layer cold-start design: (1) universal Dome rules served at MCP-mount time as the server's `instructions` blob, (2) a vault-owned `AGENTS.md` for per-vault notes, (3) a content-free `CLAUDE.md` shim pointing at `AGENTS.md`.

**Architecture:** A new `buildInstructions(vault)` assembles `system-base.md` (via the existing `PromptLoader`) + the vault's enabled invariants + its page types + any `AGENTS.md` contents into a single string. `DomeMcpServer` passes this to `new Server(..., { instructions })` so every connecting MCP client (Claude Code, Codex, OpenCode, etc.) receives the full orientation on `initialize`. `dome init` no longer writes the existing `SHIPPED_CLAUDE_MD`; it writes an `AGENTS.md` template plus a one-line `CLAUDE.md` shim.

**Tech Stack:** Bun, TypeScript, `@modelcontextprotocol/sdk` v1, `bun:test`. Uses the existing `PromptLoader` (`src/prompts/prompt-loader.ts`) to load `system-base.md` from the SDK package — preserves bit-identity between the workflow-time `{{include}}` path and the cold-start MCP path.

---

## File Structure

**New files:**
- `src/mcp/instructions-builder.ts` — pure function assembling the rich `instructions` string from a `Vault`.
- `tests/mcp/instructions-builder.test.ts` — unit tests for the builder.

**Modified files:**
- `src/mcp/server.ts` — add `async instructions(): Promise<string>` accessor; pass result to `new Server`.
- `tests/mcp/server.test.ts` — add test asserting `instructions()` returns a string containing system-base, enabled invariants, page types, and AGENTS.md.
- `src/cli/commands/init.ts` — replace `SHIPPED_CLAUDE_MD` write with `AGENTS.md` write + 1-line `CLAUDE.md` shim.
- `src/vault-scaffold.ts` — update the leading comment that says "init adds CLAUDE.md + intake-raw.yaml" to reflect the new init extras.
- `tests/cli/init.test.ts` — extend the init test to assert `AGENTS.md` is written, `CLAUDE.md` is a shim, and both are committed.

Each file has one clear responsibility. The builder is pure (vault in → string out), the server wires it once, init writes the right scaffolding files, the docs comment matches reality.

---

## Task 1: `buildInstructions` builder (TDD)

**Files:**
- Create: `src/mcp/instructions-builder.ts`
- Create: `tests/mcp/instructions-builder.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/mcp/instructions-builder.test.ts` with the following content:

```typescript
import { describe, test, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildInstructions } from "../../src/mcp/instructions-builder";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";

describe("buildInstructions", () => {
  test("includes system-base content", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const out = await buildInstructions(res.value);
      // system-base.md opens with this heading; if it ever changes the test
      // will catch it and we update both intentionally.
      expect(out).toContain("# Dome — Wiki Maintainer");
      expect(out).toContain("RAW_IS_IMMUTABLE");
    } finally {
      await v.cleanup();
    }
  });

  test("lists enabled invariants but omits disabled ones", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const out = await buildInstructions(res.value);
      // Default config: EVERY_WRITE_IS_LOGGED=enabled, SENSITIVE_GOES_TO_INBOX=disabled.
      expect(out).toContain("### Enabled invariants");
      expect(out).toContain("- EVERY_WRITE_IS_LOGGED");
      expect(out).not.toContain("- SENSITIVE_GOES_TO_INBOX");
    } finally {
      await v.cleanup();
    }
  });

  test("lists page-type defaults and extensions", async () => {
    const customPageTypes = `defaults:
  - entity
  - concept
  - source
  - synthesis
extensions:
  - decision
  - { name: meeting }
`;
    const v = await makeTestVault({ pageTypes: customPageTypes });
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const out = await buildInstructions(res.value);
      expect(out).toContain("### Page types");
      expect(out).toContain("- entity");
      expect(out).toContain("- synthesis");
      expect(out).toContain("- decision");
      expect(out).toContain("- meeting");
    } finally {
      await v.cleanup();
    }
  });

  test("inlines AGENTS.md when present", async () => {
    const v = await makeTestVault();
    try {
      await writeFile(
        join(v.path, "AGENTS.md"),
        "# This vault\n\nNotes: this vault tracks Project Foo.\n",
      );
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const out = await buildInstructions(res.value);
      expect(out).toContain("### Vault notes (from AGENTS.md)");
      expect(out).toContain("Project Foo");
    } finally {
      await v.cleanup();
    }
  });

  test("falls back gracefully when AGENTS.md is absent", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const out = await buildInstructions(res.value);
      expect(out).toContain("### Vault notes (from AGENTS.md)");
      expect(out).toContain("_No AGENTS.md present._");
    } finally {
      await v.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/mcp/instructions-builder.test.ts`
Expected: FAIL with `Cannot find module '../../src/mcp/instructions-builder'`

- [ ] **Step 3: Write the builder implementation**

Create `src/mcp/instructions-builder.ts` with the following content:

```typescript
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Vault } from "../vault";
import { PromptLoader } from "../prompts/prompt-loader";

// Assembles the MCP server's `instructions` string — the rich, per-vault
// orientation every connecting client receives on `initialize`. Layering:
//   - system-base.md: universal Dome rules (loaded via PromptLoader so it
//     is bit-identical to the workflow-time `{{include}}` path).
//   - .dome/config.yaml enabled invariants: per-vault flag digest.
//   - .dome/page-types.yaml defaults + extensions: per-vault page-type set.
//   - AGENTS.md: per-vault user-tended notes (graceful fallback when absent).
export async function buildInstructions(vault: Vault): Promise<string> {
  const loader = new PromptLoader(vault);
  const systemBase = await loader.load("system-base");
  const systemBaseBody = systemBase?.body ?? "";

  const enabledInvariants = Object.entries(vault.config.invariants)
    .filter(([, v]) => v === "enabled")
    .map(([k]) => `- ${k}`)
    .join("\n");

  const pageTypes = [
    ...vault.pageTypes.defaults,
    ...vault.pageTypes.extensions.map((e) => (typeof e === "string" ? e : e.name)),
  ]
    .map((t) => `- ${t}`)
    .join("\n");

  const agentsPath = join(vault.path, "AGENTS.md");
  const vaultNotes = existsSync(agentsPath)
    ? await readFile(agentsPath, "utf8")
    : "_No AGENTS.md present._";

  return [
    systemBaseBody,
    "",
    "## This vault",
    "",
    "### Enabled invariants",
    enabledInvariants || "_(none enabled)_",
    "",
    "### Page types",
    pageTypes,
    "",
    "### Vault notes (from AGENTS.md)",
    vaultNotes,
  ].join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/mcp/instructions-builder.test.ts`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/instructions-builder.ts tests/mcp/instructions-builder.test.ts
git commit -m "feat(mcp): add buildInstructions for rich cold-start orientation"
```

---

## Task 2: Wire `instructions` into `DomeMcpServer`

**Files:**
- Modify: `src/mcp/server.ts:11-46` — add `instructions()` accessor; pass to `new Server`.
- Modify: `tests/mcp/server.test.ts` — add a test asserting `instructions()` returns the rich blob.

- [ ] **Step 1: Write the failing test**

Add this test inside the `describe("DomeMcpServer", ...)` block in `tests/mcp/server.test.ts` (e.g. after the "resources/list" test):

```typescript
  test("instructions() returns rich orientation: system-base + invariants + page types + AGENTS.md fallback", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const server = new DomeMcpServer({ vault: res.value });
      const out = await server.instructions();
      expect(out).toContain("# Dome — Wiki Maintainer");
      expect(out).toContain("### Enabled invariants");
      expect(out).toContain("- EVERY_WRITE_IS_LOGGED");
      expect(out).toContain("### Page types");
      expect(out).toContain("- entity");
      expect(out).toContain("### Vault notes (from AGENTS.md)");
      expect(out).toContain("_No AGENTS.md present._");
    } finally {
      await v.cleanup();
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/mcp/server.test.ts`
Expected: FAIL with `server.instructions is not a function` (or TypeScript compile error).

- [ ] **Step 3: Add the accessor and wire it into `serveStdio`**

Modify `src/mcp/server.ts`. Replace the current file body with:

```typescript
import type { Vault } from "../vault";
import { buildToolAdapters, type ToolAdapter } from "./tool-adapters";
import { buildPromptAdapters, type PromptAdapter } from "./prompt-adapters";
import { ResourceAdapter } from "./resource-adapters";
import { registerHandlers, type ServerLike } from "./handlers";
import { buildInstructions } from "./instructions-builder";

export interface DomeMcpServerOpts {
  vault: Vault;
}

export class DomeMcpServer {
  readonly tools: ToolAdapter[];
  readonly resources: ResourceAdapter;
  private _prompts: PromptAdapter[] | null = null;
  private _instructions: string | null = null;

  constructor(private opts: DomeMcpServerOpts) {
    this.tools = buildToolAdapters(opts.vault);
    this.resources = new ResourceAdapter(opts.vault);
  }

  async prompts(): Promise<PromptAdapter[]> {
    if (this._prompts) return this._prompts;
    this._prompts = await buildPromptAdapters(this.opts.vault);
    return this._prompts;
  }

  // Rich cold-start orientation for every connecting MCP client. Cached
  // because it's assembled once at server start and clients see it via
  // `initialize`; edits to AGENTS.md or .dome/config.yaml require a server
  // restart to take effect.
  async instructions(): Promise<string> {
    if (this._instructions !== null) return this._instructions;
    this._instructions = await buildInstructions(this.opts.vault);
    return this._instructions;
  }

  // Register all 6 request handlers on the given Server-like object. Exposed
  // separately so tests can drive it against a stub Server without spinning
  // up the stdio transport. Called by `serveStdio`.
  async registerOn(server: ServerLike): Promise<void> {
    const prompts = await this.prompts();
    registerHandlers(server, { tools: this.tools, prompts, resources: this.resources });
  }

  async serveStdio(): Promise<void> {
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const instructions = await this.instructions();
    const server = new Server(
      { name: "@dome/sdk", version: "0.0.1" },
      { capabilities: { tools: {}, prompts: {}, resources: {} }, instructions }
    );
    await this.registerOn(server as unknown as ServerLike);
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/mcp/server.test.ts`
Expected: PASS for the new test plus all existing server tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts tests/mcp/server.test.ts
git commit -m "feat(mcp): pass rich instructions to Server on serveStdio"
```

---

## Task 3: `dome init` writes `AGENTS.md` + 1-line `CLAUDE.md` shim

**Files:**
- Modify: `src/cli/commands/init.ts:8-61` — replace `SHIPPED_CLAUDE_MD` with `SHIPPED_AGENTS_MD`; write both `AGENTS.md` and a thin `CLAUDE.md` shim; commit both.
- Modify: `src/vault-scaffold.ts:9-13` — update the leading comment to reflect the new init extras.
- Modify: `tests/cli/init.test.ts:10-29` — extend test to cover AGENTS.md, CLAUDE.md shim, and successful initial commit.

- [ ] **Step 1: Write the failing test additions**

Replace the existing first test in `tests/cli/init.test.ts` (the `"produces a working vault..."` test) with this expanded version. Read the current file (`tests/cli/init.test.ts`) and replace its `test("produces a working vault...")` block with:

```typescript
  test("produces a working vault with AGENTS.md, CLAUDE.md shim, intake-raw + inbox/raw/ + initial git commit", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-init-"));
    const target = join(base, "test-vault");
    try {
      const result = await domeInit(target);
      expect(result.ok).toBe(true);
      // Required artifacts
      expect(existsSync(join(target, ".dome", "config.yaml"))).toBe(true);
      expect(existsSync(join(target, ".dome", "hooks", "intake-raw.yaml"))).toBe(true);
      expect(existsSync(join(target, "inbox", "raw"))).toBe(true);
      expect(existsSync(join(target, "index.md"))).toBe(true);
      expect(existsSync(join(target, "log.md"))).toBe(true);
      expect(existsSync(join(target, ".git"))).toBe(true);
      // New cold-start scaffolding: AGENTS.md is the vault-owned per-vault file,
      // CLAUDE.md is a content-free shim pointing at AGENTS.md.
      const agentsPath = join(target, "AGENTS.md");
      const claudePath = join(target, "CLAUDE.md");
      expect(existsSync(agentsPath)).toBe(true);
      expect(existsSync(claudePath)).toBe(true);
      const agentsBody = await readFile(agentsPath, "utf8");
      expect(agentsBody).toContain("# This vault");
      expect(agentsBody).toContain("Dome vault");
      // The user-editable section is delimited by HTML comments so dome doctor
      // can re-template scaffolding without touching user prose.
      expect(agentsBody).toContain("<!--");
      const claudeBody = await readFile(claudePath, "utf8");
      expect(claudeBody.trim()).toBe("See AGENTS.md.");
      // openVault succeeds
      const vault = await openVault(target);
      expect(vault.ok).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
```

Also add `readFile` to the imports at the top of the file. Replace:

```typescript
import { mkdtemp, rm } from "node:fs/promises";
```

with:

```typescript
import { mkdtemp, rm, readFile } from "node:fs/promises";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/cli/init.test.ts`
Expected: FAIL with `existsSync(join(target, "AGENTS.md"))` returning `false`.

- [ ] **Step 3: Update `src/cli/commands/init.ts`**

Replace the entire contents of `src/cli/commands/init.ts` with:

```typescript
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initRepo, commit } from "../../git";
import { scaffoldVaultLayout } from "../../vault-scaffold";
import { ok, err, type Result, type ToolError } from "../../types";

const INTAKE_RAW_HOOK_YAML = `# Shipped-default intake hook
event: document.written
path_pattern: "inbox/raw/*"
workflow: ingest
async: true
idempotent: true
`;

// AGENTS.md is the vault-owned per-vault file: cross-harness convention, user-
// tendable, never clobbered by SDK updates after init. System rules deliberately
// live OFF this file — the MCP server delivers them as `instructions` at mount
// time. The HTML-comment block delimits the user-editable section so future
// `dome doctor --repair` runs can re-template scaffolding without touching
// user prose.
const SHIPPED_AGENTS_MD = `# This vault

A Dome vault. Operate it through the dome MCP server — it carries the universal
rules, the current invariant flags, and the tool surface. Mount with:

    bun x @dome/sdk serve --vault .

## Cold-start without MCP

If MCP isn't mounted yet, the bare minimum you need:
- \`.dome/config.yaml\` — which invariants are enabled in this vault
- \`.dome/page-types.yaml\` — page types beyond the four shipped defaults
- Never write to \`raw/\`. Never mutate \`log.md\` or \`index.md\` directly.
- Mount the MCP server before doing anything else; the full rule set lives there.

## Vault notes

<!-- Tend this section over time. Examples of what belongs here:
     - Projects this vault tracks
     - Personal naming conventions
     - Directories with special meaning beyond Dome's defaults
     - People/entities the agent should know exist
-->
`;

// CLAUDE.md exists only as a harness shim. Claude Code's auto-load convention
// currently prefers CLAUDE.md; this points at AGENTS.md so all content lives
// in one place. Remove once AGENTS.md auto-load is universal across harnesses.
const SHIPPED_CLAUDE_MD_SHIM = `See AGENTS.md.\n`;

export async function domeInit(vaultPath: string): Promise<Result<{ path: string; sha: string }, ToolError>> {
  if (existsSync(join(vaultPath, ".dome"))) {
    return err({ kind: "already-exists", path: vaultPath });
  }
  if (existsSync(join(vaultPath, ".git"))) {
    return err({ kind: "validation", message: `Existing .git at ${vaultPath}; use dome migrate instead` });
  }

  // Scaffold the canonical vault layout (dir tree + shipped config). Returns
  // the list of files actually written so we know what to commit.
  const scaffolded = await scaffoldVaultLayout(vaultPath);

  // Init-specific extras: the shipped-default intake hook, AGENTS.md (vault-
  // owned cold-start file), and a CLAUDE.md shim pointing at AGENTS.md.
  // Migrate does NOT write these — an existing vault may have its own.
  const intakeRel = ".dome/hooks/intake-raw.yaml";
  const agentsRel = "AGENTS.md";
  const claudeRel = "CLAUDE.md";
  await writeFile(join(vaultPath, intakeRel), INTAKE_RAW_HOOK_YAML);
  await writeFile(join(vaultPath, agentsRel), SHIPPED_AGENTS_MD);
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

- [ ] **Step 4: Update the leading comment in `src/vault-scaffold.ts`**

In `src/vault-scaffold.ts` lines 9-13, replace:

```typescript
// Each consumer decorates the skeleton with its own extras (init adds
// CLAUDE.md + intake-raw.yaml + initial commit; fixture writes test files;
// migrate leaves existing content untouched). Centralizing prevents drift —
// the three callers previously copy-pasted the directory tree + config
// strings and had already begun diverging.
```

with:

```typescript
// Each consumer decorates the skeleton with its own extras (init adds
// AGENTS.md + CLAUDE.md shim + intake-raw.yaml + initial commit; fixture
// writes test files; migrate leaves existing content untouched). Centralizing
// prevents drift — the three callers previously copy-pasted the directory
// tree + config strings and had already begun diverging.
```

- [ ] **Step 5: Run the init test to verify it passes**

Run: `bun test tests/cli/init.test.ts`
Expected: PASS for both tests.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/init.ts src/vault-scaffold.ts tests/cli/init.test.ts
git commit -m "feat(init): write AGENTS.md + CLAUDE.md shim instead of MCP-config CLAUDE.md"
```

---

## Task 4: Full-suite regression check

**Files:** none modified.

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: ALL tests pass. No regressions in any subsystem.

If any test fails, the most likely cause is a fixture or eval vault that hard-coded the old `CLAUDE.md` content. Investigate the failure, decide whether the fixture or the new behavior is right, and fix accordingly. Document the choice in the commit message.

- [ ] **Step 2: Run the invariants subset for belt-and-suspenders**

Run: `bun test:invariants`
Expected: PASS.

- [ ] **Step 3: Sanity-check by running `dome init` against a scratch directory**

```bash
mkdir -p /tmp/dome-coldstart-check && cd /tmp/dome-coldstart-check && bun /Users/mark.toda/dev/dome/bin/dome init test-vault && ls test-vault && head -5 test-vault/AGENTS.md && cat test-vault/CLAUDE.md
```

Expected output:
- `test-vault/` directory listing shows `AGENTS.md`, `CLAUDE.md`, `.dome/`, `index.md`, `log.md`, etc.
- `AGENTS.md` first lines: `# This vault`
- `CLAUDE.md` contents: `See AGENTS.md.`

Cleanup: `rm -rf /tmp/dome-coldstart-check`

- [ ] **Step 4: No commit needed for this task** — verification only.

---

## Self-Review

**Spec coverage:**
- Three-layer architecture (SDK / vault / harness shim): Task 1 (builder pulls system-base from SDK), Task 3 (init writes AGENTS.md + CLAUDE.md shim). ✓
- Rich instructions, no optionality: Task 1 assembles full blob unconditionally; Task 2 passes it on every `serveStdio`. ✓
- Single source of truth for system-base: Task 1 uses `PromptLoader.load("system-base")`, the same path used by `prompt-adapters.ts`. ✓
- Graceful fallback when AGENTS.md absent (migrate path): Task 1 test 5 + builder's `existsSync` check. ✓
- Per-vault customization surfaces via config flags + page-types: Task 1 tests 2 and 3. ✓
- HTML-comment-bounded user section for future `dome doctor --repair` idempotency: Task 3 step 3 template. ✓
- Migrate command stays hands-off: not modified — by omission, migrated vaults get "_No AGENTS.md present._" in instructions, which is the correct graceful-degradation path documented in Task 1 test 5.

**Placeholder scan:** No TBDs, no "implement later", no "similar to Task N", no "add validation." Every step has full code.

**Type consistency:** `buildInstructions(vault: Vault): Promise<string>` — same signature referenced in Tasks 1 and 2. `DomeMcpServer.instructions(): Promise<string>` — same in Task 2 server impl and Task 2 test. `AGENTS.md` filename consistent across Tasks 1, 2, and 3. The user-section delimiter (`<!--` ... `-->`) and the CLAUDE.md shim contents (`See AGENTS.md.\n`) are consistent across the init source and the init test assertions.
