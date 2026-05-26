import { describe, test, expect } from "bun:test";
import { openVault } from "../../src/vault";
import { writeDocument } from "../../src/tools/write-document";
import { makePrivilegedWriter } from "../../src/privileged-writer";
import { makeTestVault } from "../helpers/make-test-vault";

const ENABLED_CONFIG = `invariants:
  EVERY_WRITE_IS_LOGGED: enabled
  PAGE_TYPE_BY_DIRECTORY: enabled
  WIKILINKS_ARE_FULLPATH: enabled
  SENSITIVE_GOES_TO_INBOX: disabled
  PAGE_CREATION_REQUIRES_RECURRENCE: enabled
`;

describe("PAGE_CREATION_REQUIRES_RECURRENCE", () => {
  test("when enabled: create without reason returns page-creation-requires-reason", async () => {
    const v = await makeTestVault({ config: ENABLED_CONFIG });
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
      expect(out.result.ok).toBe(false);
      if (!out.result.ok) {
        expect(out.result.error.kind).toBe("page-creation-requires-reason");
      }
    } finally {
      await v.cleanup();
    }
  });

  test("when enabled: create with reason succeeds", async () => {
    const v = await makeTestVault({ config: ENABLED_CONFIG });
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makePrivilegedWriter(v.path);
      const out = await writeDocument(vault.value, dispatcher, {
        path: "wiki/entities/danny.md",
        body: "# Danny",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true, reason: "named_explicitly" },
      });
      expect(out.result.ok).toBe(true);
    } finally {
      await v.cleanup();
    }
  });

  test("when disabled: create without reason succeeds", async () => {
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
