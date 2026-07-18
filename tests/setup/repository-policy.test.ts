import { describe, expect, test } from "bun:test";

import {
  deriveSetupRepositoryCandidate,
  sensitiveRepositoryPath,
  SETUP_REPOSITORY_MAX_BASELINE_FILE_BYTES,
  validateSetupRepositoryCandidate,
} from "../../src/setup/repository-policy";

describe("setup repository policy", () => {
  test("uses a closed case-insensitive sensitive-component policy without broad env false positives", () => {
    for (const path of [
      ".env", ".ENV.production", ".env-local", ".env_private", ".envrc", ".ENVRC.local",
      "secrets/value.json", "nested/CREDENTIALS.json", "keys/id_ed25519", "certs/owner.P12",
    ]) expect(sensitiveRepositoryPath(path)).toBe(true);
    for (const path of ["environment.md", ".envoy", "tokenization.md", "keynote.md", "private.md"]) {
      expect(sensitiveRepositoryPath(path)).toBe(false);
    }
  });

  test("derives exact baseline, tracked, ignored, private, and unsafe dispositions", () => {
    const candidate = (overrides: Partial<Parameters<typeof deriveSetupRepositoryCandidate>[0]> = {}) =>
      deriveSetupRepositoryCandidate({
        path: "Owner.md", kind: "file", bytes: 8, tracking: "other", gitDirect: false,
        observedReason: "safe-owner-file", ...overrides,
      });
    expect(candidate()).toMatchObject({ disposition: "baseline", reason: "safe-owner-file" });
    expect(candidate({ tracking: "tracked", gitDirect: true })).toMatchObject({ disposition: "already-tracked" });
    expect(candidate({ path: "cache/a.md", tracking: "ignored" })).toMatchObject({
      disposition: "preserve-untracked", reason: "ignored-by-owner",
    });
    expect(candidate({ path: ".dome/state/runs.db" })).toMatchObject({
      disposition: "preserve-untracked", reason: "dome-private",
    });
    expect(candidate({ path: ".DOME", kind: "directory", observedReason: "directory-not-tracked" })).toMatchObject({
      disposition: "blocked", reason: "private-case-alias",
    });
  });

  test("rejects forged sensitive baselines and every inconsistent public tuple", () => {
    const forged = {
      path: ".envrc", kind: "file" as const, bytes: 3, tracking: "other" as const,
      disposition: "baseline" as const, reason: "safe-owner-file" as const,
    };
    expect(() => validateSetupRepositoryCandidate(forged, false)).toThrow("canonical policy");
    expect(() => validateSetupRepositoryCandidate({
      ...forged, path: "notes", kind: "directory", reason: "directory-not-tracked",
    }, false)).toThrow("canonical policy");
    expect(() => validateSetupRepositoryCandidate({
      ...forged, path: "Owner.md", tracking: "tracked", disposition: "preserve-untracked",
    }, true)).toThrow("canonical policy");
    for (const candidate of [
      { ...forged, path: "socket", kind: "special" as const },
      { ...forged, path: "shortcut", kind: "symlink" as const },
      { ...forged, path: "archive.bin", bytes: SETUP_REPOSITORY_MAX_BASELINE_FILE_BYTES + 1 },
    ]) expect(() => validateSetupRepositoryCandidate(candidate, false)).toThrow();
  });
});
