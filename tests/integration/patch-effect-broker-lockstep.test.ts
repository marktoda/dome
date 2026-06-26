// patch-effect-broker-lockstep: mechanical enforcer behind review §3.4.
//
// Invariant: PATCH_EFFECT_BROKER_CHECKED_ON_EVERY_PATH
//
// PatchEffect is the only effect that mutates the canonical markdown substrate,
// so it must always flow through the capability broker. Garden-phase patches
// used to enforce the broker in a parallel module (garden-patch-router.ts);
// that route was collapsed into the sole applier so there is now exactly ONE
// broker call site for every patch phase:
//
//   src/engine/core/apply-effect.ts — enforceCapability for adoption AND garden
//
// A garden patch is now phase-compatible with `applyEffect`, which enforces the
// broker (step 2) before resolving the patch to `queued-for-spawn`. The garden
// orchestrator only spawns a sub-Proposal AFTER applyEffect authorized it. The
// remaining risk is a spawn caller bypassing applyEffect and spawning an
// un-brokered patch, so this test pins two things: (1) apply-effect.ts still
// calls enforceCapability, and (2) every module that calls
// spawnGardenSubProposal also routes through applyEffect — no spawn without the
// sole applier first.
//
// Assertion shape: source-level. This is the house pattern for cross-file
// contracts (mirrors engine-import-direction.test.ts); it does not ossify
// internal details beyond the chokepoint symbols the paths must invoke.

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(dirname(THIS_FILE)));

const APPLY_EFFECT_PATH = join(
  REPO_ROOT,
  "src",
  "engine",
  "core",
  "apply-effect.ts",
);

// The modules that spawn garden sub-Proposals from an authorized PatchEffect.
// Each must route the patch through applyEffect (the sole broker entry) before
// reaching spawnGardenSubProposal.
const SPAWN_CALLER_PATHS = [
  join(REPO_ROOT, "src", "engine", "garden", "garden.ts"),
  join(REPO_ROOT, "src", "engine", "garden", "garden-patch-dispatch.ts"),
];

const BROKER_CALL_PATTERN = "enforceCapability(";
const APPLIER_CALL_PATTERN = "applyEffect(";
const SPAWN_CALL_PATTERN = "spawnGardenSubProposal(";

/** Strip `// ...` single-line comments so commented-out calls don't satisfy the check. */
function stripLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const commentIndex = line.indexOf("//");
      return commentIndex === -1 ? line : line.slice(0, commentIndex);
    })
    .join("\n");
}

describe("PATCH_EFFECT_BROKER_CHECKED_ON_EVERY_PATH (review §3.4)", () => {
  test("apply-effect.ts is the sole broker entry for every patch phase", async () => {
    const source = stripLineComments(await readFile(APPLY_EFFECT_PATH, "utf8"));
    expect(
      source.includes(BROKER_CALL_PATTERN),
      `apply-effect.ts must contain an active (non-commented) call to enforceCapability(...) — it is the single broker entry for both adoption- and garden-phase PatchEffects. If you removed or renamed this call, no patch path enforces capabilities (invariant PATCH_EFFECT_BROKER_CHECKED_ON_EVERY_PATH).`,
    ).toBe(true);
  });

  test("every garden sub-Proposal spawn routes through the sole applier", async () => {
    for (const path of SPAWN_CALLER_PATHS) {
      const source = stripLineComments(await readFile(path, "utf8"));
      if (!source.includes(SPAWN_CALL_PATTERN)) continue;
      expect(
        source.includes(APPLIER_CALL_PATTERN),
        `${path} calls spawnGardenSubProposal(...) but does not route the patch through applyEffect(...). Garden patches must cross the sole applier (which enforces the broker) before a sub-Proposal is spawned; spawning an un-brokered patch breaks PATCH_EFFECT_BROKER_CHECKED_ON_EVERY_PATH.`,
      ).toBe(true);
    }
  });
});
