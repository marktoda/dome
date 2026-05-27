// Pins the bare-event expansion rule per docs/wiki/specs/hooks.md
// §"Bare events expand to suffix wildcards" and
// docs/wiki/matrices/event-types-and-payloads.md §"Expansion convention":
//
//   - `event: document.written` (no *) → registers under pattern `document.written.*`
//   - `event: document.written.wiki.*` → honored verbatim (already has *)
//   - `event: *` → honored verbatim (already has *)

import { describe, test, expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openVault } from "../../src/vault";
import { HookRegistry } from "../../src/hooks/hook-registry";
import { loadDeclarativeHooks } from "../../src/hooks/yaml-loader";
import { makeTestVault } from "../helpers/make-test-vault";

describe("yaml-loader bare-event expansion", () => {
  test("bare 'document.written' (no *) expands to 'document.written.*'", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const vault = res.value;

      await mkdir(join(v.path, ".dome", "hooks"), { recursive: true });
      await writeFile(
        join(v.path, ".dome", "hooks", "test-bare.yaml"),
        "event: document.written\nworkflow: ingest\n",
        "utf8",
      );

      const registry = new HookRegistry();
      await loadDeclarativeHooks(vault, registry, {
        runWorkflow: async () => undefined,
      });

      const registered = registry.list();
      const found = registered.find((h) => h.id === "declarative:test-bare");
      expect(found).toBeDefined();
      expect(found!.pattern).toBe("document.written.*");
    } finally {
      await v.cleanup();
    }
  });

  test("'document.written.wiki.*' (already has *) is honored verbatim", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const vault = res.value;

      await mkdir(join(v.path, ".dome", "hooks"), { recursive: true });
      await writeFile(
        join(v.path, ".dome", "hooks", "test-wildcard.yaml"),
        "event: document.written.wiki.*\nworkflow: ingest\n",
        "utf8",
      );

      const registry = new HookRegistry();
      await loadDeclarativeHooks(vault, registry, {
        runWorkflow: async () => undefined,
      });

      const found = registry.list().find((h) => h.id === "declarative:test-wildcard");
      expect(found).toBeDefined();
      expect(found!.pattern).toBe("document.written.wiki.*");
    } finally {
      await v.cleanup();
    }
  });

  test("'*' (everything) is honored verbatim", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const vault = res.value;

      await mkdir(join(v.path, ".dome", "hooks"), { recursive: true });
      await writeFile(
        join(v.path, ".dome", "hooks", "test-all.yaml"),
        // `*` is YAML's anchor-reference syntax; quoting forces the literal string.
        'event: "*"\nworkflow: ingest\n',
        "utf8",
      );

      const registry = new HookRegistry();
      await loadDeclarativeHooks(vault, registry, {
        runWorkflow: async () => undefined,
      });

      const found = registry.list().find((h) => h.id === "declarative:test-all");
      expect(found).toBeDefined();
      expect(found!.pattern).toBe("*");
    } finally {
      await v.cleanup();
    }
  });
});
