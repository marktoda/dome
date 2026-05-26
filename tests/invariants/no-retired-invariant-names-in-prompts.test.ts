import { describe, test, expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const RETIRED_INVARIANTS = ["SENSITIVE_GOES_TO_INBOX"];
const PROMPTS_DIR = "src/prompts/builtin";

describe("no retired invariant names in shipped builtin prompts", () => {
  test("scans src/prompts/builtin/*.md for retired-invariant-name residue", async () => {
    const entries = await readdir(PROMPTS_DIR, { withFileTypes: true });
    const mdFiles = entries.filter(e => e.isFile() && e.name.endsWith(".md"));
    const hits: Array<{ file: string; line: number; name: string; text: string }> = [];
    for (const f of mdFiles) {
      const body = await readFile(join(PROMPTS_DIR, f.name), "utf8");
      const lines = body.split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const name of RETIRED_INVARIANTS) {
          if (lines[i]!.includes(name)) {
            hits.push({ file: f.name, line: i + 1, name, text: lines[i]! });
          }
        }
      }
    }
    if (hits.length > 0) {
      const detail = hits.map(h => `  ${h.file}:${h.line}: ${h.text.trim()} (matches retired: ${h.name})`).join("\n");
      throw new Error(`Retired invariant names found in shipped builtin prompts:\n${detail}`);
    }
    expect(hits.length).toBe(0);
  });
});
