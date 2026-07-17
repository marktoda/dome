// Canonical root-suite runner. Every current tests/**/*.test.ts file is
// classified once, then every file runs in a fresh Bun process so scheduler,
// SQLite, server, and lifecycle state cannot leak into another test file.

import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ROOT_TEST_GLOB = "tests/**/*.test.ts";

export const ROOT_TEST_AREA_ORDER = Object.freeze([
  "scripts",
  "harness",
  "product",
  "runtime",
] as const);

export type RootTestAreaName = typeof ROOT_TEST_AREA_ORDER[number];

export type RootTestAreaPlan = Readonly<{
  name: RootTestAreaName;
  files: ReadonlyArray<string>;
}>;

export type RootTestSignal = "SIGINT" | "SIGTERM";

export function rootTestSignalExitCode(signal: RootTestSignal): 130 | 143 {
  return signal === "SIGINT" ? 130 : 143;
}

export function rootTestCommand(
  path: string,
  bunExecutable: string = process.execPath,
): [string, "test", string] {
  return [bunExecutable, "test", canonicalTestPath(path)];
}

/** Discover the complete current root test inventory without crossing into nested packages. */
export async function discoverRootTestFiles(repoRoot: string = REPO_ROOT): Promise<string[]> {
  const files: string[] = [];
  const glob = new Bun.Glob(ROOT_TEST_GLOB);
  for await (const path of glob.scan({ cwd: repoRoot, onlyFiles: true })) {
    files.push(canonicalTestPath(path));
  }
  files.sort(compareStrings);
  return files;
}

/**
 * Build one total, deterministic plan. The areas organize progress only; each
 * file gets its own process when the plan is executed.
 */
export function createRootTestPlan(paths: ReadonlyArray<string>): ReadonlyArray<RootTestAreaPlan> {
  const filesByArea: Record<RootTestAreaName, string[]> = {
    scripts: [],
    harness: [],
    product: [],
    runtime: [],
  };
  const seen = new Set<string>();

  for (const rawPath of paths) {
    const path = canonicalTestPath(rawPath);
    if (seen.has(path)) throw new Error(`duplicate root test path: ${path}`);
    seen.add(path);
    filesByArea[areaFor(path)].push(path);
  }

  return Object.freeze(ROOT_TEST_AREA_ORDER.map((name) => {
    const files = Object.freeze([...filesByArea[name]].sort(compareStrings));
    return Object.freeze({
      name,
      files,
    });
  }));
}

export async function runRootTests(repoRoot: string = REPO_ROOT): Promise<number> {
  const files = await discoverRootTestFiles(repoRoot);
  if (files.length === 0) throw new Error(`no root tests matched ${ROOT_TEST_GLOB}`);
  const plan = createRootTestPlan(files);
  const nonempty = plan.filter((area) => area.files.length > 0);

  console.log(
    `root tests · ${files.length} files · ${nonempty.length} areas · one fresh process per file`,
  );
  type ActiveChild = Readonly<{
    exited: Promise<number>;
    kill: (signal?: number) => void;
  }>;
  let activeChild: ActiveChild | null = null;
  let signaledChild: ActiveChild | null = null;
  let requestedSignal: RootTestSignal | null = null;
  const forwardSignal = (signal: RootTestSignal): void => {
    requestedSignal ??= signal;
    if (activeChild === null || signaledChild === activeChild) return;
    signaledChild = activeChild;
    try { activeChild.kill(requestedSignal === "SIGINT" ? 2 : 15); } catch {}
  };
  const onSigint = (): void => forwardSignal("SIGINT");
  const onSigterm = (): void => forwardSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  let completedFiles = 0;
  try {
    for (const area of nonempty) {
      if (requestedSignal !== null) return rootTestSignalExitCode(requestedSignal);
      console.log(`\nroot tests · ${area.name} · ${area.files.length} files`);
      for (const file of area.files) {
        if (requestedSignal !== null) return rootTestSignalExitCode(requestedSignal);
        console.log(`root tests · ${completedFiles + 1}/${files.length} · ${file}`);
        const child = Bun.spawn(rootTestCommand(file), {
          cwd: repoRoot,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        activeChild = child;
        if (requestedSignal !== null) forwardSignal(requestedSignal);
        const exitCode = await child.exited;
        activeChild = null;
        signaledChild = null;
        if (requestedSignal !== null) return rootTestSignalExitCode(requestedSignal);
        if (exitCode !== 0) {
          console.error(
            `root tests · ${area.name} failed · ${file} · exit ${exitCode} · `
              + `${completedFiles}/${files.length} files completed`,
          );
          return exitCode;
        }
        completedFiles += 1;
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (activeChild !== null) {
      if (signaledChild !== activeChild) {
        try { activeChild.kill(15); } catch {}
      }
      await activeChild.exited.catch(() => {});
    }
  }

  console.log(`\nroot tests · complete · ${completedFiles}/${files.length} files`);
  return 0;
}

function areaFor(path: string): RootTestAreaName {
  if (path.startsWith("tests/scripts/")) return "scripts";
  if (path.startsWith("tests/harness/")) return "harness";
  if (path.startsWith("tests/product/")) return "product";
  return "runtime";
}

function canonicalTestPath(path: string): string {
  const canonical = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !canonical.startsWith("tests/") ||
    !canonical.endsWith(".test.ts") ||
    canonical.includes("/../") ||
    canonical.includes("/./")
  ) {
    throw new Error(`invalid root test path: ${path}`);
  }
  return canonical;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

if (import.meta.main) {
  runRootTests().then(
    (exitCode) => { process.exitCode = exitCode; },
    (error) => {
      console.error(`root tests: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
