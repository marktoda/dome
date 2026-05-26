import { describe, test, expect } from "bun:test";
import { openVault } from "../../src/vault";
import { writeDocument } from "../../src/tools/write-document";
import { moveDocument } from "../../src/tools/move-document";
import { deleteDocument } from "../../src/tools/delete-document";
import { makeDispatcher } from "../../src/dispatcher";
import { makeTestVault } from "../helpers/make-test-vault";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// RAW_IS_IMMUTABLE: writeDocument, moveDocument, and deleteDocument MUST all
// refuse raw/ targets. Per the invariant's behavior matrix, all three mutating
// Tools share the same enforcement contract.

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

  test("moveDocument refuses raw/ targets with invariant-violated", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makeDispatcher(v.path);
      // Set up a source page outside raw/ to attempt moving INTO raw/.
      await mkdir(join(v.path, "wiki", "entities"), { recursive: true });
      await writeFile(join(v.path, "wiki", "entities", "alice.md"), "---\ntype: entity\n---\n# Alice");
      const out = await moveDocument(vault.value, dispatcher, {
        from: "wiki/entities/alice.md",
        to: "raw/captures/alice.md",
        reason: "should be refused",
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

  test("deleteDocument refuses raw/ paths with invariant-violated", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makeDispatcher(v.path);
      // Plant a raw file directly (out-of-band) so we can attempt deletion.
      await mkdir(join(v.path, "raw", "captures"), { recursive: true });
      await writeFile(join(v.path, "raw", "captures", "drop.md"), "# drop");
      const out = await deleteDocument(vault.value, dispatcher, {
        path: "raw/captures/drop.md",
        reason: "should be refused",
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
