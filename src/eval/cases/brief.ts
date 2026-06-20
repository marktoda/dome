// The `dome.agent.brief` golden case — run through the REAL engine.
//
// This is the crux eval: it materializes a throwaway temp vault from the
// `brief-basic` fixture, opens the real runtime with a hermetic (scripted)
// model-step provider, and drives the brief THROUGH the real compiler-host
// tick + scheduler with a PINNED clock. The brief's PatchEffect is therefore
// broker-checked, applied as a garden sub-Proposal, and adopted — exactly the
// production path — and the case reads the result back via the public
// `vault.readDocument` from the adopted commit (never HEAD, never an
// in-memory `brief.run(ctx)` unit call).
//
// Trigger mechanism (see sdd/task-5-report.md for the full rationale):
//   - The brief declares a `{ kind: "schedule", cron: "30 5 * * *" }` trigger.
//     `runCompilerHostTick({ runtime, drift, now })` fires due garden-schedule
//     processors through `runScheduler`, which dispatches the brief with
//     `firedAt = now()`. Pinning `now` to 2026-06-09 05:30 (local) makes the
//     daily path (`wiki/dailies/2026-06-09.md`) deterministic. This is the
//     same idiom the harness's `tick()` uses, so it stays on the documented
//     real-engine path (broker + apply + adopt), not a downgraded unit call.
//   - `dome.agent` ships several model-using scheduled processors that the
//     brand-new-cursor collapse would also fire on the first tick. To keep
//     the run hermetic and brief-scoped, the case wraps `env.modelStepProvider`
//     in a brief-gate: only the brief (detected by its charter system message)
//     receives the script; every other agent processor gets a terminal text
//     response (no tool calls → a clean no-op, no patch). The recorded
//     trajectory therefore reflects only the brief's steps.

import { cp, mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commit as gitCommit, initRepo } from "../../git";
import { resolveShippedBundlesRoot } from "../../extensions/bundle-roots";
import {
  detectDrift,
  runCompilerHostTick,
} from "../../engine/host/compiler-host";
import { openVaultRuntime } from "../../engine/host/vault-runtime";
import type { ModelStepProvider } from "../../engine/core/model-invoke";
import { openVault } from "../../vault";

import type { EvalCase } from "../types";
import { briefShapeValid, trajectoryReadsBeforeWrites } from "../assertions";
import type { BriefOutput } from "../assertions";

import {
  BRIEF_FIXTURE_VAULT_DIR,
  FIRED_AT,
  TODAY_DAILY_PATH,
} from "./brief-fixtures";

// The fixture vault's seed-file root (resolved in brief-fixtures.ts).
const FIXTURE_VAULT_DIR = BRIEF_FIXTURE_VAULT_DIR;

// The brief's charter system message starts with this sentence (see
// assets/extensions/dome.agent/lib/brief-charter.ts). The gate keys off it so
// only the brief receives the scripted steps.
const BRIEF_CHARTER_MARKER = "You are Dome's morning-brief composer.";

// The brief's read and write tool names (assets/extensions/dome.agent/lib/
// brief-tools.ts → makeBriefTools): reads vs. the daily-note writers.
const BRIEF_READ_TOOLS = ["readPage", "listPages", "searchVault", "askOwner"];
const BRIEF_WRITE_TOOLS = ["writePage", "appendToPage", "addTask"];

