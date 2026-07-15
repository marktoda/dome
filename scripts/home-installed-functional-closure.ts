import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PREPARATION_MS = 15_000;
const CONVERGENCE_MS = 60_000;
const SETTLEMENT_MS = 15_000;
const POLL_MS = 100;
const PATH = "notes/installed-functional-canary.md";
const TITLE = "Installed functional closure canary";
const TASK = "Close the installed functional closure canary";
const BLOCK_ID = "tinstalledfunctional";
const MARKER = "Dome installed functional source marker";

export type InstalledFunctionalCanary = Readonly<{
  path: string;
  title: string;
  taskText: string;
  blockId: string;
  commit: string;
  sourceMarker: string;
}>;
export type FunctionalClosureCanary = InstalledFunctionalCanary & Readonly<{ date: string; content: string }>;
export type FunctionalGitResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;
export type FunctionalClosureBoundary = Readonly<{
  vaultPath: string;
  git(args: ReadonlyArray<string>, signal: AbortSignal): Promise<FunctionalGitResult>;
  readHome(pathname: "/tasks" | "/recents", signal: AbortSignal): Promise<Record<string, unknown>>;
}>;
export type FunctionalClosurePreparationBounds = Readonly<{
  setupMs?: number;
  convergenceMs?: number;
  pollMs?: number;
}>;

export function renderInstalledFunctionalCanary(date: string): Readonly<Omit<FunctionalClosureCanary, "commit" | "date">> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("functional canary date is invalid");
  return Object.freeze({
    path: PATH,
    title: TITLE,
    taskText: TASK,
    blockId: BLOCK_ID,
    sourceMarker: MARKER,
    content: [`# ${TITLE}`, "", MARKER, "", `- [ ] ${TASK} 📅 ${date} ^${BLOCK_ID}`, ""].join("\n"),
  });
}

/** Prepare H and wait until authenticated adopted Activity and Today expose it. */
export async function prepareInstalledFunctionalClosure(
  boundary: FunctionalClosureBoundary,
  bounds: number | FunctionalClosurePreparationBounds = {},
): Promise<FunctionalClosureCanary> {
  const deadlines = preparationBounds(bounds);
  const canary = await withinDeadline(deadlines.setupMs, "functional canary preparation did not complete within its bound", async (signal) => {
    const status = await gitOk(boundary, ["status", "--porcelain"], signal);
    if (status.trim() !== "") throw new Error("functional canary requires a clean human Git boundary");
    const beforeTasks = await boundary.readHome("/tasks", signal);
    const date = typeof beforeTasks["date"] === "string" ? beforeTasks["date"] : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error("functional canary could not derive the authenticated Home-local date");
    }
    const rendered = renderInstalledFunctionalCanary(date);
    const beforeHead = (await gitOk(boundary, ["rev-parse", "HEAD"], signal)).trim();
    await mkdir(join(boundary.vaultPath, "notes"), { recursive: true });
    await writeFile(join(boundary.vaultPath, rendered.path), rendered.content, { flag: "wx" });
    await gitOk(boundary, ["add", "--", rendered.path], signal);
    await gitOk(boundary, [
      "-c", "commit.gpgsign=false", "-c", "user.name=Dome Rehearsal Owner", "-c", "user.email=owner@dome.invalid",
      "commit", "-m", "add installed functional canary", "--", rendered.path,
    ], signal);
    const pathCommits = lines(await gitOk(boundary, [
      "rev-list", "--reverse", `${beforeHead}..HEAD`, "--", rendered.path,
    ], signal));
    if (pathCommits.length !== 1) throw new Error("functional canary human commit is not unique");
    const commit = pathCommits[0]!;
    await assertHumanCanaryCommit(boundary, rendered.path, beforeHead, commit, signal);
    return Object.freeze({ ...rendered, date, commit });
  });

  const convergence: FunctionalConvergenceEvidence = {
    humanCommit: canary.commit,
    adoptedCommit: null,
    humanInAdopted: false,
    recentsPresent: false,
    todayPresent: false,
  };
  return await withinDeadline(deadlines.convergenceMs, () => convergenceTimeoutMessage(convergence), async (signal) => {
    while (true) {
      signal.throwIfAborted();
      const adopted = await adoptedCommit(boundary, signal, true);
      convergence.adoptedCommit = adopted;
      convergence.humanInAdopted = adopted !== null && await isAncestor(boundary, canary.commit, adopted, signal);
      convergence.recentsPresent = false;
      convergence.todayPresent = false;
      if (convergence.humanInAdopted && adopted !== null) {
        await requireAncestor(boundary, adopted, "HEAD", "functional adopted truth is not an ancestor of human HEAD", signal);
        const recents = await boundary.readHome("/recents", signal);
        convergence.recentsPresent = hasExactRecent(recents, canary);
        if (convergence.recentsPresent) {
          const tasks = await boundary.readHome("/tasks", signal);
          if (tasks["date"] !== canary.date) {
            throw new Error("functional canary crossed the authenticated Home-local date boundary");
          }
          convergence.todayPresent = hasExactTask(tasks, canary);
          if (convergence.todayPresent) return canary;
        }
      }
      await abortableDelay(deadlines.pollMs, signal);
    }
  });
}

