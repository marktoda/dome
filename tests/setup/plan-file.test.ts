import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SETUP_PLAN_FILE_MAX_BYTES,
  createSetupPlanFileReader,
  readSetupPlanFile,
} from "../../src/setup/plan-file";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "dome-plan-file-"));
  roots.push(path);
  return path;
}

describe("setup plan file boundary", () => {
  test("rejects missing, oversized, symlinked, and special paths with bounded public errors", async () => {
    const directory = await root();
    const missing = join(directory, "private-owner-name.json");
    await expect(readSetupPlanFile(missing)).rejects.toThrow("plan file is unavailable");

    const oversized = join(directory, "oversized.json");
    await writeFile(oversized, "{}");
    await truncate(oversized, SETUP_PLAN_FILE_MAX_BYTES + 1);
    await expect(readSetupPlanFile(oversized)).rejects.toThrow(`exceeds ${SETUP_PLAN_FILE_MAX_BYTES} bytes`);

    const target = join(directory, "target.json");
    await writeFile(target, "owner secret content");
    const link = join(directory, "link.json");
    await symlink(target, link);
    await expect(readSetupPlanFile(link)).rejects.toThrow("safe direct regular file");

    const special = join(directory, "directory.json");
    await mkdir(special);
    await expect(readSetupPlanFile(special)).rejects.toThrow("safe direct regular file");

    for (const path of [missing, oversized, link, special]) {
      try {
        await readSetupPlanFile(path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain(path);
        expect(message).not.toContain("owner secret content");
      }
    }
  });

  test("rejects malformed and schema-invalid content without echoing it", async () => {
    const directory = await root();
    for (const [name, body] of [
      ["syntax.json", "super-secret-not-json"],
      ["schema.json", JSON.stringify({ schema: "owner-secret-schema" })],
    ] as const) {
      const path = join(directory, name);
      await writeFile(path, body);
      try {
        await readSetupPlanFile(path);
        throw new Error("expected plan rejection");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain("not a valid Dome setup plan");
        expect(message).not.toContain(body);
        expect(message).not.toContain(path);
      }
    }
  });

  test("rejects same-handle growth, truncation, and path replacement races", async () => {
    for (const race of ["grow", "truncate", "replace"] as const) {
      const directory = await root();
      const path = join(directory, `${race}.json`);
      await writeFile(path, "{}");
      const read = createSetupPlanFileReader({
        afterInitialProof: async () => {
          if (race === "grow") await appendFile(path, "more");
          if (race === "truncate") await truncate(path, 0);
          if (race === "replace") {
            await rename(path, join(directory, "original.json"));
            await writeFile(path, "{}");
          }
        },
      });
      await expect(read(path)).rejects.toThrow("safe direct regular file");
    }
  });
});
