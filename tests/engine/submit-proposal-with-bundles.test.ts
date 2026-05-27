// Phase 8 — end-to-end smoke for `openVaultRuntime({ bundlesRoot })`.
//
// Exercises the bundle-load → buildRegistry → runtime-compose path:
//
//   openVaultRuntime({ vaultPath, bundlesRoot: assets/extensions }) →
//     loadBundles → flattenBundleProcessors → buildRegistry →
//     openProjectionDb + openOutboxDb + openLedgerDb → buildRuntime
//
// The shipped bundle (`dome.lint`) ships only a view-phase processor; the
// adoption loop never fires it during a `submitProposal` call. The smoke
// asserts:
//
//   1. `openVaultRuntime` returns ok against the shipped bundles root.
//   2. The runtime's processor registry contains the shipped processor
//      under its bundle-prefixed id.
//   3. A minimal `submitProposal` call succeeds (the view-phase processor
//      isn't routed during adoption, so the submission completes with no
//      runs).
//   4. `runtime.close()` releases the three DB handles cleanly.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { submitProposal } from "../../src/engine/submit-proposal";
import {
  openVaultRuntime,
  type VaultRuntime,
} from "../../src/engine/vault-runtime";
import { commitOid } from "../../src/core/source-ref";
import { manualProposal } from "../../src/core/proposal";
import { commit, initRepo } from "../../src/git";
import {
  flattenBundleProcessors,
  loadBundles,
} from "../../src/extensions/loader";

// ----- Paths ---------------------------------------------------------------

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(THIS_FILE), "..", "..");
const SHIPPED_BUNDLES_ROOT = join(REPO_ROOT, "assets", "extensions");

// ----- Fixture -------------------------------------------------------------

type Fixture = {
  vaultPath: string;
  baseSha: string;
  headSha: string;
  cleanup: () => Promise<void>;
};

async function makeFixture(): Promise<Fixture> {
  const vaultPath = mkdtempSync(join(tmpdir(), "submit-with-bundles-"));
  await initRepo(vaultPath);
  await mkdir(join(vaultPath, "wiki"), { recursive: true });

  await writeFile(join(vaultPath, "wiki/seed.md"), "seed\n");
  const baseSha = await commit({
    path: vaultPath,
    message: "init\n",
    files: ["wiki/seed.md"],
  });

  await writeFile(join(vaultPath, "wiki/new.md"), "new page\n");
  const headSha = await commit({
    path: vaultPath,
    message: "add wiki/new.md\n",
    files: ["wiki/new.md"],
  });

  return {
    vaultPath,
    baseSha,
    headSha,
    cleanup: async () => {
      await rm(vaultPath, { recursive: true, force: true });
    },
  };
}

const fixtures: Fixture[] = [];
const runtimes: VaultRuntime[] = [];

afterEach(async () => {
  while (runtimes.length > 0) {
    const r = runtimes.pop();
    if (r !== undefined) await r.close();
  }
  while (fixtures.length > 0) {
    const f = fixtures.pop();
    if (f !== undefined) await f.cleanup();
  }
});

// ----- Tests ---------------------------------------------------------------

describe("openVaultRuntime({ bundlesRoot }) — Phase 8 end-to-end", () => {
  test("loads the shipped dome.lint bundle and composes a working runtime", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const runtimeResult = await openVaultRuntime({
      vaultPath: f.vaultPath,
      bundlesRoot: SHIPPED_BUNDLES_ROOT,
    });
    expect(runtimeResult.ok).toBe(true);
    if (!runtimeResult.ok) {
      throw new Error(
        `openVaultRuntime failed: ${runtimeResult.error.kind}`,
      );
    }
    const runtime = runtimeResult.value;
    runtimes.push(runtime);

    // Cross-check: the same `loadBundles` call the runtime ran internally
    // should expose the shipped processor by id. `ProcessorRuntime` itself
    // does not re-export the registry (Phase 4+ may add this), so we
    // verify load via the loader directly + assert the smoke submission
    // wires the runtime end-to-end.
    const inspectResult = await loadBundles({
      bundlesRoot: SHIPPED_BUNDLES_ROOT,
    });
    expect(inspectResult.ok).toBe(true);
    if (!inspectResult.ok) return;
    const procIds = flattenBundleProcessors(inspectResult.value).map(
      (p) => p.id,
    );
    expect(procIds).toContain("dome.lint.markdown-format");

    // A minimal submitProposal against a vault with only view-phase
    // processors — none fire on adoption — completes cleanly.
    const proposal = manualProposal({
      id: "prop_phase8_bundles_1",
      base: commitOid(f.baseSha),
      head: commitOid(f.headSha),
      branch: "main",
    });
    const result = await submitProposal({ runtime, proposal });
    expect(result.adopted).toBe(true);
    expect(result.proposalId).toBe("prop_phase8_bundles_1");
  });

  test("close() releases the DB handles without throwing", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const runtimeResult = await openVaultRuntime({
      vaultPath: f.vaultPath,
      bundlesRoot: SHIPPED_BUNDLES_ROOT,
    });
    expect(runtimeResult.ok).toBe(true);
    if (!runtimeResult.ok) return;
    const runtime = runtimeResult.value;

    await runtime.close();
    // Re-closing is also idempotent (SQLite sqlite3_close_v2 semantics).
    await runtime.close();
  });

  test("bundle-load-failed surfaces when bundlesRoot does not exist", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const runtimeResult = await openVaultRuntime({
      vaultPath: f.vaultPath,
      bundlesRoot: "/nonexistent/__dome_phase8_test__/extensions",
    });
    expect(runtimeResult.ok).toBe(false);
    if (runtimeResult.ok) return;
    expect(runtimeResult.error.kind).toBe("bundle-load-failed");
    if (runtimeResult.error.kind !== "bundle-load-failed") return;
    expect(runtimeResult.error.cause.kind).toBe("root-not-found");
  });
});
