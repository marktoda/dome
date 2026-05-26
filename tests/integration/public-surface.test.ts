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
  INVARIANTS,
} from "../../src/index";
// makePrivilegedWriter is INTERNAL — NOT exported from src/index. The structural
// enforcement of INDEX_AND_LOG_ARE_DISPATCHER_OWNED depends on plugin/consumer
// code being unable to construct one. Tests live inside the SDK boundary and
// reach into the private path explicitly to set up the end-to-end vault.
import { makePrivilegedWriter } from "../../src/privileged-writer";
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

  test("the INVARIANTS const enumerates the canonical named invariants by membership (not count)", () => {
    // Per docs/wiki/gotchas/substrate-count-drift.md, inline counts in tests
    // drift as the substrate grows. Check membership of the canonical axioms
    // instead — adding a new axiom doesn't require a test edit.
    expect(INVARIANTS.RAW_IS_IMMUTABLE).toBe("RAW_IS_IMMUTABLE");
    expect(INVARIANTS.INDEX_AND_LOG_ARE_DISPATCHER_OWNED).toBe("INDEX_AND_LOG_ARE_DISPATCHER_OWNED");
    expect(INVARIANTS.VAULT_IS_GIT_REPO).toBe("VAULT_IS_GIT_REPO");
    expect(INVARIANTS.CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY).toBe("CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY");
    // Sanity: there are at least 13 entries (the seven Phase A invariants plus
    // the six axioms; lower bound only). For the actual count, see the
    // canonical list at docs/wiki/invariants/.
    expect(Object.keys(INVARIANTS).length).toBeGreaterThanOrEqual(13);
  });

  test("end-to-end: open, write a page, read it back", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      expect(vault.ok).toBe(true);
      if (!vault.ok) return;
      const dispatcher = makePrivilegedWriter(v.path);
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
