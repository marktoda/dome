import { describe, test, expect } from "bun:test";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PromptLoader } from "../../src/prompts/prompt-loader";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";
import { WORKFLOW_NAMES } from "../../src/workflows/workflow-name";

// Substrate: docs/wiki/specs/prompts-and-workflows.md §"Vault augmentation slots".
//
// Each shipped workflow prompt declares three include points that vaults may
// fill to add behavior without overriding the prompt wholesale:
//
//   - `vault-prologue.md`           — vault-wide augmentation (included via
//                                     system-base.md, so every workflow gets it)
//   - `<workflow-name>-augment.md`  — workflow-specific augmentation, included
//                                     after the workflow body
//   - `<workflow-name>-epilogue.md` — final-position addendum (gotchas, style
//                                     reminders, vault-specific footers)
//
// All three silently resolve to empty when the named partial doesn't exist
// in the vault — opt-in by file creation, not by config.
describe("vault augmentation slots", () => {
  test("system-base.md declares the vault-prologue extension point", async () => {
    const path = join(import.meta.dir, "..", "..", "src", "prompts", "builtin", "system-base.md");
    const body = await readFile(path, "utf8");
    expect(body).toContain("{{include: vault-prologue.md}}");
  });

  test("every shipped workflow prompt declares its <name>-augment extension point", async () => {
    for (const name of WORKFLOW_NAMES) {
      const path = join(import.meta.dir, "..", "..", "src", "prompts", "builtin", `${name}.md`);
      const body = await readFile(path, "utf8");
      expect(body).toContain(`{{include: ${name}-augment.md}}`);
    }
  });

  test("every shipped workflow prompt declares its <name>-epilogue extension point", async () => {
    for (const name of WORKFLOW_NAMES) {
      const path = join(import.meta.dir, "..", "..", "src", "prompts", "builtin", `${name}.md`);
      const body = await readFile(path, "utf8");
      expect(body).toContain(`{{include: ${name}-epilogue.md}}`);
    }
  });

  test("system-base.md declares the vault-identity preamble — universal across surfaces", async () => {
    const path = join(import.meta.dir, "..", "..", "src", "prompts", "builtin", "system-base.md");
    const body = await readFile(path, "utf8");
    expect(body).toContain("{{include: preamble-vault-identity.md}}");
    // rendering-surface is workflow-only — NOT in system-base, because system-base
    // is also consumed by interactive surfaces (MCP `instructions`, `dome.system_prompt`)
    // where "non-interactive single-turn" framing would mislead the client.
    expect(body).not.toContain("{{include: preamble-rendering-surface.md}}");
  });

  test("every shipped workflow prompt includes the rendering-surface preamble — workflow runs only", async () => {
    for (const name of WORKFLOW_NAMES) {
      const path = join(import.meta.dir, "..", "..", "src", "prompts", "builtin", `${name}.md`);
      const body = await readFile(path, "utf8");
      expect(body).toContain("{{include: preamble-rendering-surface.md}}");
    }
  });

  test("vault-prologue partial appears in resolved workflow prompts when present", async () => {
    const v = await makeTestVault();
    try {
      await mkdir(join(v.path, ".dome", "prompts"), { recursive: true });
      await writeFile(
        join(v.path, ".dome", "prompts", "vault-prologue.md"),
        "VAULT-PROLOGUE-CONTENT — task vocabulary lives here.\n"
      );
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const loader = new PromptLoader(res.value);
      const p = await loader.load("ingest");
      expect(p).not.toBeNull();
      expect(p!.body).toContain("VAULT-PROLOGUE-CONTENT");
    } finally {
      await v.cleanup();
    }
  });

  test("workflow-specific augment partial appears in resolved prompt when present", async () => {
    const v = await makeTestVault();
    try {
      await mkdir(join(v.path, ".dome", "prompts"), { recursive: true });
      await writeFile(
        join(v.path, ".dome", "prompts", "query-augment.md"),
        "QUERY-AUGMENT-CONTENT — time-aware retrieval here.\n"
      );
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const loader = new PromptLoader(res.value);
      const p = await loader.load("query");
      expect(p).not.toBeNull();
      expect(p!.body).toContain("QUERY-AUGMENT-CONTENT");
    } finally {
      await v.cleanup();
    }
  });

  test("missing augment partial silently resolves to empty — no error, no leftover include marker", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const loader = new PromptLoader(res.value);
      const p = await loader.load("ingest");
      expect(p).not.toBeNull();
      // Slot directive should be resolved away, not left as raw text.
      expect(p!.body).not.toContain("{{include: ingest-augment.md}}");
      expect(p!.body).not.toContain("{{include: vault-prologue.md}}");
    } finally {
      await v.cleanup();
    }
  });

  test("vault-only augment doesn't leak across workflows — query-augment doesn't appear in ingest", async () => {
    const v = await makeTestVault();
    try {
      await mkdir(join(v.path, ".dome", "prompts"), { recursive: true });
      await writeFile(
        join(v.path, ".dome", "prompts", "query-augment.md"),
        "QUERY-ONLY-MARKER\n"
      );
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const loader = new PromptLoader(res.value);
      const ingest = await loader.load("ingest");
      expect(ingest).not.toBeNull();
      expect(ingest!.body).not.toContain("QUERY-ONLY-MARKER");
    } finally {
      await v.cleanup();
    }
  });

  test("epilogue partial appears at the bottom of resolved workflow prompts when present", async () => {
    const v = await makeTestVault();
    try {
      await mkdir(join(v.path, ".dome", "prompts"), { recursive: true });
      await writeFile(
        join(v.path, ".dome", "prompts", "lint-epilogue.md"),
        "LINT-EPILOGUE-MARKER — final reminders here.\n"
      );
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const loader = new PromptLoader(res.value);
      const p = await loader.load("lint");
      expect(p).not.toBeNull();
      expect(p!.body).toContain("LINT-EPILOGUE-MARKER");
    } finally {
      await v.cleanup();
    }
  });

  // Substrate: docs/wiki/invariants/WORKFLOWS_KNOW_VAULT_CONTEXT.md.
  // {{vault.path}} is the closed set of template variables PromptLoader
  // recognizes. The substrate explicitly scopes this to one variable (and
  // any future additions are deliberate substrate changes, not ad-hoc).
  describe("{{vault.path}} template substitution", () => {
    test("substitutes {{vault.path}} in shipped partials with the actual vault path", async () => {
      const v = await makeTestVault();
      try {
        const res = await openVault(v.path);
        if (!res.ok) throw new Error("vault open failed");
        const loader = new PromptLoader(res.value);
        // preamble-vault-identity.md uses {{vault.path}} — resolved body must
        // carry the actual path, with no leftover template syntax.
        const id = await loader.load("preamble-vault-identity");
        expect(id).not.toBeNull();
        expect(id!.body).toContain(v.path);
        expect(id!.body).not.toContain("{{vault.path}}");
      } finally {
        await v.cleanup();
      }
    });

    test("substitutes {{vault.path}} in a vault-local partial too", async () => {
      const v = await makeTestVault();
      try {
        await mkdir(join(v.path, ".dome", "prompts"), { recursive: true });
        await writeFile(
          join(v.path, ".dome", "prompts", "ingest-augment.md"),
          "Operating against `{{vault.path}}`.\n"
        );
        const res = await openVault(v.path);
        if (!res.ok) throw new Error("vault open failed");
        const loader = new PromptLoader(res.value);
        const p = await loader.load("ingest");
        expect(p).not.toBeNull();
        expect(p!.body).toContain(`Operating against \`${v.path}\``);
        expect(p!.body).not.toContain("{{vault.path}}");
      } finally {
        await v.cleanup();
      }
    });

    test("does NOT substitute unknown template variables — only the closed set is recognized", async () => {
      const v = await makeTestVault();
      try {
        await mkdir(join(v.path, ".dome", "prompts"), { recursive: true });
        await writeFile(
          join(v.path, ".dome", "prompts", "ingest-augment.md"),
          "Today is {{vault.today}}. Path: {{vault.path}}.\n"
        );
        const res = await openVault(v.path);
        if (!res.ok) throw new Error("vault open failed");
        const loader = new PromptLoader(res.value);
        const p = await loader.load("ingest");
        expect(p).not.toBeNull();
        // {{vault.today}} is NOT a recognized variable — left as-is so a
        // future `dome doctor` check (or a reviewer) can flag the typo.
        expect(p!.body).toContain("{{vault.today}}");
        // {{vault.path}} IS recognized — substituted.
        expect(p!.body).toContain(`Path: ${v.path}`);
      } finally {
        await v.cleanup();
      }
    });
  });

  // Substrate: docs/wiki/specs/prompts-and-workflows.md §"Slot ordering in the
  // resolved prompt". The composition order is load-bearing — accidentally
  // swapping (e.g.) the augment and epilogue would silently change LLM
  // behavior since "final-position reminders" stop being final-position.
  test("resolved workflow body composes slots in the documented order", async () => {
    const v = await makeTestVault();
    try {
      await mkdir(join(v.path, ".dome", "prompts"), { recursive: true });
      await writeFile(
        join(v.path, ".dome", "prompts", "vault-prologue.md"),
        "VAULT-PROLOGUE-SENTINEL\n"
      );
      await writeFile(
        join(v.path, ".dome", "prompts", "query-augment.md"),
        "QUERY-AUGMENT-SENTINEL\n"
      );
      await writeFile(
        join(v.path, ".dome", "prompts", "query-epilogue.md"),
        "QUERY-EPILOGUE-SENTINEL\n"
      );
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const loader = new PromptLoader(res.value);
      const p = await loader.load("query");
      expect(p).not.toBeNull();
      const body = p!.body;

      const idVaultIdentity = body.indexOf("# Current vault");
      const idSystemBase = body.indexOf("# Dome — Wiki Maintainer");
      const idPrologue = body.indexOf("VAULT-PROLOGUE-SENTINEL");
      const idRendering = body.indexOf("# Rendering surface");
      const idWorkflowBody = body.indexOf("# Query");
      const idAugment = body.indexOf("QUERY-AUGMENT-SENTINEL");
      const idEpilogue = body.indexOf("QUERY-EPILOGUE-SENTINEL");

      // Every section is present.
      for (const [name, idx] of Object.entries({
        idVaultIdentity, idSystemBase, idPrologue, idRendering,
        idWorkflowBody, idAugment, idEpilogue,
      })) {
        expect(idx).toBeGreaterThanOrEqual(0);
      }

      // Documented order (top to bottom of the resolved body):
      //   preamble-vault-identity  (from system-base.md top)
      //   system-base body         (the wiki-maintainer ethos)
      //   vault-prologue           (from system-base.md bottom)
      //   preamble-rendering-surface (from the workflow file, after system-base include)
      //   workflow body            (task-specific behavior)
      //   <name>-augment           (after workflow body)
      //   <name>-epilogue          (final-position)
      expect(idVaultIdentity).toBeLessThan(idSystemBase);
      expect(idSystemBase).toBeLessThan(idPrologue);
      expect(idPrologue).toBeLessThan(idRendering);
      expect(idRendering).toBeLessThan(idWorkflowBody);
      expect(idWorkflowBody).toBeLessThan(idAugment);
      expect(idAugment).toBeLessThan(idEpilogue);
    } finally {
      await v.cleanup();
    }
  });

  // The override mechanism applies to SDK-shipped partials too (preambles,
  // system-base, vault-prologue). A vault that wants different framing can
  // drop a same-named file under .dome/prompts/ and the loader's
  // vault-local-first resolution picks it up.
  test("vault-local override of an SDK-shipped preamble wins", async () => {
    const v = await makeTestVault();
    try {
      await mkdir(join(v.path, ".dome", "prompts"), { recursive: true });
      await writeFile(
        join(v.path, ".dome", "prompts", "preamble-vault-identity.md"),
        "# Custom identity\n\nThis vault is the family-history project.\n"
      );
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const loader = new PromptLoader(res.value);
      const base = await loader.load("system-base");
      expect(base).not.toBeNull();
      // The vault's override is inlined.
      expect(base!.body).toContain("family-history project");
      // The SDK default's signature phrase doesn't appear.
      expect(base!.body).not.toContain("You are operating on the Dome vault at");
    } finally {
      await v.cleanup();
    }
  });
});
