import { describe, test, expect } from "bun:test";
import { openVault } from "../../src/vault";
import { writeDocument } from "../../src/tools/write-document";
import { makeDispatcher } from "../../src/dispatcher";
import { makeTestVault } from "../helpers/make-test-vault";

describe("RAW_IS_IMMUTABLE", () => {
  test("writeDocument refuses raw/ paths with invariant-violated", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makeDispatcher(v.path);
      const out = await writeDocument(vault.value, dispatcher, {
        path: "raw/2026-05-25-voice-note.md",
        body: "transcript",
        frontmatter: { id: "raw_2026-05-25_0900_voice", source_type: "voice", status: "pending", sensitivity: "normal" },
        opts: { create: true },
      });
      expect(out.result.ok).toBe(false);
      if (!out.result.ok) {
        expect(out.result.error.kind).toBe("invariant-violated");
        if (out.result.error.kind === "invariant-violated") {
          expect(out.result.error.invariant).toBe("RAW_IS_IMMUTABLE");
        }
      }
      expect(out.effects.length).toBe(0);
    } finally {
      await v.cleanup();
    }
  });
});
