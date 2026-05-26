import { describe, test, expect } from "bun:test";
import { makeDocument } from "../src/document";

describe("Document computed accessors", () => {
  test("category derives from top-level directory", () => {
    expect(makeDocument({ path: "wiki/entities/danny.md" }).category).toBe("wiki");
    expect(makeDocument({ path: "raw/2026-05-25.md" }).category).toBe("raw");
    expect(makeDocument({ path: "notes/draft.md" }).category).toBe("notes");
    expect(makeDocument({ path: "inbox/raw/abc.md" }).category).toBe("inbox");
    expect(makeDocument({ path: "log.md" }).category).toBe("log");
    expect(makeDocument({ path: "index.md" }).category).toBe("index");
    expect(makeDocument({ path: ".dome/config.yaml" }).category).toBe("config");
    expect(makeDocument({ path: ".git/HEAD" }).category).toBe("external");
    expect(makeDocument({ path: "cohesive/some-file.md" }).category).toBe("external");
  });

  test("type returns the PLURAL directory name (not the singular frontmatter form)", () => {
    // Per docs/wiki/specs/sdk-surface.md §"Document", document.type returns
    // the plural directory name. Frontmatter `type:` is the singular form;
    // the two are reconciled via page-type.ts (pluralOf / singularOf).
    expect(makeDocument({ path: "wiki/entities/danny.md" }).type).toBe("entities");
    expect(makeDocument({ path: "wiki/concepts/foo.md" }).type).toBe("concepts");
    expect(makeDocument({ path: "wiki/sources/x.md" }).type).toBe("sources");
    expect(makeDocument({ path: "wiki/syntheses/y.md" }).type).toBe("syntheses");
    // Explicit anti-assertion: NOT the singular form.
    expect(makeDocument({ path: "wiki/entities/danny.md" }).type).not.toBe("entity");
    expect(makeDocument({ path: "raw/abc.md" }).type).toBeNull();
    expect(makeDocument({ path: "notes/x.md" }).type).toBeNull();
  });

  test("isImmutable is true iff category is raw", () => {
    expect(makeDocument({ path: "raw/x.md" }).isImmutable).toBe(true);
    expect(makeDocument({ path: "wiki/entities/x.md" }).isImmutable).toBe(false);
    expect(makeDocument({ path: "notes/x.md" }).isImmutable).toBe(false);
    expect(makeDocument({ path: "inbox/raw/x.md" }).isImmutable).toBe(false);
  });
});
