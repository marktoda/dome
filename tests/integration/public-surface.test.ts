import { describe, test, expect } from "bun:test";
import {
  openVault,
  readDocument,
  writeDocument,
  appendLog,
  searchIndex,
  wikilinkResolve,
  moveDocument,
  deleteDocument,
  makeDispatcher,
  INVARIANTS,
} from "../../src/index";
import { makeTestVault } from "../helpers/make-test-vault";

describe("public surface — Stage 1 contract", () => {
  test("all 7 Tools are exported and callable", async () => {
    expect(typeof readDocument).toBe("function");
    expect(typeof writeDocument).toBe("function");
    expect(typeof appendLog).toBe("function");
    expect(typeof searchIndex).toBe("function");
    expect(typeof wikilinkResolve).toBe("function");
    expect(typeof moveDocument).toBe("function");
    expect(typeof deleteDocument).toBe("function");
  });

  test("12 named invariants are enumerated in INVARIANTS const", () => {
    expect(Object.keys(INVARIANTS).length).toBe(12);
    expect(INVARIANTS.RAW_IS_IMMUTABLE).toBe("RAW_IS_IMMUTABLE");
    expect(INVARIANTS.INDEX_AND_LOG_ARE_DISPATCHER_OWNED).toBe("INDEX_AND_LOG_ARE_DISPATCHER_OWNED");
    expect(INVARIANTS.VAULT_IS_GIT_REPO).toBe("VAULT_IS_GIT_REPO");
  });

  test("end-to-end: open, write a page, read it back", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      expect(vault.ok).toBe(true);
      if (!vault.ok) return;
      const dispatcher = makeDispatcher(v.path);
      const w = await writeDocument(vault.value, dispatcher, {
        path: "wiki/entities/danny.md",
        body: "# Danny\n\n[[wiki/entities/maya]]",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });
      expect(w.result.ok).toBe(true);
      const r = await readDocument(vault.value, { path: "wiki/entities/danny.md" });
      expect(r.result.ok).toBe(true);
      if (r.result.ok) {
        expect(r.result.value.linksOut.length).toBe(1);
        expect(r.result.value.linksOut[0]!.target).toBe("wiki/entities/maya");
      }
    } finally {
      await v.cleanup();
    }
  });
});
