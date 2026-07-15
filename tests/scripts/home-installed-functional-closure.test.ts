import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertInstalledFunctionalClosure,
  hasExactTaskForTests,
  prepareInstalledFunctionalClosure,
  type FunctionalClosureBoundary,
  type FunctionalClosureCanary,
  type FunctionalGitResult,
} from "../../scripts/home-installed-functional-closure";

const roots: string[] = [];
const CORRECTNESS_MS = 5_000;
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("installed functional closure deep module", () => {
  test("collects H from Home-local Today and proves H <= adopted <= HEAD", async () => {
    const fixture = await fixtureBoundary();
    const canary = await prepareInstalledFunctionalClosure(fixture.boundary, CORRECTNESS_MS);
    expect(canary.date).toBe("2026-07-15");
    expect(await git(fixture.root, ["merge-base", "--is-ancestor", canary.commit, await adopted(fixture.root)])).toBe(0);
    expect(await git(fixture.root, ["merge-base", "--is-ancestor", await adopted(fixture.root), "HEAD"])).toBe(0);
  });

  test("keeps one H while adopted truth, Recents, and Today converge at different times", async () => {
    const fixture = await fixtureBoundary({ adoptAfterChecks: 2, recentsAfterReads: 2, todayAfterReads: 2 });
    const canary = await prepareInstalledFunctionalClosure(fixture.boundary, {
      setupMs: CORRECTNESS_MS,
      convergenceMs: CORRECTNESS_MS,
      pollMs: 1,
    });
    expect(canary.commit).toBe(await gitOk(fixture.root, ["rev-parse", "HEAD"]));
    expect((await gitOk(fixture.root, ["rev-list", "--count", `${fixture.seed}..HEAD`, "--", canary.path]))).toBe("1");
  });

  test("fails boundedly on Home-date rollover and an accepted response body that stalls", async () => {
    const rollover = await fixtureBoundary({ rollover: true });
    await expect(prepareInstalledFunctionalClosure(rollover.boundary, CORRECTNESS_MS))
      .rejects.toThrow("crossed the authenticated Home-local date boundary");

    const stalled = await fixtureBoundary({ stallInitialTasks: true });
    const started = Date.now();
    await expect(prepareInstalledFunctionalClosure(stalled.boundary, 30))
      .rejects.toThrow("functional canary preparation did not complete within its bound");
    expect(Date.now() - started).toBeLessThan(500);
  });

  test.each([
    ["H is not adopted", { keepSeedAdopted: true }, "human-not-adopted", false, false, false],
    ["H is adopted but Recents is missing", { stallRecents: true }, "adopted-recents-missing", true, false, false],
    ["H and Recents are present but Today is missing", { stallToday: true }, "adopted-recents-present-today-missing", true, true, false],
  ] as const)("classifies convergence timeout when %s", async (_name, options, phase, inAdopted, inRecents, inToday) => {
    const fixture = await fixtureBoundary(options);
    let error: unknown;
    try {
      await prepareInstalledFunctionalClosure(fixture.boundary, { setupMs: CORRECTNESS_MS, convergenceMs: 500, pollMs: 1 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    const head = await gitOk(fixture.root, ["rev-parse", "HEAD"]);
    const expectedAdopted = inAdopted ? head : fixture.seed;
    expect(message).toBe(
      `functional canary convergence timed out: phase=${phase} humanCommit=${head} adoptedCommit=${expectedAdopted} ` +
      `humanInAdopted=${inAdopted} recentsPresent=${inRecents} todayPresent=${inToday}`,
    );
    expect(message).not.toContain("Installed functional closure canary");
    expect(message).not.toContain("Close the installed functional closure canary");
  });

  test("accepts one daily display row with exact human-origin provenance", () => {
    const canary = canaryFixture();
    expect(hasExactTaskForTests(todayDocument(canary), canary)).toBe(true);
  });

  test.each([
    ["missing", (canary: FunctionalClosureCanary) => ({ ...todayTaskFixture(canary), sourceRefs: [] })],
    ["duplicate", (canary: FunctionalClosureCanary) => {
      const row = todayTaskFixture(canary);
      const origin = todayOriginRef(canary);
      return { ...row, sourceRefs: [todayDailyRef(canary), origin, origin] };
    }],
    ["wrong commit", (canary: FunctionalClosureCanary) => {
      const row = todayTaskFixture(canary);
      return {
        ...row,
        sourceRefs: [
          todayDailyRef(canary),
          { ...todayOriginRef(canary), commit: "f".repeat(40) },
        ],
      };
    }],
    ["wrong stable anchor", (canary: FunctionalClosureCanary) => {
      const row = todayTaskFixture(canary);
      return {
        ...row,
        sourceRefs: [
          todayDailyRef(canary),
          { ...todayOriginRef(canary), stableId: "dome.daily.open-loop:wrong" },
        ],
      };
    }],
  ] as const)("rejects %s Today origin provenance", (_name, mutate) => {
    const canary = canaryFixture();
    expect(hasExactTaskForTests(todayDocument(canary, [mutate(canary)]), canary)).toBe(false);
  });

  test("rejects duplicate semantic Today rows", () => {
    const canary = canaryFixture();
    const row = todayTaskFixture(canary);
    expect(hasExactTaskForTests(todayDocument(canary, [row, row]), canary)).toBe(false);
  });

  test("rejects an unrelated Today display path", () => {
    const canary = canaryFixture();
    const row = { ...todayTaskFixture(canary), path: "notes/unrelated.md" };
    expect(hasExactTaskForTests(todayDocument(canary, [row]), canary)).toBe(false);
  });

  test("proves receipted S ancestry, exact two paths, attribution, and exactly-once Markdown", async () => {
    const fixture = await settledFixture();
    await assertInstalledFunctionalClosure(fixture.boundary, fixture.canary, fixture.settleCommit, new AbortController().signal, CORRECTNESS_MS);
  });

  test("waits for one receipted S to enter adopted Today truth", async () => {
    const fixture = await settledFixture({ settlementState: "delayed" });
    await assertInstalledFunctionalClosure(
      fixture.boundary,
      fixture.canary,
      fixture.settleCommit,
      new AbortController().signal,
      { timeoutMs: CORRECTNESS_MS, pollMs: 1 },
    );
    expect(await adopted(fixture.root)).toBe(fixture.settleCommit);
  });

  test("binds S ancestry to the immutable HEAD observed after an adopted-ref advance", async () => {
    const fixture = await settledFixture();
    await gitOk(fixture.root, [
      "-c", "commit.gpgsign=false", "-c", "user.name=Dome Engine", "-c", "user.email=engine@dome.invalid",
      "commit", "--allow-empty", "-m", "engine closure",
    ]);
    const closureCommit = await gitOk(fixture.root, ["rev-parse", "HEAD"]);
    await gitOk(fixture.root, ["update-ref", "refs/dome/adopted/main", closureCommit]);
    await gitOk(fixture.root, ["update-ref", "refs/heads/main", fixture.settleCommit]);
    let advanced = false;
    const boundary: FunctionalClosureBoundary = {
      ...fixture.boundary,
      git: async (args, signal) => {
        const result = await fixture.boundary.git(args, signal);
        if (!advanced && JSON.stringify(args) === JSON.stringify(["rev-parse", "--verify", "refs/dome/adopted/main"])) {
          advanced = true;
          await gitOk(fixture.root, ["update-ref", "refs/heads/main", closureCommit]);
        }
        return result;
      },
    };
    await assertInstalledFunctionalClosure(
      boundary,
      fixture.canary,
      fixture.settleCommit,
      new AbortController().signal,
      CORRECTNESS_MS,
    );
    expect(advanced).toBe(true);
    expect(await gitOk(fixture.root, ["rev-parse", "HEAD"])).toBe(closureCommit);
  });

  test.each([
    ["S is not observed", "not-observed", "settlement-not-observed", false, false, false],
    ["S is observed but not adopted", "unadopted", "settlement-not-adopted", true, false, false],
    ["S is adopted but Today remains open", "today-open", "settlement-adopted-today-open", true, true, false],
  ] as const)("classifies settlement convergence timeout when %s", async (_name, state, phase, observed, inAdopted, todayClosed) => {
    const fixture = state === "not-observed"
      ? await unsettledFixture()
      : await settledFixture({ settlementState: state });
    let error: unknown;
    try {
      await assertInstalledFunctionalClosure(
        fixture.boundary,
        fixture.canary,
        fixture.settleCommit,
        new AbortController().signal,
        { timeoutMs: 500, pollMs: 1 },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const head = await gitOk(fixture.root, ["rev-parse", "HEAD"]);
    const expectedAdopted = inAdopted ? fixture.settleCommit : await adopted(fixture.root);
    expect((error as Error).message).toBe(
      `functional task settlement convergence timed out: phase=${phase} settlementCommit=${fixture.settleCommit} ` +
      `headCommit=${head} adoptedCommit=${expectedAdopted} settlementObserved=${observed} ` +
      `settlementInAdopted=${inAdopted} todayClosed=${todayClosed}`,
    );
  });

  test("classifies a final S evidence stall inside the same overall bound", async () => {
    const fixture = await settledFixture();
    const boundary: FunctionalClosureBoundary = {
      ...fixture.boundary,
      git: async (args, signal) => {
        if (args[0] === "show" && args[1] === `${fixture.settleCommit}:${fixture.canary.path}`) {
          await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        }
        return await fixture.boundary.git(args, signal);
      },
    };
    await expect(assertInstalledFunctionalClosure(
      boundary,
      fixture.canary,
      fixture.settleCommit,
      new AbortController().signal,
      { timeoutMs: 500, pollMs: 1 },
    )).rejects.toThrow(
      "functional task settlement convergence timed out: phase=settlement-evidence-incomplete",
    );
  });

  test("rejects wrong S and an extra source-changing commit", async () => {
    const wrong = await settledFixture();
    await expect(assertInstalledFunctionalClosure(wrong.boundary, wrong.canary, wrong.seed, new AbortController().signal, CORRECTNESS_MS))
      .rejects.toThrow("receipted commit");

    const extra = await settledFixture();
    await writeFile(join(extra.root, extra.canary.path), `${await readFile(join(extra.root, extra.canary.path), "utf8")}\nextra\n`);
    await commit(extra.root, [extra.canary.path], "extra source change", "Owner", "owner@example.invalid");
    await expect(assertInstalledFunctionalClosure(extra.boundary, extra.canary, extra.settleCommit, new AbortController().signal, CORRECTNESS_MS))
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
    await expect(assertInstalledFunctionalClosure(fixture.boundary, fixture.canary, fixture.settleCommit, new AbortController().signal, CORRECTNESS_MS))
      .rejects.toThrow(message);
  });

  test("preserves caller cancellation without waiting for the settlement bound", async () => {
    const fixture = await fixtureBoundary();
    const canary = await prepareInstalledFunctionalClosure(fixture.boundary, CORRECTNESS_MS);
    const controller = new AbortController();
    const reason = new Error("caller cancelled functional settlement");
    setTimeout(() => controller.abort(reason), 10);
    const started = Date.now();
    let error: unknown;
    try {
      await assertInstalledFunctionalClosure(fixture.boundary, canary, "f".repeat(40), controller.signal, CORRECTNESS_MS);
    } catch (caught) { error = caught; }
    expect(error).toBe(reason);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("keeps a convergence deadline distinct when it wins a cancellation race", async () => {
    const fixture = await fixtureBoundary();
    const canary = await prepareInstalledFunctionalClosure(fixture.boundary, CORRECTNESS_MS);
    const controller = new AbortController();
    const cancellation = setTimeout(() => controller.abort(new Error("late caller cancellation")), 500);
    await expect(assertInstalledFunctionalClosure(
      fixture.boundary,
      canary,
      "f".repeat(40),
      controller.signal,
      { timeoutMs: 50, pollMs: 1 },
    )).rejects.toThrow("functional task settlement convergence timed out: phase=settlement-not-observed");
    clearTimeout(cancellation);
  });

  test("rejects non-positive and non-finite injected bounds before work", async () => {
    const fixture = await fixtureBoundary();
    await expect(prepareInstalledFunctionalClosure(fixture.boundary, { setupMs: 0 }))
      .rejects.toThrow("functional canary setup bound must be positive and finite");
    const canary = await prepareInstalledFunctionalClosure(fixture.boundary, CORRECTNESS_MS);
    await expect(assertInstalledFunctionalClosure(
      fixture.boundary,
      canary,
      "f".repeat(40),
      new AbortController().signal,
      { timeoutMs: Number.POSITIVE_INFINITY },
    )).rejects.toThrow("functional settlement bound must be positive and finite");
  });
});

type SettlementOptions = Readonly<{
  duplicateSource?: boolean;
  duplicateBullet?: boolean;
  trailer?: "missing" | "duplicate" | "mixed" | "wrong";
  extraPath?: boolean;
  settlementState?: "settled" | "delayed" | "unadopted" | "today-open";
}>;

async function unsettledFixture(): Promise<{
  root: string; boundary: FunctionalClosureBoundary; canary: FunctionalClosureCanary; settleCommit: string; seed: string;
}> {
  const fixture = await fixtureBoundary();
  const canary = await prepareInstalledFunctionalClosure(fixture.boundary, CORRECTNESS_MS);
  fixture.state.autoAdopt = false;
  return { ...fixture, canary, settleCommit: "f".repeat(40) };
}

async function settledFixture(options: SettlementOptions = {}): Promise<{
  root: string; boundary: FunctionalClosureBoundary; canary: FunctionalClosureCanary; settleCommit: string; seed: string;
}> {
  const fixture = await fixtureBoundary();
  const canary = await prepareInstalledFunctionalClosure(fixture.boundary, CORRECTNESS_MS);
  fixture.state.autoAdopt = false;
  const closed = `- [x] #task ${canary.taskText} 📅 ${canary.date} ^${canary.blockId}`;
  const source = canary.content.replace(`- [ ] #task ${canary.taskText} 📅 ${canary.date} ^${canary.blockId}`, closed) +
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
  const settlementState = options.settlementState ?? "settled";
  if (settlementState === "settled" || settlementState === "today-open") {
    await gitOk(fixture.root, ["update-ref", "refs/dome/adopted/main", settleCommit]);
  }
  if (settlementState === "settled") fixture.state.settled = true;
  if (settlementState === "delayed") {
    setTimeout(() => {
      void gitOk(fixture.root, ["update-ref", "refs/dome/adopted/main", settleCommit]).then(() => {
        fixture.state.settled = true;
      });
    }, 50);
  }
  return { ...fixture, canary, settleCommit };
}

async function fixtureBoundary(options: Readonly<{
  rollover?: boolean;
  keepSeedAdopted?: boolean;
  stallInitialTasks?: boolean;
  stallRecents?: boolean;
  stallToday?: boolean;
  adoptAfterChecks?: number;
  recentsAfterReads?: number;
  todayAfterReads?: number;
}> = {}): Promise<{
  root: string; boundary: FunctionalClosureBoundary; seed: string; state: { settled: boolean; autoAdopt: boolean };
}> {
  const root = await mkdtemp(join(tmpdir(), "dome-installed-functional-"));
  roots.push(root);
  await gitOk(root, ["init", "-b", "main"]);
  await writeFile(join(root, "seed.md"), "seed\n");
  const seed = await commit(root, ["seed.md"], "seed", "Owner", "owner@example.invalid");
  await gitOk(root, ["update-ref", "refs/dome/adopted/main", seed]);
  const state = { settled: false, autoAdopt: true };
  let taskReads = 0;
  let recentsReads = 0;
  let adoptedChecks = 0;
  const boundary: FunctionalClosureBoundary = {
    vaultPath: root,
    git: async (args, signal) => {
      let result = await runGit(root, args, signal);
      if (JSON.stringify(args) === JSON.stringify(["rev-parse", "--verify", "refs/dome/adopted/main"])) {
        adoptedChecks += 1;
        if (state.autoAdopt && !options.keepSeedAdopted && adoptedChecks > (options.adoptAfterChecks ?? 0)) {
          const head = await gitOk(root, ["rev-parse", "HEAD"]);
          await gitOk(root, ["update-ref", "refs/dome/adopted/main", head]);
          result = await runGit(root, args, signal);
        }
      }
      return result;
    },
    readHome: async (pathname, signal) => {
      signal.throwIfAborted();
      if (pathname === "/tasks") {
        taskReads += 1;
        if (options.stallInitialTasks && taskReads === 1) {
          await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        }
        if (options.stallToday && taskReads > 1) {
          await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        }
        const date = options.rollover && taskReads > 1 ? "2026-07-16" : "2026-07-15";
        if (taskReads === 1 || state.settled) return { date, openTasks: [] };
        if (taskReads - 1 <= (options.todayAfterReads ?? 0)) return { date, openTasks: [] };
        const head = await gitOk(root, ["rev-parse", "HEAD"]);
        const stableId = "dome.daily.open-loop:tinstalledfunctional";
        return {
          date,
          daily: { path: "wiki/dailies/2026-07-15.md" },
          openTasks: [{
            path: "wiki/dailies/2026-07-15.md",
            text: "Close the installed functional closure canary",
            blockId: "tinstalledfunctional",
            dueDate: "2026-07-15",
            sourceRefs: [
              { path: "wiki/dailies/2026-07-15.md", commit: head, stableId },
              { path: "notes/installed-functional-canary.md", commit: head, stableId },
            ],
          }],
          head,
        };
      }
      recentsReads += 1;
      if (options.stallRecents) {
        await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      if (recentsReads <= (options.recentsAfterReads ?? 0)) return { entries: [] };
      const head = await gitOk(root, ["rev-parse", "HEAD"]);
      return { entries: [{ path: "notes/installed-functional-canary.md", title: "Installed functional closure canary", commit: head, changedBy: "human" }] };
    },
  };
  return { root, boundary, seed, state };
}

function canaryFixture(): FunctionalClosureCanary {
  return Object.freeze({
    path: "notes/installed-functional-canary.md",
    title: "Installed functional closure canary",
    taskText: "Close the installed functional closure canary",
    blockId: "tinstalledfunctional",
    commit: "a".repeat(40),
    sourceMarker: "Dome installed functional source marker",
    date: "2026-07-15",
    content: "",
  });
}

function todayTaskFixture(canary: FunctionalClosureCanary) {
  return {
    path: `wiki/dailies/${canary.date}.md`,
    text: canary.taskText,
    blockId: canary.blockId,
    dueDate: canary.date,
    sourceRefs: [
      todayDailyRef(canary),
      todayOriginRef(canary),
    ],
  };
}

type TaskSourceRefFixture = Readonly<{
  path: string;
  commit: string;
  stableId: string;
}>;

function todayDailyRef(canary: FunctionalClosureCanary): TaskSourceRefFixture {
  return Object.freeze({
    path: `wiki/dailies/${canary.date}.md`,
    commit: canary.commit,
    stableId: `dome.daily.open-loop:${canary.blockId}`,
  });
}

function todayOriginRef(canary: FunctionalClosureCanary): TaskSourceRefFixture {
  return Object.freeze({
    path: canary.path,
    commit: canary.commit,
    stableId: `dome.daily.open-loop:${canary.blockId}`,
  });
}

function todayDocument(
  canary: FunctionalClosureCanary,
  openTasks = [todayTaskFixture(canary)],
): Record<string, unknown> {
  return {
    daily: { path: `wiki/dailies/${canary.date}.md` },
    openTasks,
  };
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
