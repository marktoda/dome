import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureHomeSelection,
  classifyHomeSelection,
  homeSelectionPaths,
  publishHomeSelectionDocument,
  renderHomeSelection,
} from "../../src/product-host/home-selection";

describe("Home release selection", () => {
  test("renders a closed candidate pair and classifies only exact old/candidate bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-selection-"));
    try {
      const vault = join(root, "vault");
      const support = join(root, "support");
      const launchAgentsDir = join(root, "LaunchAgents");
      await mkdir(join(vault, ".dome", "state"), { recursive: true });
      await mkdir(launchAgentsDir, { recursive: true });
      const deps = { applicationSupportDir: support, launchAgentsDir };
      const paths = homeSelectionPaths(vault, deps);
      await mkdir(join(support, "installations", paths.installation.split("/").at(-2)!), { recursive: true });
      await writeFile(paths.installation, "old installation\n", { mode: 0o600 });
      await writeFile(paths.plist, "old plist\n", { mode: 0o600 });
      const old = await captureHomeSelection(vault, deps);
      const candidate = renderHomeSelection({
        vault,
        artifact: { id: "a".repeat(64), version: "2.0.0", releasePath: join(support, "releases", "a".repeat(64)) },
        environment: [{ name: "DOME_TEST", value: "yes" }],
      }, deps);
      expect(candidate.installation.bytes).toContain('"version": "2.0.0"');
      expect(candidate.plist.bytes).toContain(join(support, "releases", "a".repeat(64)));
      expect(await classifyHomeSelection({ old, candidate })).toBe("old");

      await publishHomeSelectionDocument(candidate.plist);
      expect(await classifyHomeSelection({ old, candidate })).toBe("mixed");
      await publishHomeSelectionDocument(candidate.installation);
      expect(await classifyHomeSelection({ old, candidate })).toBe("candidate");

      await chmod(paths.plist, 0o644);
      expect(await classifyHomeSelection({ old, candidate })).toBe("invalid");
      expect(await readFile(paths.installation, "utf8")).toBe(candidate.installation.bytes);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
