import { describe, expect, test } from "bun:test";

import {
  canonicalVaultPath,
  parseVaultPath,
  requireVaultPath,
  VaultPathSchema,
} from "../../src/core/vault-path";

describe("VaultPath", () => {
  test("canonicalizes duplicate slashes", () => {
    const path = canonicalVaultPath("wiki//entities///danny.md");
    expect(path as string | null).toBe("wiki/entities/danny.md");
  });

  test("rejects paths that are not vault-relative POSIX file paths", () => {
    expect(parseVaultPath("")).toMatchObject({ ok: false, error: "empty" });
    expect(parseVaultPath("/wiki/a.md")).toMatchObject({
      ok: false,
      error: "absolute",
    });
    expect(parseVaultPath("wiki\\a.md")).toMatchObject({
      ok: false,
      error: "backslash",
    });
    expect(parseVaultPath("wiki/../secret.md")).toMatchObject({
      ok: false,
      error: "dot-segment",
    });
    expect(parseVaultPath("wiki/a.md/")).toMatchObject({
      ok: false,
      error: "trailing-slash",
    });
  });

  test("schema transforms valid paths and rejects invalid paths", () => {
    expect(VaultPathSchema.parse("wiki//a.md") as string).toBe("wiki/a.md");
    expect(() => VaultPathSchema.parse("../secret.md")).toThrow(
      /vault-relative/,
    );
  });

  test("requireVaultPath throws a labelled error", () => {
    expect(() => requireVaultPath("../secret.md", "example.path")).toThrow(
      /example\.path/,
    );
  });
});
