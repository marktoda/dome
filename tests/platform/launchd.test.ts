import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { publishLaunchAgentPlist } from "../../src/platform/launchd";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("durable LaunchAgent plist publication", () => {
  test("publishes private bytes and syncs file before rename and parent", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-launchd-publish-"));
    roots.push(root);
    const path = join(root, "agents", "home.plist");
    await mkdir(join(root, "agents"));
    await publishLaunchAgentPlist(path, "private plist\n");
    expect(await readFile(path, "utf8")).toBe("private plist\n");
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const events: string[] = [];
    await publishLaunchAgentPlist(path, "next\n", {
      openTemporary: async () => ({
        writeFile: async () => { events.push("write"); },
        sync: async () => { events.push("file-sync"); },
        close: async () => { events.push("close"); },
      }),
      renamePath: async () => { events.push("rename"); },
      syncParent: async () => { events.push("parent-sync"); },
      removeTemporary: async () => { events.push("cleanup"); },
    });
    expect(events).toEqual(["write", "file-sync", "close", "rename", "parent-sync", "cleanup"]);
  });

  test("never renames before file sync and reports parent-sync uncertainty", async () => {
    const events: string[] = [];
    const handle = {
      writeFile: async () => { events.push("write"); },
      sync: async () => { events.push("file-sync"); throw new Error("file sync failed"); },
      close: async () => { events.push("close"); },
    };
    await expect(publishLaunchAgentPlist("/unused/home.plist", "x", {
      openTemporary: async () => handle,
      renamePath: async () => { events.push("rename"); },
      syncParent: async () => { events.push("parent-sync"); },
      removeTemporary: async () => { events.push("cleanup"); },
    })).rejects.toThrow("file sync failed");
    expect(events).toEqual(["write", "file-sync", "close", "cleanup"]);

    events.length = 0;
    await expect(publishLaunchAgentPlist("/unused/home.plist", "x", {
      openTemporary: async () => ({
        writeFile: async () => { events.push("write"); },
        sync: async () => { events.push("file-sync"); },
        close: async () => { events.push("close"); },
      }),
      renamePath: async () => { events.push("rename"); },
      syncParent: async () => { events.push("parent-sync"); throw new Error("parent sync failed"); },
      removeTemporary: async () => { events.push("cleanup"); },
    })).rejects.toThrow("parent sync failed");
    expect(events).toEqual(["write", "file-sync", "close", "rename", "parent-sync", "cleanup"]);
  });
});