export const briefCase: EvalCase<BriefOutput> = {
  name: "dome.agent.brief",
  run: async (env): Promise<BriefOutput> => {
    const vaultPath = await materializeFixtureVault();

    // Brief-gate the env provider: only the brief gets the script; every other
    // agent processor that the scheduler fires gets a terminal no-op so the
    // hermetic run stays deterministic and brief-scoped.
    const gatedProvider = briefGatedProvider(env.modelStepProvider);

    const runtimeResult = await openVaultRuntime({
      vaultPath,
      bundlesRoot: join(vaultPath, ".dome", "extensions"),
      modelStepProvider: gatedProvider,
    });
    if (!runtimeResult.ok) {
      throw new Error(
        `briefCase: openVaultRuntime failed: ${JSON.stringify(runtimeResult.error)}`,
      );
    }
    const runtime = runtimeResult.value;

    try {
      const drift = await detectDrift(vaultPath);
      if (drift.kind !== "drift" && drift.kind !== "in-sync") {
        throw new Error(`briefCase: unworkable drift state '${drift.kind}'`);
      }
      // Pin the engine clock so the scheduler fires the brief with a fixed
      // `firedAt` → a deterministic daily path. This is the real tick path:
      // adoption → garden → scheduler → garden sub-Proposal → adopt.
      const tick = await runCompilerHostTick({
        runtime,
        drift,
        now: () => new Date(FIRED_AT),
      });
      if (tick.kind === "busy") {
        throw new Error(`briefCase: compiler host busy for '${tick.branch}'`);
      }
    } finally {
      await runtime.close();
    }

    // Read the adopted daily back via the public read surface. A fresh
    // `openVault` handle (the runtime above is closed) avoids two open SQLite
    // handles racing the same DB files.
    const vaultResult = await openVault({ path: vaultPath });
    if (!vaultResult.ok) {
      throw new Error(
        `briefCase: openVault failed: ${JSON.stringify(vaultResult.error)}`,
      );
    }
    const vault = vaultResult.value;
    try {
      const doc = await vault.readDocument(TODAY_DAILY_PATH);
      return {
        brief: doc?.content ?? "",
        trajectory: env.trajectory,
      };
    } finally {
      await vault.close();
    }
  },
  assertions: [
    briefShapeValid(),
    trajectoryReadsBeforeWrites({
      readNames: BRIEF_READ_TOOLS,
      writeNames: BRIEF_WRITE_TOOLS,
    }),
  ],
};

// ----- internals ------------------------------------------------------------

/**
 * Copy the fixture vault tree into a fresh temp dir, init a git repo, and land
 * the seed files as one commit — the same init+seed+commit shape the
 * `scripts/v1-llm-smoke.ts` smoke uses, scaled down. Returns the temp vault
 * path. The dir is a throwaway; the OS reclaims `tmpdir()`.
 */
async function materializeFixtureVault(): Promise<string> {
  const vaultPath = await mkdtemp(join(tmpdir(), "dome-eval-brief-"));

  // Copy the seed vault content (config + seed pages) into the temp vault.
  await cp(FIXTURE_VAULT_DIR, vaultPath, { recursive: true });

  await initRepo(vaultPath, "main");

  // Symlink the shipped dome.agent bundle into the vault's extensions root —
  // the same mechanism the harness uses (symlink, not copy, so the bundle's
  // relative imports resolve against the SDK source tree). Only dome.agent is
  // installed: the brief's dome.daily imports are ordinary TS module imports,
  // not a registered-bundle dependency.
  const extensionsRoot = join(vaultPath, ".dome", "extensions");
  await mkdir(extensionsRoot, { recursive: true });
  await symlink(
    join(resolveShippedBundlesRoot(), "dome.agent"),
    join(extensionsRoot, "dome.agent"),
    "dir",
  );

  // One commit lands the seed files — drift detection + the adopted-ref
  // readback both require a HEAD.
  await gitCommit({
    path: vaultPath,
    message: "eval: seed brief-basic fixture vault",
    author: { name: "dome-eval", email: "eval@local" },
    files: [".dome/config.yaml", "core.md", "wiki/dailies/2026-06-08.md"],
  });

  return vaultPath;
}

/**
 * Gate the scripted provider to the brief only. The brief's system message
 * (messages[0]) starts with the brief charter marker; any other agent
 * processor the scheduler fires gets a terminal `{ text: "done" }` (no tool
 * calls → a clean no-op, no patch), keeping the hermetic run deterministic.
 */
function briefGatedProvider(
  scripted: ModelStepProvider,
): ModelStepProvider {
  return async (request) => {
    const system = request.messages.find((m) => m.role === "system");
    const isBrief =
      typeof system?.content === "string" &&
      system.content.startsWith(BRIEF_CHARTER_MARKER);
    if (!isBrief) {
      return { text: "done" };
    }
    return scripted(request);
  };
}
