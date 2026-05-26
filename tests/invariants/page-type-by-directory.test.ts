import { describe, test, expect } from "bun:test";
import { openVault } from "../../src/vault";
import { writeDocument } from "../../src/tools/write-document";
import { moveDocument } from "../../src/tools/move-document";
import { makePrivilegedWriter } from "../../src/privileged-writer";
import { makeTestVault } from "../helpers/make-test-vault";

describe("PAGE_TYPE_BY_DIRECTORY", () => {
  test("rejects wiki/ writes with mismatched frontmatter type", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makePrivilegedWriter(v.path);
      const out = await writeDocument(vault.value, dispatcher, {
        path: "wiki/entities/danny.md",
        body: "# Danny",
        frontmatter: { type: "concept", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });
      expect(out.result.ok).toBe(false);
      if (!out.result.ok) {
        expect(out.result.error.kind).toBe("invariant-violated");
        if (out.result.error.kind === "invariant-violated") {
          expect(out.result.error.invariant).toBe("PAGE_TYPE_BY_DIRECTORY");
        }
      }
    } finally {
      await v.cleanup();
    }
  });

  test("rejects writes into wiki/<unknown-subdir>/", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makePrivilegedWriter(v.path);
      const out = await writeDocument(vault.value, dispatcher, {
        path: "wiki/mystery/abc.md",
        body: "x",
        frontmatter: { type: "mystery", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });
      expect(out.result.ok).toBe(false);
      if (!out.result.ok) {
        expect(out.result.error.kind).toBe("invariant-violated");
      }
    } finally {
      await v.cleanup();
    }
  });

  test("moveDocument rejects wiki destination with missing/unknown type", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makePrivilegedWriter(v.path);
      const seed = await writeDocument(vault.value, dispatcher, {
        path: "wiki/entities/danny.md",
        body: "# Danny",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });
      expect(seed.result.ok).toBe(true);
      // Move to a path that has no <type>/ segment — wiki/ direct child is rejected.
      const out = await moveDocument(vault.value, dispatcher, {
        from: "wiki/entities/danny.md",
        to: "wiki/danny.md",
        reason: "should reject — no type segment",
      });
      expect(out.result.ok).toBe(false);
      if (!out.result.ok) {
        expect(out.result.error.kind).toBe("invariant-violated");
        if (out.result.error.kind === "invariant-violated") {
          expect(out.result.error.invariant).toBe("PAGE_TYPE_BY_DIRECTORY");
        }
      }
    } finally {
      await v.cleanup();
    }
  });

  test("accepts wiki/ writes with matching frontmatter type", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makePrivilegedWriter(v.path);
      const out = await writeDocument(vault.value, dispatcher, {
        path: "wiki/entities/danny.md",
        body: "# Danny",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });
      expect(out.result.ok).toBe(true);
    } finally {
      await v.cleanup();
    }
  });
});
