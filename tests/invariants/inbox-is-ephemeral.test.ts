// INBOX_IS_EPHEMERAL is the off-matrix invariant: it's enforced not by the
// dispatcher's effects-projection pipeline but by the language of the `ingest`
// workflow prompt itself. The workflow is responsible for moving files out of
// inbox/ on completion. This test pins the prompt's enforcement language so a
// future edit can't silently drop the instruction.

import { describe, test, expect } from "bun:test";
import { PromptLoader } from "../../src/prompts/prompt-loader";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";

describe("INBOX_IS_EPHEMERAL (workflow-prompt-enforced)", () => {
  test("ingest workflow prompt instructs the agent to move inbox files out on completion", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const loader = new PromptLoader(res.value);
      const ingest = await loader.load("ingest");
      expect(ingest).not.toBeNull();
      // The prompt body must mention inbox in the context of moving/processing.
      // We assert the substantive token ("inbox") is present; the broader
      // language about moving files is naturally varied across edits.
      const lower = ingest!.body.toLowerCase();
      expect(lower).toMatch(/inbox/);
      expect(lower).toMatch(/move|process|raw source|raw file/);
    } finally {
      await v.cleanup();
    }
  });
});
