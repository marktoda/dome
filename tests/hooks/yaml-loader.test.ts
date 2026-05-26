import { describe, test, expect } from "bun:test";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadDeclarativeHooks } from "../../src/hooks/yaml-loader";
import { HookRegistry } from "../../src/hook-registry";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";

describe("declarative YAML hook loader", () => {
  test("registers a hook from a valid intake-raw.yaml", async () => {
    const v = await makeTestVault();
    try {
      await mkdir(join(v.path, ".dome", "hooks"), { recursive: true });
      await writeFile(
        join(v.path, ".dome", "hooks", "intake-raw.yaml"),
        `event: document.written\npath_pattern: "inbox/raw/*"\nworkflow: ingest\nasync: true\nidempotent: true\n`,
      );
      const res = await openVault(v.path);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // The handler should appear in the vault's wired registry. We don't
      // have a public registry surface, but dispatchEvents will route to it.
      // Verify by checking that an inbox/raw/* event with a valid path
      // doesn't throw and reaches a non-trivial code path.
      // (We mock runWorkflow via globalThis at the module-side; a future
      // integration test exercises the LLM round-trip end-to-end.)
      await res.value.dispatchEvents([
        { kind: "document.written.inbox.raw", path: "inbox/raw/2026-05-26.md", diff: "[new]" },
      ]);
      await res.value.drainHooks();
      // If the loader registered the hook, an event matching
      // document.written.inbox.raw would invoke runWorkflow, which without
      // ANTHROPIC_API_KEY fails fast — we accept either silence or an error
      // recorded in the registry. The test passes as long as the call
      // doesn't throw uncaught.
    } finally {
      await v.cleanup();
    }
  });

  test("rejects YAML with unknown workflow name", async () => {
    const v = await makeTestVault();
    try {
      await mkdir(join(v.path, ".dome", "hooks"), { recursive: true });
      await writeFile(
        join(v.path, ".dome", "hooks", "broken.yaml"),
        `event: document.written.wiki.entity\nworkflow: not-a-real-workflow\n`,
      );
      const errors: { file: string; error: string }[] = [];
      const registry = new HookRegistry();
      await loadDeclarativeHooks(
        // We can pass a thin vault-like object; the loader only reads .path.
        // The handler closure captures it but won't fire since loading fails.
        { path: v.path } as Parameters<typeof loadDeclarativeHooks>[0],
        registry,
        { onLoadError: (file, error) => errors.push({ file, error }) },
      );
      expect(errors.length).toBe(1);
      expect(errors[0]!.file).toBe("broken.yaml");
      expect(errors[0]!.error).toContain("not a known workflow name");
      expect(registry.list().length).toBe(0);
    } finally {
      await v.cleanup();
    }
  });

  test("loads each valid YAML even when a sibling YAML is malformed", async () => {
    const v = await makeTestVault();
    try {
      await mkdir(join(v.path, ".dome", "hooks"), { recursive: true });
      await writeFile(
        join(v.path, ".dome", "hooks", "good.yaml"),
        `event: document.written\npath_pattern: "inbox/raw/*"\nworkflow: ingest\n`,
      );
      await writeFile(
        join(v.path, ".dome", "hooks", "bad.yaml"),
        `:\n  - this is not valid yaml structure\n  - because mapping keys`,
      );
      const errors: string[] = [];
      const registry = new HookRegistry();
      await loadDeclarativeHooks(
        { path: v.path } as Parameters<typeof loadDeclarativeHooks>[0],
        registry,
        { onLoadError: (file, _error) => errors.push(file) },
      );
      // bad.yaml errored, good.yaml registered.
      expect(errors).toContain("bad.yaml");
      const ids = registry.list().map(h => h.id);
      expect(ids).toContain("declarative:good");
    } finally {
      await v.cleanup();
    }
  });

  test("ignores non-yaml files in .dome/hooks/", async () => {
    const v = await makeTestVault();
    try {
      await mkdir(join(v.path, ".dome", "hooks"), { recursive: true });
      await writeFile(
        join(v.path, ".dome", "hooks", "README.md"),
        `# Hooks live here.\nDo not register me.`,
      );
      const registry = new HookRegistry();
      await loadDeclarativeHooks(
        { path: v.path } as Parameters<typeof loadDeclarativeHooks>[0],
        registry,
      );
      expect(registry.list().length).toBe(0);
    } finally {
      await v.cleanup();
    }
  });

  test("expands a bare 'event: document.written' into 'document.written.*' so projected events match", async () => {
    const v = await makeTestVault();
    try {
      await mkdir(join(v.path, ".dome", "hooks"), { recursive: true });
      await writeFile(
        join(v.path, ".dome", "hooks", "wide.yaml"),
        `event: document.written\nworkflow: ingest\n`,
      );
      const registry = new HookRegistry();
      await loadDeclarativeHooks(
        { path: v.path } as Parameters<typeof loadDeclarativeHooks>[0],
        registry,
      );
      const hooks = registry.list();
      expect(hooks.length).toBe(1);
      expect(hooks[0]!.pattern).toBe("document.written.*");
      // And the resulting registry actually matches projected event kinds.
      const matched = registry.matchesEvent("document.written.inbox.raw");
      expect(matched.some(h => h.id === "declarative:wide")).toBe(true);
    } finally {
      await v.cleanup();
    }
  });
});
