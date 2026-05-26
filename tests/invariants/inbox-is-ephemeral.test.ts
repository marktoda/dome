// INBOX_IS_EPHEMERAL is the off-matrix invariant: it's enforced not by the
// dispatcher's effects-projection pipeline but by the language of the intake
// workflow prompts. Each intake workflow must (a) bind `deleteDocument` so it
// can actually drop inbox files, and (b) instruct the agent to delete the
// inbox file on completion. This test pins both shapes so a future prompt
// edit can't silently regress the invariant.

import { describe, test, expect } from "bun:test";
import { PromptLoader } from "../../src/prompts/prompt-loader";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";

const INTAKE_WORKFLOWS = ["ingest", "voice-ingest", "research", "clip-integrate"] as const;

describe("INBOX_IS_EPHEMERAL (workflow-prompt-enforced)", () => {
  for (const name of INTAKE_WORKFLOWS) {
    test(`${name} workflow binds deleteDocument and instructs deletion`, async () => {
      const v = await makeTestVault();
      try {
        const res = await openVault(v.path);
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        const loader = new PromptLoader(res.value);
        const p = await loader.load(name);
        expect(p).not.toBeNull();
        expect(p!.workflow).not.toBeNull();
        // (a) the workflow must bind deleteDocument in its tool surface
        expect(p!.workflow!.tools).toContain("deleteDocument");
        // (b) the prompt body must reference both `inbox` and `deleteDocument`
        expect(p!.body.toLowerCase()).toContain("inbox");
        expect(p!.body).toContain("deleteDocument");
      } finally {
        await v.cleanup();
      }
    });
  }
});

describe("INBOX_IS_EPHEMERAL (dome doctor fallback)", () => {
  test("dome doctor flags a backdated inbox/raw/ file", async () => {
    const { writeFile, utimes, mkdir } = await import("node:fs/promises");
    const { domeDoctor } = await import("../../src/cli/commands/doctor");

    const v = await makeTestVault();
    try {
      await mkdir(`${v.path}/inbox/raw`, { recursive: true });
      const stalePath = `${v.path}/inbox/raw/forgotten.md`;
      await writeFile(stalePath, "still here");
      const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await utimes(stalePath, longAgo, longAgo);

      const r = await domeDoctor(v.path);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.exitCode).toBe(1);
      const inboxViolation = r.value.violations.find(v => v.includes("inbox/raw/forgotten.md"));
      expect(inboxViolation).toBeDefined();
      expect(inboxViolation).toContain("INBOX_IS_EPHEMERAL");
    } finally {
      await v.cleanup();
    }
  });

  test("dome doctor excludes inbox/review/ from the stale-age check", async () => {
    const { writeFile, utimes, mkdir } = await import("node:fs/promises");
    const { domeDoctor } = await import("../../src/cli/commands/doctor");

    const v = await makeTestVault();
    try {
      await mkdir(`${v.path}/inbox/review`, { recursive: true });
      const oldReview = `${v.path}/inbox/review/pending-review.md`;
      await writeFile(oldReview, "needs review");
      const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await utimes(oldReview, longAgo, longAgo);

      const r = await domeDoctor(v.path);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // inbox/review/ MUST NOT appear in violations — it's a destination, not an intake.
      const reviewViolation = r.value.violations.find(v => v.includes("inbox/review/"));
      expect(reviewViolation).toBeUndefined();
    } finally {
      await v.cleanup();
    }
  });
});
