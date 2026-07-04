import { describe, expect, test } from "bun:test";
import { writeScopeDenial, DEFAULT_AGENT_WRITE_SCOPE } from "../../src/write-scope";

describe("writeScopeDenial (default agent scope)", () => {
  test("allows ordinary wiki + daily markdown", () => {
    for (const p of ["wiki/notes/foo.md", "wiki/entities/x.md", "daily/2026-06-19.md", "core.md"]) {
      expect(writeScopeDenial(p, DEFAULT_AGENT_WRITE_SCOPE)).toBeNull();
    }
  });
  test("denies generated/frozen registry files", () => {
    for (const p of ["index.md", "log.md"]) {
      expect(writeScopeDenial(p, DEFAULT_AGENT_WRITE_SCOPE)).not.toBeNull();
    }
  });
  test("denies RAW inbox", () => {
    expect(writeScopeDenial("inbox/raw/2026-06-19-1200-x.md", DEFAULT_AGENT_WRITE_SCOPE)).not.toBeNull();
  });
  test("a custom scope whose allow-list excludes a path denies it", () => {
    const scope = { allow: ["wiki/**"], deny: [] as string[] };
    expect(writeScopeDenial("daily/x.md", scope)).not.toBeNull();
    expect(writeScopeDenial("wiki/x.md", scope)).toBeNull();
  });
  test("an empty allow-list means allow-all (only deny gates)", () => {
    expect(writeScopeDenial("anything/x.md", { allow: [], deny: [] })).toBeNull();
    expect(writeScopeDenial("x.md", { allow: [], deny: ["x.md"] })).not.toBeNull();
  });
});
