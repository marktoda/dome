// Canonical root-suite runner. Every current tests/**/*.test.ts file is
// classified once, then each ordered partition runs in a fresh Bun process so
// one long-lived test VM cannot leak scheduler or SQLite pressure into later
// product areas.

import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ROOT_TEST_GLOB = "tests/**/*.test.ts";

export const ROOT_TEST_PARTITION_ORDER = Object.freeze([
  "scripts",
  "harness",
  "product",
  "runtime",
] as const);

export type RootTestPartitionName = typeof ROOT_TEST_PARTITION_ORDER[number];

export type RootTestPartitionPlan = Readonly<{
  name: RootTestPartitionName;
  files: ReadonlyArray<string>;
  bunArgs: ReadonlyArray<string>;
}>;

export type RootTestSignal = "SIGINT" | "SIGTERM";

export function rootTestSignalExitCode(signal: RootTestSignal): 130 | 143 {
  return signal === "SIGINT" ? 130 : 143;
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
 * Build one total, deterministic plan. Scripts, harness, and product tests get
 * isolated processes; every other root test falls into runtime by construction.
 */
export function createRootTestPlan(paths: ReadonlyArray<string>): ReadonlyArray<RootTestPartitionPlan> {
  const filesByPartition: Record<RootTestPartitionName, string[]> = {
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
    filesByPartition[partitionFor(path)].push(path);
  }

  return Object.freeze(ROOT_TEST_PARTITION_ORDER.map((name) => {
    const files = Object.freeze([...filesByPartition[name]].sort(compareStrings));
    return Object.freeze({
      name,
      files,
      bunArgs: Object.freeze(["test", ...files]),
    });
  }));
}

export async function runRootTests(repoRoot: string = REPO_ROOT): Promise<number> {
  const files = await discoverRootTestFiles(repoRoot);
  if (files.length === 0) throw new Error(`no root tests matched ${ROOT_TEST_GLOB}`);
  const plan = createRootTestPlan(files);
  const nonempty = plan.filter((partition) => partition.files.length > 0);

  console.log(
    `root tests · ${files.length} files · ${nonempty.length} fresh-process partitions`,
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
    for (const partition of nonempty) {
      if (requestedSignal !== null) return rootTestSignalExitCode(requestedSignal);
      console.log(`\nroot tests · ${partition.name} · ${partition.files.length} files`);
      const child = Bun.spawn([process.execPath, ...partition.bunArgs], {
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
          `root tests · ${partition.name} failed · exit ${exitCode} · `
            + `${completedFiles}/${files.length} files completed before this partition`,
        );
        return exitCode;
      }
      completedFiles += partition.files.length;
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

function partitionFor(path: string): RootTestPartitionName {
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
