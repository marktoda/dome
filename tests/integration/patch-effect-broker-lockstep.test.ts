// patch-effect-broker-lockstep: mechanical enforcer behind review §3.4.
//
// Invariant: PATCH_EFFECT_BROKER_CHECKED_ON_EVERY_PATH
//
// PatchEffect is the only effect that mutates the canonical markdown substrate,
// so it must always flow through the capability broker. There are TWO call
// sites that route PatchEffects:
//
//   1. src/engine/core/apply-effect.ts  — adoption-phase patches
//   2. src/engine/garden/garden-patch-router.ts — garden-phase patches
//
// The engine's `never`-exhaustive effect switch only fences the generic route;
// the garden route's broker call is a hand-maintained parallel. Without a
// mechanical test, either path could silently drop `enforceCapability` during a
// refactor and the invariant would be broken with no compile-time signal.
//
// Assertion shape: source-level. Read both files and assert each one contains a
// call to `enforceCapability`. This is the house pattern for cross-file
// contracts (mirrors engine-import-direction.test.ts); it does not ossify
// internal details beyond the single chokepoint symbol both paths must invoke.

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
const GARDEN_PATCH_ROUTER_PATH = join(
  REPO_ROOT,
  "src",
  "engine",
  "garden",
  "garden-patch-router.ts",
);

// The broker entry point both paths must call. We strip single-line comments
// before checking so a commented-out call does not satisfy the assertion. We
// check for the call-expression token `enforceCapability(` (with open-paren) so
// an import statement alone does not satisfy the check.
const BROKER_CALL_PATTERN = "enforceCapability(";

/** Strip `// ...` single-line comments from source so commented-out calls don't satisfy the check. */
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
  test("apply-effect.ts calls enforceCapability for the adoption PatchEffect path", async () => {
    const raw = await readFile(APPLY_EFFECT_PATH, "utf8");
    const source = stripLineComments(raw);
    expect(
      source.includes(BROKER_CALL_PATTERN),
      `apply-effect.ts must contain an active (non-commented) call to enforceCapability(...) — it is the broker entry for adoption-phase PatchEffects. If you removed or renamed this call, the adoption path no longer enforces capabilities (invariant PATCH_EFFECT_BROKER_CHECKED_ON_EVERY_PATH).`,
    ).toBe(true);
  });

  test("garden-patch-router.ts calls enforceCapability for the garden PatchEffect path", async () => {
    const raw = await readFile(GARDEN_PATCH_ROUTER_PATH, "utf8");
    const source = stripLineComments(raw);
    expect(
      source.includes(BROKER_CALL_PATTERN),
      `garden-patch-router.ts must contain an active (non-commented) call to enforceCapability(...) — it is the broker entry for garden-phase PatchEffects. If you removed or renamed this call, garden patches no longer enforce capabilities (invariant PATCH_EFFECT_BROKER_CHECKED_ON_EVERY_PATH).`,
    ).toBe(true);
  });
});
