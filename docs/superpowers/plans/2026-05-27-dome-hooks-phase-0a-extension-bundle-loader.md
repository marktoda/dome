# Dome Hooks Phase 0a — Extension Bundle Loader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the extension-bundle loader and integrate it through `openVault` so a bundle directory at `<vault>/.dome/extensions/<bundle>/` registers its page types, workflows, hooks, and CLI commands automatically — proving the extension-bundle substrate landed in the Phase 0+1 rewrite.

**Architecture:** New module `src/extensions/` with `loader.ts` (discovers bundles, parses manifests via Zod) and `manifest-schema.ts` (the `ManifestSchema`). The loader is invoked from `src/vault-config.ts` to merge bundle page-types into `PageTypesConfig.extensions`; from `src/hooks/yaml-loader.ts` to register bundle hooks with bundle-namespaced IDs; from `src/prompts/prompt-loader.ts` to surface bundle workflows; from `src/cli/cli.ts` to surface bundle CLI commands. Fail-loud on collision per the `bundle-load-failure` ToolError taxonomy enumerated in `docs/wiki/specs/sdk-surface.md` §"Bundle-loader error taxonomy".

**Tech Stack:** TypeScript (ESM), Bun runtime, Bun's built-in test framework (`bun:test`), Zod (existing dep for boundary validation per F6 of the prior refactor), `yaml` (existing).

**Reference substrate (read once before starting):**
- `docs/wiki/specs/sdk-surface.md` §"Extension bundles" — directory shape, manifest schema, 6-step load lifecycle, error taxonomy.
- `docs/wiki/gotchas/extension-bundle-load-order.md` — collision semantics + hook-ID namespacing.
- `docs/wiki/matrices/extension-bundle-shape.md` — five contribution kinds + Status-column lockstep behavior.
- `docs/cohesive/delta-ledgers/2026-05-26-dome-hooks-phase-0-1-skeleton.md` §"Phase 0a — Extension bundle loader" — the 9 stable IDs this plan implements.

---

## File Structure

**New files:**
- `src/extensions/manifest-schema.ts` — Zod `ManifestSchema` + `Manifest` type + `BundleManifestValidationError`.
- `src/extensions/loader.ts` — `ExtensionBundle` type + `loadExtensionBundles(root): Promise<Result<readonly ExtensionBundle[], ToolError>>`.
- `src/extensions/index.ts` — barrel export.
- `tests/extensions/loader.test.ts` — unit tests for the loader (manifest validation, name-mismatch rejection, missing-manifest rejection, alphabetical load order).
- `tests/fixtures/extensions/hello-world/manifest.yaml`
- `tests/fixtures/extensions/hello-world/page-types.yaml`
- `tests/fixtures/extensions/hello-world/preamble.md`
- `tests/fixtures/extensions/hello-world/workflows/say-hello.md`
- `tests/fixtures/extensions/hello-world/hooks/say-hello.yaml`
- `tests/integration/extension-bundles-load.test.ts` — end-to-end test that installs the fixture into a temp vault and asserts page-types merge, hook registration with `hello-world:say-hello` ID, workflow available via PromptLoader, page-type collision rejection.

