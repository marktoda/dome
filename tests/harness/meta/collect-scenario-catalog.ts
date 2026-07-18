// Isolated metadata collector for the coverage matrix. Scenario modules still
// execute their top-level declarations, but catalog-only mode prevents those
// declarations from installing executable Bun tests in this child process.
// The child-owned watchdog also bounds an orphan if Bun exits the parent on a
// signal without running its process `exit` hooks.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  enableScenarioCatalogOnlyMode,
  getRegistry,
} from "../index";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const SCENARIO_GLOB = "tests/harness/scenarios/**/*.scenario.test.ts";
const SELF_TIMEOUT_MS = 9_000;

const watchdog = setTimeout(() => {
  process.stderr.write(`scenario catalog collector self-timeout after ${SELF_TIMEOUT_MS}ms\n`);
  process.exit(124);
}, SELF_TIMEOUT_MS);

try {
  enableScenarioCatalogOnlyMode();

  const paths: string[] = [];
  for await (const path of new Bun.Glob(SCENARIO_GLOB).scan({
    cwd: REPO_ROOT,
    onlyFiles: true,
  })) {
    paths.push(path);
  }
  paths.sort(compareStrings);

  for (const path of paths) {
    await import(pathToFileURL(resolve(REPO_ROOT, path)).href);
  }

  const catalog = getRegistry().map(({ spec }) => ({
    name: spec.name,
    tags: spec.tags,
  }));
  process.stdout.write(`${JSON.stringify(catalog)}\n`);
} finally {
  clearTimeout(watchdog);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