type FunctionalConvergenceEvidence = {
  humanCommit: string;
  adoptedCommit: string | null;
  humanInAdopted: boolean;
  recentsPresent: boolean;
  todayPresent: boolean;
};

function preparationBounds(bounds: number | FunctionalClosurePreparationBounds): Required<FunctionalClosurePreparationBounds> {
  if (typeof bounds === "number") {
    return { setupMs: bounds, convergenceMs: bounds, pollMs: Math.min(POLL_MS, bounds) };
  }
  return {
    setupMs: bounds.setupMs ?? PREPARATION_MS,
    convergenceMs: bounds.convergenceMs ?? CONVERGENCE_MS,
    pollMs: bounds.pollMs ?? POLL_MS,
  };
}

function convergenceTimeoutMessage(evidence: FunctionalConvergenceEvidence): string {
  const phase = !evidence.humanInAdopted ? "human-not-adopted" :
    !evidence.recentsPresent ? "adopted-recents-missing" : "adopted-recents-present-today-missing";
  return [
    "functional canary convergence timed out:",
    `phase=${phase}`,
    `humanCommit=${evidence.humanCommit}`,
    `adoptedCommit=${evidence.adoptedCommit ?? "unavailable"}`,
    `humanInAdopted=${evidence.humanInAdopted}`,
    `recentsPresent=${evidence.recentsPresent}`,
    `todayPresent=${evidence.todayPresent}`,
  ].join(" ");
}

/** Bind receipted S to Git, Markdown, adopted ancestry, and public Today truth. */
export async function assertInstalledFunctionalClosure(
  boundary: FunctionalClosureBoundary,
  canary: FunctionalClosureCanary,
  settleCommit: string,
  parentSignal: AbortSignal,
  timeoutMs = SETTLEMENT_MS,
): Promise<void> {
  await withinDeadline(timeoutMs, "functional task settlement did not enter adopted Today truth", async (deadlineSignal) => {
    const signal = combinedSignal(parentSignal, deadlineSignal);
    while (true) {
      signal.throwIfAborted();
      const commits = lines(await gitOk(boundary, [
        "log", "--format=%H", `${canary.commit}..HEAD`, "--", canary.path,
      ], signal));
      if (commits.length > 1 || (commits.length === 1 && commits[0] !== settleCommit)) {
        throw new Error("functional task source was changed by more than the receipted commit");
      }
      if (commits.length === 1) {
        const adopted = await adoptedCommit(boundary, signal, true);
        if (adopted !== null) {
          const tasks = await boundary.readHome("/tasks", signal);
          if (tasks["date"] !== canary.date) {
            throw new Error("functional settlement crossed the authenticated Home-local date boundary");
          }
          if (await isAncestor(boundary, settleCommit, adopted, signal) &&
            await isAncestor(boundary, adopted, "HEAD", signal) && !hasTask(tasks, canary.blockId)) break;
        }
      }
      await abortableDelay(100, signal);
    }
    await verifySettlementEvidence(boundary, canary, settleCommit, signal);
  }, parentSignal);
}

async function assertHumanCanaryCommit(
  boundary: FunctionalClosureBoundary, path: string, parent: string, commit: string, signal: AbortSignal,
): Promise<void> {
  const identity = (await gitOk(boundary, ["show", "-s", "--format=%P%x00%an%x00%ae%x00%s%x00%B", commit], signal))
    .trim().split("\0");
  const changed = lines(await gitOk(boundary, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit], signal));
  if (identity[0] !== parent || identity[1] !== "Dome Rehearsal Owner" || identity[2] !== "owner@dome.invalid" ||
    identity[3] !== "add installed functional canary" || identity.slice(4).join("\0").includes("Dome-") ||
    JSON.stringify(changed) !== JSON.stringify([path])) {
    throw new Error("functional canary lost its exact ordinary human Git semantics");
  }
}