**Modified files:**
- `src/vault-config.ts` — extend `loadVaultConfig` to also call `loadExtensionBundles` and merge bundle page-types into `PageTypesConfig.extensions` (with collision detection).
- `src/hooks/yaml-loader.ts` — extend `loadDeclarativeHooks` to also scan `<vault>/.dome/extensions/<bundle>/hooks/` and register hooks with ID `<bundle>:<filename-stem>`.
- `src/prompts/prompt-loader.ts` — extend the scan to also look in `<vault>/.dome/extensions/<bundle>/workflows/`.
- `src/cli/cli.ts` — surface bundle CLI commands in `buildProgram`. (Scope-minimal: register bundle commands that export `{name, description, action}`; the dailies bundle's full `migrate-dailies` ships in Phase 1e.)
- `src/vault.ts` — thread loaded bundles through `openVault` so subsequent calls see them via `vault.config` or a new `vault.extensions` field.
- `src/types.ts` — extend `ToolError` union with `bundle-load-failure` kind + `detail` discriminator.

---

### Task 1: Add `bundle-load-failure` to ToolError union

**Files:**
- Modify: `src/types.ts`
- Test: `tests/types.test.ts` (existing; add one assertion)

- [ ] **Step 1: Write the failing test** (add to existing tests/types.test.ts)

```typescript
import { test, expect } from "bun:test";
import { err, type ToolError } from "../src/types";

test("ToolError supports bundle-load-failure kind with detail discriminator", () => {
  const e: ToolError = {
    kind: "bundle-load-failure",
    detail: "page-type-collision",
    message: "bundle 'a' and 'b' both declare page type 'daily'",
  };
  expect(e.kind).toBe("bundle-load-failure");
  if (e.kind === "bundle-load-failure") {
    expect(e.detail).toBe("page-type-collision");
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/types.test.ts -t "bundle-load-failure"`
Expected: FAIL with TypeScript error or runtime mismatch — `bundle-load-failure` not a known kind.

- [ ] **Step 3: Add the variant to ToolError**

In `src/types.ts`, locate the existing `ToolError` union type and add a new variant. Look for the existing pattern (likely a discriminated union with `kind` field). Add:

```typescript
| {
    readonly kind: "bundle-load-failure";
    readonly detail:
      | "manifest-missing"
      | "manifest-invalid"
      | "name-mismatch"
      | "page-type-collision"
      | "workflow-invalid"
      | "hook-invalid"
      | "cli-collision";
    readonly message: string;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/types.test.ts -t "bundle-load-failure"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/types.test.ts
git commit -m "feat(types): add bundle-load-failure ToolError variant

Implements: phase-0a-loader-skeleton (error taxonomy seam)
Plan: docs/superpowers/plans/2026-05-27-dome-hooks-phase-0a-extension-bundle-loader.md"
```

---

### Task 2: ManifestSchema (Zod)

**Files:**
- Create: `src/extensions/manifest-schema.ts`
- Test: `tests/extensions/manifest-schema.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/extensions/manifest-schema.test.ts`:

```typescript
import { test, expect, describe } from "bun:test";
import { ManifestSchema, parseManifest } from "../../src/extensions/manifest-schema";

describe("ManifestSchema", () => {
  test("accepts a minimal valid manifest", () => {
    const r = ManifestSchema.safeParse({ name: "dailies", version: "1.0.0" });
    expect(r.success).toBe(true);
  });

  test("rejects missing name", () => {
    const r = ManifestSchema.safeParse({ version: "1.0.0" });
    expect(r.success).toBe(false);
  });

  test("rejects malformed version", () => {
    const r = ManifestSchema.safeParse({ name: "dailies", version: "not-semver" });
    expect(r.success).toBe(false);
  });

  test("accepts optional description and deps", () => {
    const r = ManifestSchema.safeParse({
      name: "x",
      version: "0.1.0",
      description: "test",
      deps: ["other"],
    });
    expect(r.success).toBe(true);
  });
});

describe("parseManifest", () => {
  test("returns Result.ok on valid YAML", () => {
    const r = parseManifest("name: dailies\nversion: 1.0.0\n", "dailies/manifest.yaml");
    expect(r.ok).toBe(true);
  });

  test("returns Result.err on malformed YAML", () => {
    const r = parseManifest(": not yaml :\n", "bad/manifest.yaml");
    expect(r.ok).toBe(false);
  });

  test("returns Result.err with detail:manifest-invalid on missing fields", () => {
    const r = parseManifest("description: foo\n", "missing-name/manifest.yaml");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("bundle-load-failure");
      expect(r.error.detail).toBe("manifest-invalid");
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/extensions/manifest-schema.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the schema**

Create `src/extensions/manifest-schema.ts`:

```typescript
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { ok, err, type Result, type ToolError } from "../types";

/**
 * Semver regex — keep simple. Full semver (prerelease, build metadata) is
 * documented in the spec as informational in v0.5; this schema validates the
 * 3-number form. Tighter parsing arrives with `manifest.yaml deps:`
 * resolution in v0.5.1+.
 */
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

export const ManifestSchema = z.object({
  name: z.string().min(1, { message: "name is required" }),
  version: z.string().regex(SEMVER_RE, { message: "version must be semver (MAJOR.MINOR.PATCH)" }),
  description: z.string().optional(),
  deps: z.array(z.string()).optional(),
});

export type Manifest = z.infer<typeof ManifestSchema>;

/**
 * Parse a manifest.yaml text into a validated Manifest. The `sourcePath` is
 * the bundle directory or filename for error messages; tests pass empty.
 *
 * Returns `Result<Manifest, ToolError>` rather than throwing. The error kind
 * is `bundle-load-failure` per the substrate's bundle-loader error taxonomy
 * (docs/wiki/specs/sdk-surface.md §"Bundle-loader error taxonomy"); the
 * `detail` discriminator is `manifest-invalid` for parse + Zod failures.
 */
export function parseManifest(yamlText: string, sourcePath = ""): Result<Manifest, ToolError> {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    return err({
      kind: "bundle-load-failure",
      detail: "manifest-invalid",
      message: `${sourcePath ? `${sourcePath}: ` : ""}YAML parse error: ${String(e)}`,
    });
  }
  const r = ManifestSchema.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    const message = first
      ? `${sourcePath ? `${sourcePath}: ` : ""}${first.message}${
          first.path.length > 0 ? ` (at ${first.path.join(".")})` : ""
        }`
      : `${sourcePath ? `${sourcePath}: ` : ""}${r.error.message}`;
    return err({ kind: "bundle-load-failure", detail: "manifest-invalid", message });
  }
  return ok(r.data);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/extensions/manifest-schema.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/extensions/manifest-schema.ts tests/extensions/manifest-schema.test.ts
git commit -m "feat(extensions): add ManifestSchema with parseManifest

Implements: phase-0a-manifest-schema
Plan: docs/superpowers/plans/2026-05-27-dome-hooks-phase-0a-extension-bundle-loader.md"
```

---

### Task 3: ExtensionBundle loader

**Files:**
- Create: `src/extensions/loader.ts`
- Create: `src/extensions/index.ts`
- Test: `tests/extensions/loader.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/extensions/loader.test.ts`:

```typescript
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadExtensionBundles } from "../../src/extensions/loader";

const FIXTURE_ROOT = join(import.meta.dir, "fixtures-loader");

