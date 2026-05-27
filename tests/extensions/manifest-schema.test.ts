import { test, expect, describe } from "bun:test";
import { ManifestSchema, parseManifest } from "../../src/extensions/manifest-schema";

describe("ManifestSchema", () => {
  test("accepts a minimal valid manifest", () => {
    const r = ManifestSchema.safeParse({ name: "dailies", version: "1.0.0" });
    expect(r.success).toBe(true);
  });

  test("rejects missing name", () => {
    const r = ManifestSchema.safeParse({ version: "1.0.0" });
    expect(r.success).toBe(false);
  });

  test("rejects malformed version", () => {
    const r = ManifestSchema.safeParse({ name: "dailies", version: "not-semver" });
    expect(r.success).toBe(false);
  });

  test("accepts optional description and deps", () => {
    const r = ManifestSchema.safeParse({
      name: "x",
      version: "0.1.0",
      description: "test",
      deps: ["other"],
    });
    expect(r.success).toBe(true);
  });
});

describe("parseManifest", () => {
  test("returns Result.ok on valid YAML", () => {
    const r = parseManifest("name: dailies\nversion: 1.0.0\n", "dailies/manifest.yaml");
    expect(r.ok).toBe(true);
  });

  test("returns Result.err on malformed YAML", () => {
    const r = parseManifest(": not yaml :\n", "bad/manifest.yaml");
    expect(r.ok).toBe(false);
  });

  test("returns Result.err with detail:manifest-invalid on missing fields", () => {
    const r = parseManifest("description: foo\n", "missing-name/manifest.yaml");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("bundle-load-failure");
      if (r.error.kind === "bundle-load-failure") {
        expect(r.error.detail).toBe("manifest-invalid");
      }
    }
  });
});
