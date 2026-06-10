import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setAdoptedRef } from "../../src/adopted-ref";
import { commitOid } from "../../src/core/source-ref";
import { openVaultRuntime, type VaultRuntime } from "../../src/engine/host/vault-runtime";
import { runViewCommandWithRuntime } from "../../src/engine/host/view-command";
import { commit, initRepo } from "../../src/git";

type Fixture = {
  readonly vaultPath: string;
  readonly runtime: VaultRuntime;
  readonly head: string;
};

const fixtures: Fixture[] = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    const f = fixtures.pop();
    if (f === undefined) continue;
    await f.runtime.close();
    await rm(f.vaultPath, { recursive: true, force: true });
  }
});

describe("runViewCommandWithRuntime", () => {
  test("runs adopted-state view commands against a caller-owned runtime", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const query = await runViewCommandWithRuntime({
      runtime: f.runtime,
      branch: "main",
      adopted: commitOid(f.head),
      commandName: "query",
      commandArgs: { text: "alpha" },
    });

    expect(query.kind).toBe("ok");
    if (query.kind !== "ok") return;
    expect(query.result.kind).toBe("found");
    expect(query.capturedViews.length).toBe(1);
    expect(query.capturedViews[0]?.name).toBe("dome.search.query");

    const missing = await runViewCommandWithRuntime({
      runtime: f.runtime,
      branch: "main",
      adopted: commitOid(f.head),
      commandName: "not-a-command",
    });

    expect(missing.kind).toBe("ok");
    if (missing.kind !== "ok") return;
    expect(missing.result.kind).toBe("not-found");
  });

  test("retries when the adopted ref moves during projection rebuild", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeFile(
      join(f.vaultPath, "wiki", "beta.md"),
      "# Beta\n\nBeta appears only after adopted moves.\n",
      "utf8",
    );
    const newerHead = await commit({
      path: f.vaultPath,
      message: "add beta page\n",
      files: ["wiki/beta.md"],
    });
    const sequence = [commitOid(f.head), commitOid(newerHead), commitOid(newerHead)];

    const query = await runViewCommandWithRuntime({
      runtime: f.runtime,
      branch: "main",
      commandName: "query",
      commandArgs: { text: "beta" },
      readAdoptedForBranch: async () => {
        const next = sequence.shift();
        if (next === undefined) throw new Error("unexpected adopted read");
        return next;
      },
    });

    expect(query.kind).toBe("ok");
    if (query.kind !== "ok") return;
    expect(query.adopted).toBe(commitOid(newerHead));
    expect(query.result.kind).toBe("found");
    const data = query.capturedViews[0]?.content.kind === "structured"
      ? query.capturedViews[0].content.data
      : null;
    expect(JSON.stringify(data)).toContain("wiki/beta.md");
  });
});

async function makeFixture(): Promise<Fixture> {
  const vaultPath = mkdtempSync(join(tmpdir(), "dome-view-command-"));
  await initRepo(vaultPath);
  await mkdir(join(vaultPath, "wiki"), { recursive: true });
  await writeFile(
    join(vaultPath, "wiki", "alpha.md"),
    "# Alpha\n\nAlpha launch ownership notes.\n",
    "utf8",
  );
  const head = await commit({
    path: vaultPath,
    message: "seed alpha page\n",
    files: ["wiki/alpha.md"],
  });
  const adopted = await setAdoptedRef(vaultPath, "main", head);
  if (!adopted.ok) {
    throw new Error(`failed to set adopted ref: ${adopted.error.kind}`);
  }

  const runtime = await openVaultRuntime({
    vaultPath,
    bundlesRoot: join(import.meta.dir, "..", "..", "assets", "extensions"),
  });
  if (!runtime.ok) {
    throw new Error(`failed to open runtime: ${runtime.error.kind}`);
  }

  return { vaultPath, runtime: runtime.value, head };
}
