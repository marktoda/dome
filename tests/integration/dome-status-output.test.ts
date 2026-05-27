// Output-shape test for `dome status`. Three canonical cases per
// docs/wiki/specs/adoption.md §"`dome status`":
//   1. Clean vault (adopted == HEAD, no pending, no dirty).
//   2. Source-ahead vault (adopted != HEAD, pending > 0).
//   3. Uninitialized vault (adopted null; pending null).

import { describe, test, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { domeStatus, statusToJson } from "../../src/cli/commands/status";
import { sync } from "../../src/adoption";
import { openVault } from "../../src/vault";
import { commit } from "../../src/git";
import { makeTestVault } from "../helpers/make-test-vault";

describe("dome status output", () => {
  test("uninitialized vault: adopted null, pending null", async () => {
    const v = await makeTestVault();
    try {
      const r = await domeStatus(v.path);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.status.adopted).toBeNull();
      expect(r.value.status.pendingCommits).toBeNull();
      expect(r.value.status.diverged).toBe(false);
      // The text rendering names the initialization story.
      const text = r.value.lines.join("\n");
      expect(text).toContain("uninitialized");
      // JSON shape preserves the nulls.
      const parsed = JSON.parse(statusToJson(r.value.status));
      expect(parsed.adopted).toBeNull();
      expect(parsed.pendingCommits).toBeNull();
    } finally {
      await v.cleanup();
    }
  });

  test("clean vault (adopted == HEAD): no pending, no dirty", async () => {
    const v = await makeTestVault();
    try {
      // Initialize adopted via sync first.
      const openRes = await openVault(v.path);
      if (!openRes.ok) throw new Error(`openVault failed: ${openRes.error.kind}`);
      const s = await sync(openRes.value);
      expect(s.ok).toBe(true);
      await openRes.value.close();

      const r = await domeStatus(v.path);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.status.adopted).not.toBeNull();
      expect(r.value.status.head).toBe(r.value.status.adopted!);
      expect(r.value.status.pendingCommits).toBe(0);
      expect(r.value.status.diverged).toBe(false);
    } finally {
      await v.cleanup();
    }
  });

  test("source-ahead vault: pending > 0, diverged false", async () => {
    const v = await makeTestVault();
    try {
      // Initialize.
      let openRes = await openVault(v.path);
      if (!openRes.ok) throw new Error(`openVault failed: ${openRes.error.kind}`);
      await sync(openRes.value);
      await openRes.value.close();

      // User makes a commit on top.
      await writeFile(join(v.path, "notes", "ahead.md"), "ahead\n");
      await commit({
        path: v.path,
        message: "manual: add note\n",
        files: ["notes/ahead.md"],
      });

      const r = await domeStatus(v.path);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.status.adopted).not.toBeNull();
      expect(r.value.status.head).not.toBe(r.value.status.adopted!);
      expect(r.value.status.pendingCommits).toBeGreaterThanOrEqual(1);
      expect(r.value.status.diverged).toBe(false);
    } finally {
      await v.cleanup();
    }
  });
});
