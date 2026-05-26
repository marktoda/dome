import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openVault } from "../../src/vault";
import { appendLog } from "../../src/tools/append-log";
import { makePrivilegedWriter } from "../../src/privileged-writer";
import { makeTestVault } from "../helpers/make-test-vault";

describe("LOG_IS_APPEND_ONLY", () => {
  test("appendLog produces an appended-log Effect", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      expect(vault.ok).toBe(true);
      if (!vault.ok) return;
      const dispatcher = makePrivilegedWriter(v.path);
      const out = await appendLog(vault.value, dispatcher, {
        verb: "bootstrap",
        subject: "initial vault setup",
      });
      expect(out.result.ok).toBe(true);
      expect(out.effects.length).toBe(1);
      expect(out.effects[0]!.kind).toBe("appended-log");
    } finally {
      await v.cleanup();
    }
  });

  test("appendLog only adds; never rewrites prior entries", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makePrivilegedWriter(v.path);
      await appendLog(vault.value, dispatcher, { verb: "first", subject: "A" });
      const after1 = await readFile(join(v.path, "log.md"), "utf8");
      await appendLog(vault.value, dispatcher, { verb: "second", subject: "B" });
      const after2 = await readFile(join(v.path, "log.md"), "utf8");
      expect(after2.startsWith(after1)).toBe(true);
      expect(after2.length).toBeGreaterThan(after1.length);
    } finally {
      await v.cleanup();
    }
  });
});
