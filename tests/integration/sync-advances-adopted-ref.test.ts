// Structural-enforcement test for ADOPTED_REF_IS_SEMANTIC_CURSOR.
//
// Three canonical cases per docs/wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR.md
// §"Test guarantee":
//   1. Fresh vault → `sync` initializes refs/dome/adopted/main at HEAD.
//   2. Source-ahead vault → `sync` fast-forwards the ref.
//   3. Divergent vault → `sync` refuses; `sync --force-advance` accepts.

import { describe, test, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { openVault } from "../../src/vault";
import { sync } from "../../src/adoption";
import { getAdoptedRef, adoptedRefName } from "../../src/adopted-ref";
import { commit, currentSha, readRef, writeRef } from "../../src/git";
import { makeTestVault } from "../helpers/make-test-vault";

describe("sync advances refs/dome/adopted/<branch>", () => {
  test("case 1 — fresh vault: sync initializes the ref at HEAD", async () => {
    const v = await makeTestVault();
    try {
      const openRes = await openVault(v.path);
      if (!openRes.ok) throw new Error(`openVault failed: ${openRes.error.kind}`);
      const vault = openRes.value;

      // Pre-condition: ref does NOT exist.
      const before = await readRef({ path: v.path, ref: adoptedRefName("main") });
      expect(before).toBeNull();

      // Run sync.
      const r = await sync(vault);
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      // Post-condition: ref points at HEAD.
      const head = await currentSha(v.path);
      const adopted = await getAdoptedRef(v.path, "main");
      expect(adopted).not.toBeNull();
      expect(adopted).toBe(head);
      expect(r.value.adoptedBefore).toBeNull();
      expect(r.value.adoptedAfter).toBe(head!);

      await vault.close();
    } finally {
      await v.cleanup();
    }
  });

  test("case 2 — source-ahead: sync fast-forwards the ref", async () => {
    const v = await makeTestVault();
    try {
      // First sync: initializes adopted at the init commit.
      let openRes = await openVault(v.path);
      if (!openRes.ok) throw new Error(`openVault failed: ${openRes.error.kind}`);
      let r = await sync(openRes.value);
      expect(r.ok).toBe(true);
      await openRes.value.close();

      const initSha = await currentSha(v.path);

      // User makes a commit (simulating a workflow commit or a manual user commit).
      await writeFile(join(v.path, "notes", "ahead.md"), "ahead of adopted\n");
      const newSha = await commit({
        path: v.path,
        message: "manual: add note\n",
        files: ["notes/ahead.md"],
      });
      expect(newSha).not.toBe(initSha);

      // Second sync: should fast-forward adopted from initSha to newSha.
      openRes = await openVault(v.path);
      if (!openRes.ok) throw new Error(`openVault re-open failed: ${openRes.error.kind}`);
      r = await sync(openRes.value);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.adoptedBefore).toBe(initSha!);

      // The post-sync adopted ref equals the current HEAD (which may be
      // newSha or a later hook-driven commit). Assert ancestor-validity
      // rather than exact equality so the test tolerates hook-driven follow-on
      // writes.
      const finalHead = await currentSha(v.path);
      const adopted = await getAdoptedRef(v.path, "main");
      expect(adopted).toBe(finalHead);

      await openRes.value.close();
    } finally {
      await v.cleanup();
    }
  });

  test("case 3 — divergent: sync refuses; sync --force-advance accepts", async () => {
    const v = await makeTestVault();
    try {
      // First sync: initializes adopted at the init commit.
      let openRes = await openVault(v.path);
      if (!openRes.ok) throw new Error(`openVault failed: ${openRes.error.kind}`);
      const r1 = await sync(openRes.value);
      expect(r1.ok).toBe(true);
      await openRes.value.close();

      const initSha = await currentSha(v.path);

      // Simulate divergence: force-write the adopted ref to a fabricated SHA
      // that's NOT an ancestor of HEAD. Using a syntactically-valid but
      // unreachable SHA — git's isDescendent returns false for unknown OIDs,
      // which our `isAncestor` wrapper folds into "not an ancestor."
      const fakeSha = "f".repeat(40);
      await writeRef({ path: v.path, ref: adoptedRefName("main"), value: fakeSha });

      // Refuse without --force-advance.
      openRes = await openVault(v.path);
      if (!openRes.ok) throw new Error(`openVault re-open failed: ${openRes.error.kind}`);
      const r2 = await sync(openRes.value);
      expect(r2.ok).toBe(false);
      if (r2.ok) return;
      expect(r2.error.kind).toBe("validation");
      // The error message names the divergence-recovery flag.
      expect((r2.error as { message: string }).message).toContain("force-advance");
      await openRes.value.close();

      // Accept with --force-advance.
      openRes = await openVault(v.path);
      if (!openRes.ok) throw new Error(`openVault re-open failed: ${openRes.error.kind}`);
      const r3 = await sync(openRes.value, { forceAdvance: true });
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;
      const finalHead = await currentSha(v.path);
      expect(r3.value.adoptedAfter).toBe(finalHead!);

      await openRes.value.close();
      void initSha; // referenced for clarity even though we don't assert on it directly
    } finally {
      await v.cleanup();
    }
  });
});