async function verifySettlementEvidence(
  boundary: FunctionalClosureBoundary, canary: FunctionalClosureCanary, settleCommit: string, signal: AbortSignal,
): Promise<void> {
  await requireAncestor(boundary, canary.commit, settleCommit, "functional settlement does not descend from its canary", signal);
  const sourceAtS = await gitOk(boundary, ["show", `${settleCommit}:${canary.path}`], signal);
  const sourceFinal = await readFile(join(boundary.vaultPath, canary.path), "utf8");
  const open = `- [ ] ${canary.taskText} 📅 ${canary.date} ^${canary.blockId}`;
  const closed = `- [x] ${canary.taskText} 📅 ${canary.date} ^${canary.blockId}`;
  if ([sourceAtS, sourceFinal].some((content) =>
    occurrences(content, closed) !== 1 || occurrences(content, open) !== 0 ||
    occurrences(content, `^${canary.blockId}`) !== 1 || occurrences(content, canary.sourceMarker) !== 1)) {
    throw new Error("functional task source is not durably closed exactly once");
  }
  const dailyPath = `wiki/dailies/${canary.date}.md`;
  const dailyAtS = await gitOk(boundary, ["show", `${settleCommit}:${dailyPath}`], signal);
  const dailyFinal = await readFile(join(boundary.vaultPath, dailyPath), "utf8");
  const bullet = `- ${canary.taskText} 📅 ${canary.date} ([[notes/installed-functional-canary#^${canary.blockId}|from]])`;
  if (occurrences(dailyAtS, bullet) !== 1 || occurrences(dailyFinal, bullet) !== 1) {
    throw new Error("functional task Done-today record is not durable exactly once");
  }
  const author = (await gitOk(boundary, ["show", "-s", "--format=%an%x00%ae", settleCommit], signal)).trim().split("\0");
  const subject = (await gitOk(boundary, ["show", "-s", "--format=%s", settleCommit], signal)).trim();
  const body = await gitOk(boundary, ["show", "-s", "--format=%B", settleCommit], signal);
  const requestTrailers = body.split("\n").filter((line) => line.startsWith("Dome-Request:"));
  const changed = lines(await gitOk(boundary, ["diff-tree", "--no-commit-id", "--name-only", "-r", settleCommit], signal)).sort();
  if (author[0] !== "dome settle" || author[1] !== "dome-settle@local" ||
    subject !== `settle(close): ${`${canary.taskText} 📅 ${canary.date}`.slice(0, 50)}` ||
    requestTrailers.length !== 1 || !/^Dome-Request: settle:close:[0-9a-f]{32}$/.test(requestTrailers[0] ?? "") ||
    body.includes("Dome-Run:") || JSON.stringify(changed) !== JSON.stringify([canary.path, dailyPath].sort())) {
    throw new Error("functional task settlement lost its exact human Git attribution semantics");
  }
}

async function adoptedCommit(boundary: FunctionalClosureBoundary, signal: AbortSignal, optional = false): Promise<string | null> {
  const branch = (await gitOk(boundary, ["symbolic-ref", "--short", "HEAD"], signal)).trim();
  const result = await boundary.git(["rev-parse", "--verify", `refs/dome/adopted/${branch}`], signal);
  if (result.exitCode !== 0) {
    if (optional) return null;
    throw new Error("functional adopted ref is unavailable");
  }
  return result.stdout.trim();
}

async function requireAncestor(boundary: FunctionalClosureBoundary, ancestor: string, descendant: string, message: string, signal: AbortSignal): Promise<void> {
  if (!await isAncestor(boundary, ancestor, descendant, signal)) throw new Error(message);
}
async function isAncestor(boundary: FunctionalClosureBoundary, ancestor: string, descendant: string, signal: AbortSignal): Promise<boolean> {
  return (await boundary.git(["merge-base", "--is-ancestor", ancestor, descendant], signal)).exitCode === 0;
}
async function gitOk(boundary: FunctionalClosureBoundary, args: ReadonlyArray<string>, signal: AbortSignal): Promise<string> {
  const result = await boundary.git(args, signal);
  if (result.exitCode !== 0) throw new Error(`functional Git command failed: ${args[0] ?? "unknown"}`);
  return result.stdout;
}

function hasExactRecent(doc: Record<string, unknown>, canary: FunctionalClosureCanary): boolean {
  return array(doc["entries"]).filter((value) => {
    const row = record(value);
    return row["path"] === canary.path && row["title"] === canary.title && row["commit"] === canary.commit && row["changedBy"] === "human";
  }).length === 1;
}
function hasExactTask(doc: Record<string, unknown>, canary: FunctionalClosureCanary): boolean {
  return array(doc["openTasks"]).filter((value) => {
    const row = record(value);
    return row["path"] === canary.path && row["text"] === canary.taskText && row["blockId"] === canary.blockId && row["dueDate"] === canary.date;
  }).length === 1;
}
function hasTask(doc: Record<string, unknown>, blockId: string): boolean {
  return array(doc["openTasks"]).some((value) => record(value)["blockId"] === blockId);
}
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function array(value: unknown): ReadonlyArray<unknown> { return Array.isArray(value) ? value : []; }
function lines(value: string): string[] { return value.split("\n").filter(Boolean); }
function occurrences(value: string, needle: string): number { return value.split(needle).length - 1; }

async function withinDeadline<T>(
  timeoutMs: number, timeoutMessage: string | (() => string), operation: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = (): void => controller.abort(parent?.reason);
  parent?.addEventListener("abort", onParentAbort, { once: true });
  if (parent?.aborted === true) onParentAbort();
  const message = (): string => typeof timeoutMessage === "string" ? timeoutMessage : timeoutMessage();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(message()));
  }, timeoutMs);
  try { return await operation(controller.signal); }
  catch (error) {
    if (controller.signal.aborted) {
      const timeoutAtAbort = timedOut && controller.signal.reason instanceof Error
        ? controller.signal.reason.message
        : message();
      throw new Error(timeoutAtAbort, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onParentAbort);
  }
}
function combinedSignal(first: AbortSignal, second: AbortSignal): AbortSignal {
  return AbortSignal.any([first, second]);
}
async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
