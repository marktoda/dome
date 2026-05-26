// Pins the @dome/sdk/cli shell shape: every dome* command implementation
// in src/cli/commands/ is re-exported from src/cli/index.ts. Closes the
// class of "add CLI command, forget the index.ts export" regression.

import { describe, test, expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const COMMANDS_DIR = join(REPO_ROOT, "src", "cli", "commands");
const INDEX_PATH = join(REPO_ROOT, "src", "cli", "index.ts");

describe("@dome/sdk/cli shell shape", async () => {
  const files = await readdir(COMMANDS_DIR);
  const commandFiles = files.filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const indexText = await readFile(INDEX_PATH, "utf8");

  for (const file of commandFiles) {
    const slug = file.replace(/\.ts$/, "");
    // file slug "stats" → expected export "domeStats" (camelCase, dome-prefixed)
    const parts = slug.split(/[-_]/);
    const expectedExport = "dome" + parts.map(p => p[0]!.toUpperCase() + p.slice(1)).join("");

    test(`commands/${file} → ${expectedExport} re-exported from src/cli/index.ts`, () => {
      const re = new RegExp(`export\\s*\\{[^}]*\\b${expectedExport}\\b[^}]*\\}\\s*from\\s*["']\\./commands/${slug}["']`);
      expect(re.test(indexText),
        `src/cli/index.ts must re-export ${expectedExport} from ./commands/${slug}`).toBe(true);
    });
  }
});