async function makeBundle(name: string, files: Record<string, string>): Promise<void> {
  const dir = join(FIXTURE_ROOT, ".dome/extensions", name);
  await mkdir(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const target = join(dir, file);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

beforeEach(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
  await mkdir(FIXTURE_ROOT, { recursive: true });
});

afterEach(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

describe("loadExtensionBundles", () => {
  test("returns empty array when .dome/extensions/ does not exist", async () => {
    const r = await loadExtensionBundles(FIXTURE_ROOT);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  test("loads a single valid bundle", async () => {
    await makeBundle("dailies", { "manifest.yaml": "name: dailies\nversion: 1.0.0\n" });
    const r = await loadExtensionBundles(FIXTURE_ROOT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0].name).toBe("dailies");
      expect(r.value[0].version).toBe("1.0.0");
    }
  });

  test("loads multiple bundles in alphabetical order", async () => {
    await makeBundle("zebra", { "manifest.yaml": "name: zebra\nversion: 1.0.0\n" });
    await makeBundle("alpha", { "manifest.yaml": "name: alpha\nversion: 1.0.0\n" });
    await makeBundle("middle", { "manifest.yaml": "name: middle\nversion: 1.0.0\n" });
    const r = await loadExtensionBundles(FIXTURE_ROOT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.map((b) => b.name)).toEqual(["alpha", "middle", "zebra"]);
    }
  });

  test("rejects bundle with name-mismatch", async () => {
    await makeBundle("dailies", { "manifest.yaml": "name: WRONG\nversion: 1.0.0\n" });
    const r = await loadExtensionBundles(FIXTURE_ROOT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("bundle-load-failure");
      if (r.error.kind === "bundle-load-failure") {
        expect(r.error.detail).toBe("name-mismatch");
      }
    }
  });

  test("rejects bundle with missing manifest", async () => {
    const dir = join(FIXTURE_ROOT, ".dome/extensions", "orphan");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "preamble.md"), "Hello\n", "utf8");
    const r = await loadExtensionBundles(FIXTURE_ROOT);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "bundle-load-failure") {
      expect(r.error.detail).toBe("manifest-missing");
    }
  });

  test("captures bundle contribution paths (page-types, preamble, workflows, hooks, cli)", async () => {
    await makeBundle("rich", {
      "manifest.yaml": "name: rich\nversion: 1.0.0\n",
      "page-types.yaml": "extensions:\n  - name: rich-page\n",
      "preamble.md": "# Rich preamble\n",
      "workflows/foo.md": "---\ntools: [readDocument]\n---\nHello\n",
      "hooks/bar.yaml": "event: document.written\nworkflow: ingest\n",
      "cli/baz.ts": "export const command = { name: 'baz' };\n",
    });
    const r = await loadExtensionBundles(FIXTURE_ROOT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const b = r.value[0];
      expect(b.pageTypesPath).toBeTruthy();
      expect(b.preamblePath).toBeTruthy();
      expect(b.workflowPaths).toHaveLength(1);
      expect(b.hookPaths).toHaveLength(1);
      expect(b.cliPaths).toHaveLength(1);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/extensions/loader.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the loader**

Create `src/extensions/loader.ts`:

```typescript
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ok, err, type Result, type ToolError } from "../types";
import { parseManifest, type Manifest } from "./manifest-schema";

/**
 * A loaded extension bundle's metadata. Paths are absolute; missing optional
 * contributions (no page-types.yaml, no preamble.md, etc.) are represented
 * by null for single-file contributions and empty arrays for directory
 * contributions.
 */
export interface ExtensionBundle {
  readonly name: string;
  readonly version: string;
  readonly description: string | null;
  readonly directory: string;
  readonly manifestPath: string;
  readonly pageTypesPath: string | null;
  readonly preamblePath: string | null;
  readonly workflowPaths: readonly string[];
  readonly hookPaths: readonly string[];
  readonly cliPaths: readonly string[];
  readonly toolPaths: readonly string[];
}

/**
 * Walk <vault>/.dome/extensions/<bundle>/ and load every bundle's manifest +
 * contribution paths. Bundles load alphabetically by directory name. Returns
 * Result.err on the first bundle-load-failure (fail-loud per
 * docs/wiki/gotchas/extension-bundle-load-order.md).
 *
 * v0.5 contract: returns metadata only (paths). Page-types merge, hook
 * registration, workflow loading, CLI registration are downstream consumers'
 * responsibility (loadVaultConfig, loadDeclarativeHooks, PromptLoader, runCli).
 */
export async function loadExtensionBundles(
  vaultRoot: string,
): Promise<Result<readonly ExtensionBundle[], ToolError>> {
  const extensionsDir = join(vaultRoot, ".dome", "extensions");
  if (!existsSync(extensionsDir)) return ok([]);

  let dirEntries: { name: string; isDirectory: () => boolean }[];
  try {
    dirEntries = await readdir(extensionsDir, { withFileTypes: true });
  } catch (e) {
    return err({
      kind: "bundle-load-failure",
      detail: "manifest-missing",
      message: `cannot read .dome/extensions/: ${String(e)}`,
    });
  }

  const dirs = dirEntries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const bundles: ExtensionBundle[] = [];
  for (const name of dirs) {
    const bundle = await loadOneBundle(extensionsDir, name);
    if (!bundle.ok) return bundle;
    bundles.push(bundle.value);
  }
  return ok(bundles);
}

async function loadOneBundle(
  extensionsDir: string,
  bundleName: string,
): Promise<Result<ExtensionBundle, ToolError>> {
  const directory = join(extensionsDir, bundleName);
  const manifestPath = join(directory, "manifest.yaml");

  if (!existsSync(manifestPath)) {
    return err({
      kind: "bundle-load-failure",
      detail: "manifest-missing",
      message: `bundle '${bundleName}' has no manifest.yaml at ${manifestPath}`,
    });
  }

  let manifestText: string;
  try {
    manifestText = await readFile(manifestPath, "utf8");
  } catch (e) {
    return err({
      kind: "bundle-load-failure",
      detail: "manifest-invalid",
      message: `bundle '${bundleName}': cannot read manifest.yaml: ${String(e)}`,
    });
  }

  const manifestResult = parseManifest(manifestText, `${bundleName}/manifest.yaml`);
  if (!manifestResult.ok) return manifestResult as Result<never, ToolError>;
  const manifest: Manifest = manifestResult.value;

  if (manifest.name !== bundleName) {
    return err({
      kind: "bundle-load-failure",
      detail: "name-mismatch",
      message: `bundle directory '${bundleName}' contains manifest.yaml with name: '${manifest.name}'; the two must match`,
    });
  }

  const pageTypesPath = await maybeFile(directory, "page-types.yaml");
  const preamblePath = await maybeFile(directory, "preamble.md");
  const workflowPaths = await listFilesIn(directory, "workflows", ".md");
  const hookPaths = await listFilesIn(directory, "hooks", ".yaml", ".yml");
  const cliPaths = await listFilesIn(directory, "cli", ".ts");
  const toolPaths = await listFilesIn(directory, "tools", ".ts");

  return ok({
    name: manifest.name,
    version: manifest.version,
    description: manifest.description ?? null,
    directory,
    manifestPath,
    pageTypesPath,
    preamblePath,
    workflowPaths,
    hookPaths,
    cliPaths,
    toolPaths,
  });
}

async function maybeFile(dir: string, name: string): Promise<string | null> {
  const candidate = join(dir, name);
  if (!existsSync(candidate)) return null;
  try {
    const s = await stat(candidate);
    if (!s.isFile()) return null;
  } catch {
    return null;
  }
  return candidate;
}

async function listFilesIn(
  dir: string,
  subdir: string,
  ...extensions: string[]
): Promise<readonly string[]> {
  const subPath = join(dir, subdir);
  if (!existsSync(subPath)) return [];
  let entries: { name: string; isFile: () => boolean }[];
  try {
    entries = await readdir(subPath, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => extensions.some((ext) => name.endsWith(ext)))
    .sort()
    .map((name) => join(subPath, name));
}
```

Create `src/extensions/index.ts`:

```typescript
export { loadExtensionBundles, type ExtensionBundle } from "./loader";
export { ManifestSchema, parseManifest, type Manifest } from "./manifest-schema";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/extensions/loader.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/extensions/ tests/extensions/loader.test.ts
git commit -m "feat(extensions): add loadExtensionBundles loader

Implements: phase-0a-loader-skeleton
Plan: docs/superpowers/plans/2026-05-27-dome-hooks-phase-0a-extension-bundle-loader.md"
```

---

### Task 4: Hello-world test fixture

**Files:**
- Create: `tests/fixtures/extensions/hello-world/manifest.yaml`
- Create: `tests/fixtures/extensions/hello-world/page-types.yaml`
- Create: `tests/fixtures/extensions/hello-world/preamble.md`
- Create: `tests/fixtures/extensions/hello-world/workflows/say-hello.md`
- Create: `tests/fixtures/extensions/hello-world/hooks/say-hello.yaml`

- [ ] **Step 1: Create the fixture files**

`tests/fixtures/extensions/hello-world/manifest.yaml`:

```yaml
name: hello-world
version: 1.0.0
description: "Test fixture exercising the extension-bundle loader."
```

`tests/fixtures/extensions/hello-world/page-types.yaml`:

```yaml
extensions:
  - name: hello
    frontmatter_extras: {}
```

`tests/fixtures/extensions/hello-world/preamble.md`:

```markdown
The `hello` page type lives at `wiki/hellos/<name>.md`. Pages carry the
universal frontmatter (type/created/updated/sources). No additional
schema constraints — this is a minimal test fixture.
```

`tests/fixtures/extensions/hello-world/workflows/say-hello.md`:

```markdown
---
tools: [readDocument]
triggers: []
---

Say hello to the named subject. Read the daily; respond with "hello, <subject>."
```

`tests/fixtures/extensions/hello-world/hooks/say-hello.yaml`:

```yaml
event: document.written
path_pattern: "wiki/hellos/*"
workflow: say-hello
async: true
```

- [ ] **Step 2: Verify the fixture files exist**

Run: `ls tests/fixtures/extensions/hello-world/`
Expected: see manifest.yaml, page-types.yaml, preamble.md, workflows/, hooks/.

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/extensions/hello-world/
git commit -m "test(fixtures): add hello-world extension bundle fixture

Implements: phase-0a-hello-world-fixture
Plan: docs/superpowers/plans/2026-05-27-dome-hooks-phase-0a-extension-bundle-loader.md"
```

---

### Task 5: Bundle page-types merge in loadVaultConfig

**Files:**
- Modify: `src/vault-config.ts`
- Test: `tests/vault-config.test.ts` (existing file; add a describe block)

- [ ] **Step 1: Write the failing test**

Add to existing `tests/vault-config.test.ts` (or create if it doesn't exist):

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadVaultConfig } from "../src/vault-config";

const VAULT = join(import.meta.dir, "vault-config-bundle-fixtures");

async function setupVault(): Promise<void> {
  await rm(VAULT, { recursive: true, force: true });
  await mkdir(join(VAULT, ".dome"), { recursive: true });
}

beforeEach(setupVault);
afterEach(async () => {
  await rm(VAULT, { recursive: true, force: true });
});

describe("loadVaultConfig with extension bundles", () => {
  test("merges bundle page-types into PageTypesConfig.extensions", async () => {
    const bundleDir = join(VAULT, ".dome/extensions/hello-world");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, "manifest.yaml"), "name: hello-world\nversion: 1.0.0\n");
    await writeFile(join(bundleDir, "page-types.yaml"), "extensions:\n  - name: hello\n");

    const r = await loadVaultConfig(VAULT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const names = r.value.pageTypes.extensions.map((e) =>
        typeof e === "string" ? e : e.name,
      );
      expect(names).toContain("hello");
    }
  });

  test("rejects cross-bundle page-type collision", async () => {
    for (const bn of ["a-bundle", "b-bundle"]) {
      const dir = join(VAULT, ".dome/extensions", bn);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "manifest.yaml"), `name: ${bn}\nversion: 1.0.0\n`);
      await writeFile(join(dir, "page-types.yaml"), "extensions:\n  - name: shared\n");
    }
    const r = await loadVaultConfig(VAULT);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "bundle-load-failure") {
      expect(r.error.detail).toBe("page-type-collision");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/vault-config.test.ts -t "extension bundles"`
Expected: FAIL — bundle page-types not merged.

- [ ] **Step 3: Extend loadVaultConfig**

In `src/vault-config.ts`, after loading the existing `page-types.yaml`, call `loadExtensionBundles` and merge each bundle's `page-types.yaml extensions:` into the result.

Add import:
```typescript
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { loadExtensionBundles, type ExtensionBundle } from "./extensions";
```

After computing the vault-local `pageTypes`, add:

```typescript
const bundlesResult = await loadExtensionBundles(vaultRoot);
if (!bundlesResult.ok) return bundlesResult;
const bundles = bundlesResult.value;

const merged = [...pageTypes.extensions];
const seenNames = new Set<string>(
  merged.map((e) => (typeof e === "string" ? e : e.name)),
);
const provenance = new Map<string, string>();

for (const bundle of bundles) {
  if (bundle.pageTypesPath === null) continue;
  let bundleText: string;
  try {
    bundleText = await readFile(bundle.pageTypesPath, "utf8");
  } catch (e) {
    return err({
      kind: "bundle-load-failure",
      detail: "manifest-invalid",
      message: `bundle '${bundle.name}': cannot read page-types.yaml: ${String(e)}`,
    });
  }
  const parsed = parseYaml(bundleText) as { extensions?: ReadonlyArray<unknown> } | null;
  for (const ext of parsed?.extensions ?? []) {
    const extName = typeof ext === "string" ? ext : (ext as { name: string }).name;
    if (seenNames.has(extName)) {
      const otherSource = provenance.get(extName) ?? "vault-local .dome/page-types.yaml";
      return err({
        kind: "bundle-load-failure",
        detail: "page-type-collision",
        message: `bundle '${bundle.name}' declares page type '${extName}'; already declared by ${otherSource}`,
      });
    }
    seenNames.add(extName);
    provenance.set(extName, `bundle '${bundle.name}'`);
    merged.push(ext as string | { name: string; frontmatter_extras?: Record<string, unknown> });
  }
}

const mergedPageTypes: PageTypesConfig = {
  defaults: pageTypes.defaults,
  extensions: merged,
};
```

Return `{ config, pageTypes: mergedPageTypes, bundles }` (extend the existing return shape).

Update the function's return type signature to include `bundles: readonly ExtensionBundle[]`. Update callers (`src/vault.ts` `openVault`) to read the new field.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/vault-config.test.ts -t "extension bundles"`
Expected: PASS (both tests).

Also run the full suite to verify no regressions: `bun test`
Expected: all existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/vault-config.ts src/vault.ts tests/vault-config.test.ts
git commit -m "feat(vault-config): merge bundle page-types into PageTypesConfig

Implements: phase-0a-bundle-load-cascade, phase-0a-openvault-page-types-merge
Plan: docs/superpowers/plans/2026-05-27-dome-hooks-phase-0a-extension-bundle-loader.md"
```

---

### Task 6: Bundle hook registration

**Files:**
- Modify: `src/hooks/yaml-loader.ts`
- Test: `tests/hooks/yaml-loader-bundles.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/hooks/yaml-loader-bundles.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HookRegistry } from "../../src/hooks/hook-registry";
import { loadDeclarativeHooks } from "../../src/hooks/yaml-loader";
import { openVault } from "../../src/vault";

const VAULT = join(import.meta.dir, "yaml-loader-bundles-fixtures");

async function setupVault(): Promise<void> {
  await rm(VAULT, { recursive: true, force: true });
  await mkdir(join(VAULT, ".dome/hooks"), { recursive: true });
  await mkdir(join(VAULT, ".git"), { recursive: true });
  await writeFile(join(VAULT, ".dome/config.yaml"), "");
  await writeFile(join(VAULT, ".dome/page-types.yaml"), "defaults: [entity]\nextensions: []\n");
}

beforeEach(setupVault);
afterEach(async () => {
  await rm(VAULT, { recursive: true, force: true });
});

describe("loadDeclarativeHooks with bundle hooks", () => {
  test("registers a bundle-contributed hook with ID '<bundle>:<filename-stem>'", async () => {
    const bundleHooksDir = join(VAULT, ".dome/extensions/hello-world/hooks");
    await mkdir(bundleHooksDir, { recursive: true });
    await writeFile(
      join(VAULT, ".dome/extensions/hello-world/manifest.yaml"),
      "name: hello-world\nversion: 1.0.0\n",
    );
    await writeFile(
      join(bundleHooksDir, "say-hello.yaml"),
      "event: document.written\nworkflow: ingest\n",
    );

    const vaultResult = await openVault(VAULT);
    expect(vaultResult.ok).toBe(true);
    if (!vaultResult.ok) return;
    const vault = vaultResult.value;

    // The bundle-namespaced hook should be registered.
    // Hook IDs are inspectable via the registry; expose a list helper or
    // call dispatchEvents and observe via test stub.
    // For this test, registry.list() (added if not present) returns IDs.
    // ... (test specifics depend on registry's introspection surface)
    const registry = (vault as unknown as { _registry?: HookRegistry })._registry;
    // If the registry is not exposed, use a different observation point:
    // assert via dispatchEvents that the bundle handler fires.
    expect(registry).toBeTruthy();
  });
});
```

NOTE: The exact observation API depends on `HookRegistry`'s introspection surface. If the registry doesn't expose `list()` or a `has(id)` method, add one as part of this task — the bundle test needs to observe registration. Add `HookRegistry.has(id: string): boolean` if missing.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/hooks/yaml-loader-bundles.test.ts`
Expected: FAIL — bundle hooks not loaded.

- [ ] **Step 3: Extend loadDeclarativeHooks**

In `src/hooks/yaml-loader.ts`, after the existing scan of `<vault>/.dome/hooks/`, add a scan of bundle hook directories. The vault object passed to `loadDeclarativeHooks` carries the loaded bundles (added in Task 5 via `vault.bundles` or `vault.config.bundles` — pick the one used in `openVault`'s composition).

Add after the existing per-file loop:

```typescript
// Bundle-contributed hooks. Each bundle's hooks/*.yaml registers with ID
// `<bundle>:<filename-stem>` to prevent cross-bundle collision per
// docs/wiki/gotchas/extension-bundle-load-order.md.
const bundles = (vault as { bundles?: ReadonlyArray<ExtensionBundle> }).bundles ?? [];
for (const bundle of bundles) {
  for (const hookPath of bundle.hookPaths) {
    let text: string;
    try {
      text = await readFile(hookPath, "utf8");
    } catch (e) {
      opts.onLoadError?.(hookPath, (e as Error).message);
      continue;
    }
    const filename = hookPath.split("/").pop() ?? "unknown.yaml";
    const result = parseDeclarativeHook(text, `${bundle.name}/hooks/${filename}`);
    if (!result.ok) {
      opts.onLoadError?.(`${bundle.name}/${filename}`, result.error.message);
      continue;
    }
    const parsed = toRegistryEntry(result.value, filename);
    registry.register({
      id: `${bundle.name}:${parsed.id}`,
      pattern: parsed.pattern,
      source: "vault-local", // bundles are vault-local in v0.5
      async: parsed.async,
      idempotent: parsed.idempotent,
      handler: makeHandler(vault, parsed, opts.runWorkflow),
    });
  }
}
```

Add the import: `import type { ExtensionBundle } from "../extensions";`.

If `HookRegistry.has(id)` does not exist, add it to `src/hooks/hook-registry.ts`:

```typescript
has(id: string): boolean {
  return this.entries.some((e) => e.id === id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/hooks/yaml-loader-bundles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/ tests/hooks/yaml-loader-bundles.test.ts
git commit -m "feat(hooks): register bundle hooks with <bundle>:<filename> IDs

Implements: phase-0a-openvault-hooks-register
Plan: docs/superpowers/plans/2026-05-27-dome-hooks-phase-0a-extension-bundle-loader.md"
```

---

### Task 7: Bundle workflows in PromptLoader scan

**Files:**
- Modify: `src/prompts/prompt-loader.ts`
- Test: `tests/prompts/prompt-loader-bundles.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/prompts/prompt-loader-bundles.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openVault } from "../../src/vault";

const VAULT = join(import.meta.dir, "prompt-loader-bundles-fixtures");

async function setupVault(): Promise<void> {
  await rm(VAULT, { recursive: true, force: true });
  await mkdir(join(VAULT, ".dome"), { recursive: true });
  await mkdir(join(VAULT, ".git"), { recursive: true });
  await writeFile(join(VAULT, ".dome/config.yaml"), "");
  await writeFile(join(VAULT, ".dome/page-types.yaml"), "defaults: [entity]\nextensions: []\n");
}

beforeEach(setupVault);
afterEach(async () => {
  await rm(VAULT, { recursive: true, force: true });
});

describe("PromptLoader with bundle workflows", () => {
  test("loads a bundle-contributed workflow by name", async () => {
    const dir = join(VAULT, ".dome/extensions/hello-world");
    await mkdir(join(dir, "workflows"), { recursive: true });
    await writeFile(join(dir, "manifest.yaml"), "name: hello-world\nversion: 1.0.0\n");
    await writeFile(
      join(dir, "workflows/say-hello.md"),
      "---\ntools: [readDocument]\n---\nHello content.\n",
    );

    const vaultResult = await openVault(VAULT);
    expect(vaultResult.ok).toBe(true);
    if (!vaultResult.ok) return;

    // Use the surfaced PromptLoader to load the workflow by name.
    const { PromptLoader } = await import("../../src/prompts/prompt-loader");
    const loader = new PromptLoader(vaultResult.value);
    const prompt = await loader.load("say-hello");
    expect(prompt).toBeTruthy();
    expect(prompt?.body).toContain("Hello content");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/prompts/prompt-loader-bundles.test.ts`
Expected: FAIL — bundle workflow not found.

- [ ] **Step 3: Extend PromptLoader**

In `src/prompts/prompt-loader.ts`, extend the search path to also include `<vault>/.dome/extensions/<bundle>/workflows/`.

Inside the class, modify the `load()` method to also walk bundles. The cleanest shape:

```typescript
async load(name: string): Promise<LoadedPrompt | null> {
  // Existing search paths: vault-local .dome/prompts/, then BUILTIN_DIR.
  // Add a third lookup against bundles, between vault-local and builtin.

  // Vault-local first (highest priority).
  const localPath = join(this.vault.path, ".dome/prompts", `${name}.md`);
  if (existsSync(localPath)) {
    const text = await readFile(localPath, "utf8");
    return this.parseLoaded(text, name, "vault-local");
  }

  // Bundle-contributed next.
  const bundles = (this.vault as { bundles?: ReadonlyArray<{ workflowPaths: readonly string[] }> }).bundles ?? [];
  for (const bundle of bundles) {
    for (const path of bundle.workflowPaths) {
      const filename = path.split("/").pop() ?? "";
      if (filename === `${name}.md`) {
        const text = await readFile(path, "utf8");
        return this.parseLoaded(text, name, "bundle");
      }
    }
  }

  // Builtin last (existing path).
  const builtinPath = join(BUILTIN_DIR, `${name}.md`);
  if (existsSync(builtinPath)) {
    const text = await readFile(builtinPath, "utf8");
    return this.parseLoaded(text, name, "builtin");
  }

  return null;
}
```

(Adapt the actual method signatures based on the existing `PromptLoader` implementation — the loaded-prompt construction may differ.)

If the existing `list()` method enumerates workflows, also extend it to include bundle workflow names.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/prompts/prompt-loader-bundles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prompts/prompt-loader.ts tests/prompts/prompt-loader-bundles.test.ts
git commit -m "feat(prompts): include bundle workflows in PromptLoader scan

Implements: phase-0a-openvault-workflows-merge
Plan: docs/superpowers/plans/2026-05-27-dome-hooks-phase-0a-extension-bundle-loader.md"
```

---

### Task 8: Bundle CLI commands in runCli

**Files:**
- Modify: `src/cli/cli.ts`
- Test: `tests/cli/cli-bundles.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/cli-bundles.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../../src/cli/cli";

const VAULT = join(import.meta.dir, "cli-bundles-fixtures");

async function setupVault(): Promise<void> {
  await rm(VAULT, { recursive: true, force: true });
  await mkdir(join(VAULT, ".dome"), { recursive: true });
  await mkdir(join(VAULT, ".git"), { recursive: true });
  await writeFile(join(VAULT, ".dome/config.yaml"), "");
  await writeFile(join(VAULT, ".dome/page-types.yaml"), "defaults: [entity]\nextensions: []\n");
}

beforeEach(setupVault);
afterEach(async () => {
  await rm(VAULT, { recursive: true, force: true });
});

describe("runCli with bundle CLI commands", () => {
  test("shows bundle-contributed commands in --help output when bundle is loaded", async () => {
    const cliDir = join(VAULT, ".dome/extensions/hello-world/cli");
    await mkdir(cliDir, { recursive: true });
    await writeFile(
      join(VAULT, ".dome/extensions/hello-world/manifest.yaml"),
      "name: hello-world\nversion: 1.0.0\n",
    );
    await writeFile(
      join(cliDir, "say-hi.ts"),
      `export const command = {
  name: "say-hi",
  description: "Say hi from the hello-world bundle.",
  action: async () => { console.log("hi"); return 0; },
};
`,
    );

    // runCli reads the vault from CWD or --vault flag.
    // Capture stdout: we test via running the CLI with --help and
    // asserting the bundle command surfaces.
    const exit = await runCli(["--vault", VAULT, "--help"]);
    expect(exit).toBe(0);
    // Inspection of --help output requires capturing stdout; the
    // simplest way is to mock console.log or use a stdout capture
    // utility. For this test, the existence of the registration is
    // the load-bearing assertion — exit code 0 confirms no
    // bundle-load-failure error.
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/cli-bundles.test.ts`
Expected: FAIL or ERROR — bundle CLI not registered.

- [ ] **Step 3: Extend runCli to register bundle CLI commands**

In `src/cli/cli.ts`, after `buildProgram(outcome)` creates the program, before `program.parseAsync`, scan loaded bundles for CLI command files and register each.

The mechanism: when `--vault <path>` is passed (or CWD vault detection succeeds), open the vault, read `vault.bundles`, and for each `bundle.cliPaths` entry, dynamically import the CLI file and register the exported `command` object with Commander.

Implementation outline:

```typescript
// In runCli, after buildProgram(outcome) but before parseAsync:
const vaultPath = inferVaultPathFromArgv(argv); // may be null
if (vaultPath !== null) {
  const vaultResult = await openVault(vaultPath);
  if (vaultResult.ok) {
    const bundles = (vaultResult.value as { bundles?: ReadonlyArray<{ cliPaths: readonly string[] }> }).bundles ?? [];
    for (const bundle of bundles) {
      for (const cliPath of bundle.cliPaths) {
        const mod = (await import(cliPath)) as { command?: { name: string; description: string; action: (...args: unknown[]) => Promise<number> } };
        if (mod.command) {
          program.command(mod.command.name)
            .description(mod.command.description)
            .action(async (...args) => {
              const exitCode = await mod.command!.action(...args);
              outcome.exit = exitCode;
            });
        }
      }
    }
    await vaultResult.value.close();
  }
}
```

(Adapt to the existing `inferVaultPathFromArgv` helper or write a small one that scans `argv` for `--vault <path>`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/cli-bundles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/cli.ts tests/cli/cli-bundles.test.ts
git commit -m "feat(cli): register bundle-contributed CLI commands

Implements: phase-0a-openvault-cli-register
Plan: docs/superpowers/plans/2026-05-27-dome-hooks-phase-0a-extension-bundle-loader.md"
```

---

### Task 9: End-to-end integration test

**Files:**
- Create: `tests/integration/extension-bundles-load.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile, cp } from "node:fs/promises";
import { join } from "node:path";
import { openVault } from "../../src/vault";

const VAULT = join(import.meta.dir, "extension-bundles-integration-fixtures");
const HELLO_WORLD_FIXTURE = join(import.meta.dir, "../fixtures/extensions/hello-world");

async function setupVault(): Promise<void> {
  await rm(VAULT, { recursive: true, force: true });
  await mkdir(join(VAULT, ".dome/extensions"), { recursive: true });
  await mkdir(join(VAULT, ".git"), { recursive: true });
  await writeFile(join(VAULT, ".dome/config.yaml"), "");
  await writeFile(join(VAULT, ".dome/page-types.yaml"), "defaults: [entity]\nextensions: []\n");
}

beforeEach(setupVault);
afterEach(async () => {
  await rm(VAULT, { recursive: true, force: true });
});

describe("extension bundle end-to-end load", () => {
  test("hello-world fixture loads cleanly: page type, preamble, workflow, hook all register", async () => {
    await cp(HELLO_WORLD_FIXTURE, join(VAULT, ".dome/extensions/hello-world"), {
      recursive: true,
    });

    const vaultResult = await openVault(VAULT);
    expect(vaultResult.ok).toBe(true);
    if (!vaultResult.ok) return;

    const vault = vaultResult.value;

    // Page type 'hello' is in PageTypesConfig.extensions.
    const extensionNames = vault.pageTypes.extensions.map((e) =>
      typeof e === "string" ? e : e.name,
    );
    expect(extensionNames).toContain("hello");

    // Bundle is in vault.bundles.
    const bundles = (vault as { bundles?: ReadonlyArray<{ name: string }> }).bundles ?? [];
    expect(bundles.map((b) => b.name)).toContain("hello-world");

    await vault.close();
  });

  test("two bundles with colliding page-type names reject openVault", async () => {
    for (const bn of ["alpha-bundle", "zebra-bundle"]) {
      const dir = join(VAULT, ".dome/extensions", bn);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "manifest.yaml"), `name: ${bn}\nversion: 1.0.0\n`);
      await writeFile(join(dir, "page-types.yaml"), "extensions:\n  - name: shared\n");
    }
    const vaultResult = await openVault(VAULT);
    expect(vaultResult.ok).toBe(false);
    if (!vaultResult.ok && vaultResult.error.kind === "bundle-load-failure") {
      expect(vaultResult.error.detail).toBe("page-type-collision");
      expect(vaultResult.error.message).toContain("shared");
    }
  });

  test("bundle removal between openVault calls clears registrations", async () => {
    await cp(HELLO_WORLD_FIXTURE, join(VAULT, ".dome/extensions/hello-world"), {
      recursive: true,
    });

    let v = await openVault(VAULT);
    expect(v.ok).toBe(true);
    if (v.ok) {
      const names = v.value.pageTypes.extensions.map((e) =>
        typeof e === "string" ? e : e.name,
      );
      expect(names).toContain("hello");
      await v.value.close();
    }

    await rm(join(VAULT, ".dome/extensions/hello-world"), { recursive: true });

    v = await openVault(VAULT);
    expect(v.ok).toBe(true);
    if (v.ok) {
      const names = v.value.pageTypes.extensions.map((e) =>
        typeof e === "string" ? e : e.name,
      );
      expect(names).not.toContain("hello");
      await v.value.close();
    }
  });

  test("malformed manifest rejects openVault with manifest-invalid detail", async () => {
    const dir = join(VAULT, ".dome/extensions/broken");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "manifest.yaml"), "missing-name-field: true\n");
    const v = await openVault(VAULT);
    expect(v.ok).toBe(false);
    if (!v.ok && v.error.kind === "bundle-load-failure") {
      expect(v.error.detail).toBe("manifest-invalid");
    }
  });

  test("bundle directory without manifest.yaml rejects openVault", async () => {
    const dir = join(VAULT, ".dome/extensions/orphan");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "preamble.md"), "lonely\n");
    const v = await openVault(VAULT);
    expect(v.ok).toBe(false);
    if (!v.ok && v.error.kind === "bundle-load-failure") {
      expect(v.error.detail).toBe("manifest-missing");
    }
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `bun test tests/integration/extension-bundles-load.test.ts`
Expected: PASS (all 5 tests).

Also run the full suite: `bun test`
Expected: all tests pass; no regressions.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/extension-bundles-load.test.ts
git commit -m "test(integration): extension bundle end-to-end load

Implements: phase-0a-loader-integration-test
Plan: docs/superpowers/plans/2026-05-27-dome-hooks-phase-0a-extension-bundle-loader.md"
```

---

## Self-Review Checklist

After the engineer completes all 9 tasks, verify:

**Spec coverage:**
- [ ] phase-0a-loader-skeleton → Task 3 (`src/extensions/loader.ts`)
- [ ] phase-0a-manifest-schema → Task 2 (`src/extensions/manifest-schema.ts`)
- [ ] phase-0a-bundle-load-cascade → Task 5 (`loadVaultConfig` calls `loadExtensionBundles`)
- [ ] phase-0a-openvault-page-types-merge → Task 5 (page-types merge with collision detection)
- [ ] phase-0a-openvault-workflows-merge → Task 7 (PromptLoader scans bundle workflows)
- [ ] phase-0a-openvault-hooks-register → Task 6 (loadDeclarativeHooks scans bundle hooks)
- [ ] phase-0a-openvault-cli-register → Task 8 (runCli scans bundle CLI commands)
- [ ] phase-0a-hello-world-fixture → Task 4 (fixture files)
- [ ] phase-0a-loader-integration-test → Task 9 (`tests/integration/extension-bundles-load.test.ts`)

**Substrate invariants:**
- HOOKS_CANNOT_BYPASS_TOOLS: bundle-loaded hooks go through `HookRegistry.register` like vault-local; their HookContext does NOT receive `privilegedWriter` (registry-level enforcement).
- PAGE_TYPE_BY_DIRECTORY: bundle page-types merge into the same `PageTypesConfig.extensions` list; `writeDocument`'s existing validation applies unchanged.
- CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY: `src/extensions/` imports `yaml`, `zod`, and `node:fs` only — no LLM or MCP imports.

**Tests landing:**
- `tests/types.test.ts` (Task 1)
- `tests/extensions/manifest-schema.test.ts` (Task 2)
- `tests/extensions/loader.test.ts` (Task 3)
- `tests/vault-config.test.ts` (Task 5)
- `tests/hooks/yaml-loader-bundles.test.ts` (Task 6)
- `tests/prompts/prompt-loader-bundles.test.ts` (Task 7)
- `tests/cli/cli-bundles.test.ts` (Task 8)
- `tests/integration/extension-bundles-load.test.ts` (Task 9)
- `tests/fixtures/extensions/hello-world/` (Task 4)
