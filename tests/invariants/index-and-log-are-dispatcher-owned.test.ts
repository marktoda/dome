import { describe, test, expect } from "bun:test";
import { openVault } from "../../src/vault";
import { writeDocument } from "../../src/tools/write-document";
import { makeDispatcher } from "../../src/dispatcher";
import { makeTestVault } from "../helpers/make-test-vault";

describe("INDEX_AND_LOG_ARE_DISPATCHER_OWNED", () => {
  test("writeDocument rejects index.md with dispatcher-owned-path", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makeDispatcher(v.path);
      const out = await writeDocument(vault.value, dispatcher, {
        path: "index.md",
        body: "# Bogus",
        frontmatter: {},
        opts: { create: false },
      });
      expect(out.result.ok).toBe(false);
      if (!out.result.ok) {
        expect(out.result.error.kind).toBe("dispatcher-owned-path");
      }
    } finally {
      await v.cleanup();
    }
  });

  test("writeDocument rejects log.md with dispatcher-owned-path", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makeDispatcher(v.path);
      const out = await writeDocument(vault.value, dispatcher, {
        path: "log.md",
        body: "Bogus log",
        frontmatter: {},
        opts: { create: false },
      });
      expect(out.result.ok).toBe(false);
      if (!out.result.ok) {
        expect(out.result.error.kind).toBe("dispatcher-owned-path");
      }
    } finally {
      await v.cleanup();
    }
  });
});
