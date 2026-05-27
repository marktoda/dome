// Phase 7a — end-to-end smoke for the user-facing `submitProposal` entry
// point.
//
// Exercises the full v1 engine stack against real `bun:sqlite` DBs + a real
// isomorphic-git repo in a tmpdir:
//
//   openVaultRuntime → submitProposal → adopt → real ProcessorRuntime →
//   real ApplyEffectSinks → real LedgerDb writes → real ProjectionDb writes.
//
// The fixture builds a two-commit git repo (a base commit + a head commit
// that adds `wiki/new.md`), so `compileRange(base, head)` synthesizes a
// `file.created` SignalEvent that fires a test processor declared with a
// matching signal trigger. The processor emits one info-severity
// DiagnosticEffect; the loop converges on iteration 1 (no auto-mode
// PatchEffect emitted), the adopted ref advances, and the assertion surface
// validates:
//
//   1. The returned `AdoptionResult.adopted` is `true` (the success token
//      per [[wiki/specs/proposals]] §"Submission API").
//   2. `queryRuns(ledger, {processorId})` returns one row with
//      `status: "succeeded"` — pinned by
//      [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]].
//   3. `queryDiagnostics(projection, {processorId})` returns one row —
//      the routed DiagnosticEffect landed in the projection store via
//      `buildSqliteSinks`'s `recordDiagnostic`.
//   4. `runtime.close()` releases all three DBs without throwing.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { submitProposal } from "../../src/engine/submit-proposal";
import {
  openVaultRuntime,
  type VaultRuntime,
} from "../../src/engine/vault-runtime";
import { buildRegistry } from "../../src/processors/registry";
import {
  defineProcessor,
  type Capability,
  type ProcessorContext,
  type Trigger,
} from "../../src/core/processor";
import { commitOid } from "../../src/core/source-ref";
import { diagnosticEffect, type Effect } from "../../src/core/effect";
import { manualProposal } from "../../src/core/proposal";
import { commit, initRepo } from "../../src/git";
import { queryRuns } from "../../src/ledger/runs";
import { queryDiagnostics } from "../../src/projections/diagnostics";

// ----- Fixture --------------------------------------------------------------

type Fixture = {
  vaultPath: string;
  baseSha: string;
  headSha: string;
  cleanup: () => Promise<void>;
};

/**
 * Build a minimal real git repo with two commits:
 *
 *   1. `wiki/seed.md` (the base commit — the prior adopted state).
 *   2. `wiki/new.md` (the head commit — the proposed change; triggers a
 *      `file.created` signal for `wiki/new.md`).
 *
 * The vault path is a fresh tmpdir; the cleanup removes it after the test.
 */
