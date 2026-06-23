// The first-party view catalog — one declaration per surfaced view, shared
// by the CLI verbs, the MCP tools, and the HTTP routes (the constants
// previously lived in three places). This lockstep test pins every catalog
// entry to the shipped bundle set: the command trigger must exist on a
// view-phase processor in the named bundle, so a bundle/processor rename
// cannot silently strand three surfaces.

import { describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadBundles } from "../../src/extensions/loader";
import { FIRST_PARTY_VIEWS } from "../../src/surface/view-catalog";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(THIS_FILE), "..", "..");
const SHIPPED_BUNDLES_ROOT = join(REPO_ROOT, "assets", "extensions");

describe("first-party view catalog lockstep", () => {
  test("every catalog entry maps to a shipped view-phase command trigger", async () => {
    const result = await loadBundles({ bundlesRoot: SHIPPED_BUNDLES_ROOT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const entry of Object.values(FIRST_PARTY_VIEWS)) {
      const bundle = result.value.find((b) => b.id === entry.bundleId);
      expect(bundle, `bundle ${entry.bundleId} for view '${entry.command}'`)
        .toBeDefined();
      const processor = bundle?.processors.find((p) =>
        p.phase === "view" &&
        p.triggers.some(
          (trigger) =>
            trigger.kind === "command" && trigger.name === entry.command,
        ),
      );
      expect(
        processor,
        `no shipped view-phase processor in ${entry.bundleId} handles command '${entry.command}'`,
      ).toBeDefined();
      expect(entry.viewName.startsWith(`${entry.bundleId}.`)).toBe(true);
      expect(entry.schemaTag).toBe(`${entry.viewName}/v1`);
    }
  });

  test("catalog commands are unique", () => {
    const commands = Object.values(FIRST_PARTY_VIEWS).map((e) => e.command);
    expect(new Set(commands).size).toBe(commands.length);
  });

  test("export-context contract requires markdown and passes the rest through", () => {
    const entry = FIRST_PARTY_VIEWS.exportContext;
    expect(() => entry.payload.parse({})).toThrow();
    const parsed = entry.payload.parse({ markdown: "# hi", topic: "t", extra: 1 }) as {
      markdown: string;
      topic: string;
      extra: number;
    };
    expect(parsed.markdown).toBe("# hi");
    expect(parsed.topic).toBe("t");
    expect(parsed.extra).toBe(1);
  });
});
