import { describe, test, expect } from "bun:test";
import { WorkflowRegistry } from "../../src/prompts/registry";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";

describe("WorkflowRegistry", () => {
  test("lists all 9 shipped workflows", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const reg = new WorkflowRegistry(res.value);
      const all = await reg.list();
      expect(all.length).toBe(9);
      expect(all.some((w) => w.name === "ingest")).toBe(true);
    } finally {
      await v.cleanup();
    }
  });

  test("get returns workflow by name", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const reg = new WorkflowRegistry(res.value);
      const wf = await reg.get("query");
      expect(wf).not.toBeNull();
      expect(wf!.name).toBe("query");
      expect(wf!.frontmatter.tools.includes("readDocument")).toBe(true);
    } finally {
      await v.cleanup();
    }
  });
});
