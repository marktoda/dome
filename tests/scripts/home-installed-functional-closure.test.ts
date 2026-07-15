import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertInstalledFunctionalClosure,
  prepareInstalledFunctionalClosure,
  type FunctionalClosureBoundary,
  type FunctionalClosureCanary,
  type FunctionalGitResult,
} from "../../scripts/home-installed-functional-closure";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("installed functional closure deep module", () => {
  test("collects H from Home-local Today and proves H <= adopted <= HEAD", async () => {
    const fixture = await fixtureBoundary();
    const canary = await prepareInstalledFunctionalClosure(fixture.boundary, 1_000);
    expect(canary.date).toBe("2026-07-15");
    expect(await git(fixture.root, ["merge-base", "--is-ancestor", canary.commit, await adopted(fixture.root)])).toBe(0);
    expect(await git(fixture.root, ["merge-base", "--is-ancestor", await adopted(fixture.root), "HEAD"])).toBe(0);
  });

  test("fails boundedly on Home-date rollover and an accepted response body that stalls", async () => {
    const rollover = await fixtureBoundary({ rollover: true });
    await expect(prepareInstalledFunctionalClosure(rollover.boundary, 1_000))
      .rejects.toThrow("crossed the authenticated Home-local date boundary");

    const stalled = await fixtureBoundary({ stallInitialTasks: true });
    const started = Date.now();
    await expect(prepareInstalledFunctionalClosure(stalled.boundary, 30))
      .rejects.toThrow("functional canary preparation did not complete within its bound");
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("rejects adopted history that does not contain H", async () => {
    const fixture = await fixtureBoundary({ keepSeedAdopted: true });
    await expect(prepareInstalledFunctionalClosure(fixture.boundary, 1_000))
      .rejects.toThrow("functional canary is not an ancestor of adopted truth");
  });

  test("proves receipted S ancestry, exact two paths, attribution, and exactly-once Markdown", async () => {
    const fixture = await settledFixture();
    await assertInstalledFunctionalClosure(fixture.boundary, fixture.canary, fixture.settleCommit, new AbortController().signal, 1_000);
  });

  test("rejects wrong S and an extra source-changing commit", async () => {
    const wrong = await settledFixture();
    await expect(assertInstalledFunctionalClosure(wrong.boundary, wrong.canary, wrong.seed, new AbortController().signal, 100))
      .rejects.toThrow("receipted commit");

    const extra = await settledFixture();
    await writeFile(join(extra.root, extra.canary.path), `${await readFile(join(extra.root, extra.canary.path), "utf8")}\nextra\n`);
    await commit(extra.root, [extra.canary.path], "extra source change", "Owner", "owner@example.invalid");
    await expect(assertInstalledFunctionalClosure(extra.boundary, extra.canary, extra.settleCommit, new AbortController().signal, 100))
      .rejects.toThrow("more than the receipted commit");
  });

  test.each([
    ["duplicate closed line", { duplicateSource: true }, "source is not durably closed exactly once"],
    ["duplicate Done bullet", { duplicateBullet: true }, "Done-today record is not durable exactly once"],
    ["missing trailer", { trailer: "missing" as const }, "attribution semantics"],
    ["duplicate trailer", { trailer: "duplicate" as const }, "attribution semantics"],
    ["mixed valid and wrong trailers", { trailer: "mixed" as const }, "attribution semantics"],
    ["wrong trailer", { trailer: "wrong" as const }, "attribution semantics"],
    ["extra changed path", { extraPath: true }, "attribution semantics"],
  ])("rejects %s", async (_name, options, message) => {
    const fixture = await settledFixture(options);
    await expect(assertInstalledFunctionalClosure(fixture.boundary, fixture.canary, fixture.settleCommit, new AbortController().signal, 1_000))
      .rejects.toThrow(message);
  });

  test("aborts a settlement poll without waiting for its full bound", async () => {
    const fixture = await fixtureBoundary();
    const canary = await prepareInstalledFunctionalClosure(fixture.boundary, 1_000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const started = Date.now();
    await expect(assertInstalledFunctionalClosure(fixture.boundary, canary, "f".repeat(40), controller.signal, 1_000))
      .rejects.toThrow("did not enter adopted Today truth");
    expect(Date.now() - started).toBeLessThan(500);
  });
});

type SettlementOptions = Readonly<{
  duplicateSource?: boolean;
  duplicateBullet?: boolean;
  trailer?: "missing" | "duplicate" | "mixed" | "wrong";
  extraPath?: boolean;
}>;

async function settledFixture(options: SettlementOptions = {}): Promise<{
  root: string; boundary: FunctionalClosureBoundary; canary: FunctionalClosureCanary; settleCommit: string; seed: string;
}> {
  const fixture = await fixtureBoundary();
  const canary = await prepareInstalledFunctionalClosure(fixture.boundary, 1_000);
  const closed = `- [x] ${canary.taskText} 📅 ${canary.date} ^${canary.blockId}`;
  const source = canary.content.replace(`- [ ] ${canary.taskText} 📅 ${canary.date} ^${canary.blockId}`, closed) +
    (options.duplicateSource ? `${closed}\n` : "");
  await writeFile(join(fixture.root, canary.path), source);
  const dailyPath = `wiki/dailies/${canary.date}.md`;
  await mkdir(join(fixture.root, "wiki", "dailies"), { recursive: true });
  const bullet = `- ${canary.taskText} 📅 ${canary.date} ([[notes/installed-functional-canary#^${canary.blockId}|from]])`;
  await writeFile(join(fixture.root, dailyPath), `# Daily\n\n### Done today\n${bullet}\n${options.duplicateBullet ? `${bullet}\n` : ""}`);
  const paths = [canary.path, dailyPath];
  if (options.extraPath) {
    await writeFile(join(fixture.root, "extra.md"), "extra\n");
    paths.push("extra.md");
  }
  const taskBody = `${canary.taskText} 📅 ${canary.date}`;
  const trailer = "Dome-Request: settle:close:11111111111111111111111111111111";
  const messages = options.trailer === "missing" ? [] : options.trailer === "wrong" ? ["Dome-Request: settle:close:wrong"] :
    options.trailer === "duplicate" ? [trailer, trailer] :
    options.trailer === "mixed" ? [trailer, "Dome-Request: settle:close:wrong"] : [trailer];
  const settleCommit = await commit(
    fixture.root, paths, `settle(close): ${taskBody.slice(0, 50)}`, "dome settle", "dome-settle@local", messages,
  );
  await gitOk(fixture.root, ["update-ref", "refs/dome/adopted/main", settleCommit]);
  fixture.state.settled = true;
  return { ...fixture, canary, settleCommit };
}

async function fixtureBoundary(options: Readonly<{
  rollover?: boolean; keepSeedAdopted?: boolean; stallInitialTasks?: boolean;
}> = {}): Promise<{
  root: string; boundary: FunctionalClosureBoundary; seed: string; state: { settled: boolean };
}> {
  const root = await mkdtemp(join(tmpdir(), "dome-installed-functional-"));
  roots.push(root);
  await gitOk(root, ["init", "-b", "main"]);
  await writeFile(join(root, "seed.md"), "seed\n");
  const seed = await commit(root, ["seed.md"], "seed", "Owner", "owner@example.invalid");
  await gitOk(root, ["update-ref", "refs/dome/adopted/main", seed]);
  const state = { settled: false };
  let taskReads = 0;
  const boundary: FunctionalClosureBoundary = {
    vaultPath: root,
    git: async (args, signal) => await runGit(root, args, signal),
    readHome: async (pathname, signal) => {
      signal.throwIfAborted();
      if (pathname === "/tasks") {
        taskReads += 1;
        if (options.stallInitialTasks && taskReads === 1) {
          await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        }
        const date = options.rollover && taskReads > 1 ? "2026-07-16" : "2026-07-15";
        if (taskReads === 1 || state.settled) return { date, openTasks: [] };
        const head = await gitOk(root, ["rev-parse", "HEAD"]);
        return { date, openTasks: [{ path: "notes/installed-functional-canary.md", text: "Close the installed functional closure canary", blockId: "tinstalledfunctional", dueDate: "2026-07-15" }], head };
      }
      const head = await gitOk(root, ["rev-parse", "HEAD"]);
      if (!options.keepSeedAdopted) await gitOk(root, ["update-ref", "refs/dome/adopted/main", head]);
      return { entries: [{ path: "notes/installed-functional-canary.md", title: "Installed functional closure canary", commit: head, changedBy: "human" }] };
    },
  };
  return { root, boundary, seed, state };
}

async function commit(root: string, paths: string[], subject: string, name: string, email: string, bodies: string[] = []): Promise<string> {
  await gitOk(root, ["add", "--", ...paths]);
  const args = ["-c", "commit.gpgsign=false", "-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-m", subject];
  for (const body of bodies) args.push("-m", body);
  args.push("--", ...paths);
  await gitOk(root, args);
  return await gitOk(root, ["rev-parse", "HEAD"]);
}
async function adopted(root: string): Promise<string> { return await gitOk(root, ["rev-parse", "refs/dome/adopted/main"]); }
async function git(root: string, args: string[]): Promise<number> { return (await runGit(root, args, new AbortController().signal)).exitCode; }
async function gitOk(root: string, args: string[]): Promise<string> {
  const result = await runGit(root, args, new AbortController().signal);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
async function runGit(root: string, args: ReadonlyArray<string>, signal: AbortSignal): Promise<FunctionalGitResult> {
  const child = Bun.spawn(["/usr/bin/git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe", signal, killSignal: "SIGKILL" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
