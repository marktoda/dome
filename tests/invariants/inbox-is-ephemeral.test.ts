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
