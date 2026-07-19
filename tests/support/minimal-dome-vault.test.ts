import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  currentBranch,
  currentSha,
  log,
  readBlob,
  statusMatrix,
} from "../../src/git";
import {
  initializeMinimalDomeVault,
  MINIMAL_DOME_VAULT_CONFIG,
} from "./minimal-dome-vault";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("initializeMinimalDomeVault", () => {
  test("creates only the real Git/HEAD/config boundary direct mutations require", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-minimal-vault-"));
    roots.push(root);

    await initializeMinimalDomeVault(root);

    expect(await currentBranch(root)).toBe("main");
    const head = await currentSha(root);
    expect(head).not.toBeNull();
    if (head === null) throw new Error("fixture did not create HEAD");
    expect(await readFile(join(root, ".dome/config.yaml"), "utf8"))
      .toBe(MINIMAL_DOME_VAULT_CONFIG);
    expect(await readBlob({ path: root, commit: head, filepath: ".dome/config.yaml" }))
      .toBe(MINIMAL_DOME_VAULT_CONFIG);
    const dirty = (await statusMatrix(root)).filter(
      ([, headState, workdir, stage]) =>
        !(headState === 1 && workdir === 1 && stage === 1),
    );
    expect(dirty).toEqual([]);

    const [entry] = await log({ path: root, depth: 1 });
    expect(entry?.commit.message).toBe("fixture: initialize minimal Dome vault\n");
    expect(entry?.commit.author).toMatchObject({
      name: "fixture",
      email: "fixture@local",
    });
  });
});
