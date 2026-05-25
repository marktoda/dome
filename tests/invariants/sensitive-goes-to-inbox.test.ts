import { describe, test, expect } from "bun:test";
import { openVault } from "../../src/vault";
import { writeDocument } from "../../src/tools/write-document";
import { makeDispatcher } from "../../src/dispatcher";
import { makeTestVault } from "../helpers/make-test-vault";

const ENABLED_CONFIG = `invariants:
  EVERY_WRITE_IS_LOGGED: enabled
  PAGE_TYPE_BY_DIRECTORY: enabled
  WIKILINKS_ARE_FULLPATH: enabled
  SENSITIVE_GOES_TO_INBOX: enabled
  PAGE_CREATION_REQUIRES_RECURRENCE: disabled
`;

describe("SENSITIVE_GOES_TO_INBOX", () => {
  test("when enabled: refuses sensitive write to wiki/", async () => {
    const v = await makeTestVault({ config: ENABLED_CONFIG });
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makeDispatcher(v.path);
      const out = await writeDocument(vault.value, dispatcher, {
        path: "wiki/entities/danny.md",
        body: "# Danny",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true, sensitivity_classified: "sensitive" },
      });
      expect(out.result.ok).toBe(false);
      if (!out.result.ok) {
        expect(out.result.error.kind).toBe("sensitive-must-route-to-inbox");
      }
    } finally {
      await v.cleanup();
    }
  });

  test("when enabled: allows sensitive write to inbox/review/", async () => {
    const v = await makeTestVault({ config: ENABLED_CONFIG });
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makeDispatcher(v.path);
      const out = await writeDocument(vault.value, dispatcher, {
        path: "inbox/review/2026-05-25-private.md",
        body: "sensitive content",
        frontmatter: {},
        opts: { create: true, sensitivity_classified: "sensitive" },
      });
      expect(out.result.ok).toBe(true);
    } finally {
      await v.cleanup();
    }
  });

  test("when disabled: sensitivity flag is ignored for wiki/ writes", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makeDispatcher(v.path);
      const out = await writeDocument(vault.value, dispatcher, {
        path: "wiki/entities/danny.md",
        body: "# Danny",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true, sensitivity_classified: "sensitive" },
      });
      expect(out.result.ok).toBe(true);
    } finally {
      await v.cleanup();
    }
  });
});