async function makeFixture(): Promise<Fixture> {
  const vaultPath = mkdtempSync(join(tmpdir(), "submit-proposal-"));
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

// ----- Test processor -------------------------------------------------------

const PROCESSOR_ID = "test.submit-proposal.diag-on-create";

/**
 * The test processor: declared adoption-phase, subscribed to the
 * `file.created` signal under `wiki/**`, emits one info-severity
 * DiagnosticEffect when fired. No capabilities required — diagnostics
 * are not capability-enforced in v1 (per
 * `src/engine/apply-effect.ts`'s `maybeCapabilityUse`).
 */
function makeTestProcessor() {
  const trigger: Trigger = {
    kind: "signal",
    name: "file.created",
    pathPattern: "wiki/**",
  };
  const capabilities: ReadonlyArray<Capability> = [];
  return defineProcessor({
    id: PROCESSOR_ID,
    version: "0.0.1",
    phase: "adoption",
    triggers: [trigger],
    capabilities,
    run: async (
      _ctx: ProcessorContext<unknown>,
    ): Promise<ReadonlyArray<Effect>> => {
      return [
        diagnosticEffect({
          severity: "info",
          code: "test.fired",
          message: "submitProposal smoke test — processor fired on file.created",
          sourceRefs: [],
        }),
      ];
    },
  });
}

// ----- The smoke test -------------------------------------------------------

describe("submitProposal — Phase 7a end-to-end smoke", () => {
  test("adopts a Proposal end-to-end: ledger + projection writes land; close releases DBs", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    // 1. Build the registry from the single test processor.
    const processor = makeTestProcessor();
    const registryResult = buildRegistry([processor]);
    if (!registryResult.ok) {
      throw new Error(`registry build failed: ${registryResult.error.kind}`);
    }

    // 2. Open the VaultRuntime against the fixture vault path.
    const runtimeResult = await openVaultRuntime({
      vaultPath: f.vaultPath,
      registry: registryResult.value,
      extensions: [{ name: "test-bundle", version: "0.0.1" }],
      processorVersions: [{ id: processor.id, version: processor.version }],
    });
    if (!runtimeResult.ok) {
      throw new Error(`openVaultRuntime failed: ${runtimeResult.error.kind}`);
    }
    const runtime = runtimeResult.value;
    runtimes.push(runtime);

    // 3. Construct the Proposal: base = first commit, head = second commit.
    //    The base..head range adds `wiki/new.md`, so `compileRange` emits
    //    a `file.created` SignalEvent that fires the test processor.
    const proposal = manualProposal({
      id: "prop_submit_smoke_1",
      base: commitOid(f.baseSha),
      head: commitOid(f.headSha),
      branch: "main",
    });

    // 4. Submit.
    const result = await submitProposal({ runtime, proposal });

    // 5a. The adoption converged and advanced the adopted ref.
    expect(result.adopted).toBe(true);
    expect(result.proposalId).toBe("prop_submit_smoke_1");
    expect(result.iterations).toBeGreaterThanOrEqual(1);
    // No block-severity diagnostics expected; the processor emits an
    // info diagnostic, which is non-blocking.
    expect(
      result.diagnostics.every((d) => d.severity !== "block"),
    ).toBe(true);

    // 5b. The run ledger captured one succeeded run for the test processor.
    const runs = queryRuns(runtime.ledgerDb, { processorId: PROCESSOR_ID });
    expect(runs.length).toBe(1);
    const run = runs[0];
    if (run === undefined) throw new Error("expected a run row");
    expect(run.status).toBe("succeeded");
    expect(run.proposalId).toBe("prop_submit_smoke_1");
    expect(run.processorId).toBe(PROCESSOR_ID);
    expect(run.phase).toBe("adoption");

    // 5c. The projection store captured the routed DiagnosticEffect.
    const diagnostics = queryDiagnostics(runtime.projectionDb, {
      processorId: PROCESSOR_ID,
    });
    expect(diagnostics.length).toBe(1);
    const diag = diagnostics[0];
    if (diag === undefined) throw new Error("expected a diagnostic row");
    expect(diag.severity).toBe("info");
    expect(diag.code).toBe("test.fired");

    // 6. Closing the runtime releases all three DB handles cleanly. The
    //    afterEach hook will also call this; calling it here exercises the
    //    idempotent-close contract (Bun's sqlite3_close_v2) before the
    //    cleanup runs.
    await runtime.close();
  });

  test("idempotent re-submission with the same proposal id is a no-op", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const processor = makeTestProcessor();
    const registryResult = buildRegistry([processor]);
    if (!registryResult.ok) {
      throw new Error(`registry build failed: ${registryResult.error.kind}`);
    }

    const runtimeResult = await openVaultRuntime({
      vaultPath: f.vaultPath,
      registry: registryResult.value,
      extensions: [{ name: "test-bundle", version: "0.0.1" }],
      processorVersions: [{ id: processor.id, version: processor.version }],
    });
    if (!runtimeResult.ok) {
      throw new Error(`openVaultRuntime failed: ${runtimeResult.error.kind}`);
    }
    const runtime = runtimeResult.value;
    runtimes.push(runtime);

    const proposal = manualProposal({
      id: "prop_submit_smoke_idem",
      base: commitOid(f.baseSha),
      head: commitOid(f.headSha),
      branch: "main",
    });

    // First submission: adopted ref advances; one run row + one diagnostic
    // row land.
    const first = await submitProposal({ runtime, proposal });
    expect(first.adopted).toBe(true);

    // Second submission with the same proposal: `adopt()` reads
    // `proposal.base` (still `baseSha`) and `proposal.head` (still
    // `headSha`) so `compileRange(base, head)` produces the same diff
    // and the same `file.created` signal, the processor fires again,
    // and the engine re-emits the same diagnostic. The adopted ref
    // advance is a no-op (`setAdoptedRef` short-circuits on
    // `current === sha`), and the diagnostics table's
    // UNIQUE (processor_id, code, proposal_id) constraint + the
    // `INSERT OR IGNORE` semantics in `insertDiagnostic` dedup the
    // re-emission. Net result: one diagnostic row, regardless of
    // submission count for this proposal id.
    const second = await submitProposal({ runtime, proposal });
    expect(second.adopted).toBe(true);

    const diagnostics = queryDiagnostics(runtime.projectionDb, {
      processorId: PROCESSOR_ID,
    });
    expect(diagnostics.length).toBe(1);
  });
});
