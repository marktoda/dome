import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { copyFile, link, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { publishLaunchAgentPlist, renderLaunchAgentPlist } from "../../src/platform/launchd";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("durable LaunchAgent plist publication", () => {
  test("renders a separate Program without changing legacy argv-owned plists", () => {
    const base = {
      label: "com.dome.test",
      programArguments: ["legacy-program", "arg"],
      workingDirectory: "/vault",
      logPath: "/vault/home.log",
      environment: new Map<string, string>(),
    };
    const legacy = renderLaunchAgentPlist(base);
    expect(legacy).not.toContain("<key>Program</key>");
    expect(legacy).toContain(
      "<key>ProgramArguments</key>\n  <array>\n    <string>legacy-program</string>",
    );

    const named = renderLaunchAgentPlist({
      ...base,
      program: "/release/runtime/bun",
      programArguments: ["Dome Home", "/release/app/bin/dome", "home"],
    });
    expect(named).toContain(
      "<key>Program</key>\n  <string>/release/runtime/bun</string>\n" +
      "  <key>ProgramArguments</key>\n  <array>\n    <string>Dome Home</string>\n" +
      "    <string>/release/app/bin/dome</string>\n    <string>home</string>",
    );
  });

  test("macOS reports the actual Dome Home Bun alias for command and accounting names", async () => {
    if (process.platform !== "darwin") return;
    const root = mkdtempSync(join(tmpdir(), "dome-launch-name-probe-"));
    roots.push(root);
    const canonical = join(root, "bun");
    const program = join(root, "Dome Home");
    // The test runner may live on another volume (for example a Nix store),
    // so first stage a local canonical copy just as the artifact builder does.
    await copyFile(process.execPath, canonical);
    await link(canonical, program);
    const programArguments = ["Dome Home", "-e", "setInterval(() => {}, 1_000)"];
    const plist = renderLaunchAgentPlist({
      label: "com.dome.argv0-probe",
      program,
      programArguments,
      workingDirectory: "/",
      logPath: "/tmp/dome-argv0-probe.log",
      environment: new Map(),
    });
    expect(plist).toContain(`<key>Program</key>\n  <string>${program}</string>`);
    expect(plist).toContain("<array>\n    <string>Dome Home</string>");

    // launchd maps Program to execv(3)'s executable and ProgramArguments to
    // argv. Bun.spawn's argv0 seam exercises that same kernel-facing shape
    // without installing a real per-user LaunchAgent during the test.
    const child = Bun.spawn({
      cmd: [program, ...programArguments.slice(1)],
      argv0: programArguments[0]!,
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      let commandName = "";
      let accountingName = "";
      for (let attempt = 0; attempt < 50 &&
        (commandName !== "Dome Home" || accountingName !== "Dome Home"); attempt++) {
        const inspect = async (field: "comm=" | "ucomm="): Promise<string> => {
          const ps = Bun.spawn({
            cmd: ["/bin/ps", "-o", field, "-p", String(child.pid)],
            stdout: "pipe",
            stderr: "ignore",
          });
          const value = (await new Response(ps.stdout).text()).trim();
          await ps.exited;
          return value;
        };
        [commandName, accountingName] = await Promise.all([inspect("comm="), inspect("ucomm=")]);
        if (commandName !== "Dome Home" || accountingName !== "Dome Home") await Bun.sleep(10);
      }
      expect(commandName).toBe("Dome Home");
      expect(accountingName).toBe("Dome Home");
    } finally {
      child.kill();
      await child.exited;
    }
  });

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
