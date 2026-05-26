import { describe, test, expect } from "bun:test";
import { ResourceAdapter, ResourceUri } from "../../src/mcp/resource-adapters";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";

describe("ResourceAdapter", () => {
  test("lists 3 base resources", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const ra = new ResourceAdapter(res.value);
      const list = await ra.list();
      expect(list.length).toBe(3);
    } finally {
      await v.cleanup();
    }
  });

  test("reads index resource", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const ra = new ResourceAdapter(res.value);
      const content = await ra.read(ResourceUri.Index);
      expect(content).not.toBeNull();
      expect(content!.mimeType).toBe("text/markdown");
    } finally {
      await v.cleanup();
    }
  });

  test("reads vault info as JSON", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const ra = new ResourceAdapter(res.value);
      const content = await ra.read(ResourceUri.VaultInfo);
      expect(content!.mimeType).toBe("application/json");
      const parsed = JSON.parse(content!.text);
      expect(parsed.path).toBe(res.value.path);
    } finally {
      await v.cleanup();
    }
  });
});
