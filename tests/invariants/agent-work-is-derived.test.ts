import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

describe("AGENT_WORK_IS_DERIVED", () => {
  test("agent work compiles question inputs and no store declares an agent-work table", () => {
    const compiler = readFileSync(
      join(ROOT, "src", "agent-work", "agent-work.ts"),
      "utf8",
    );
    expect(compiler).toContain("questions: ReadonlyArray<AgentWorkQuestionInput>");
    expect(compiler).not.toContain("bun:sqlite");
    expect(compiler).not.toContain("CREATE TABLE");

    const stores = [
      "src/answers/db.ts",
      "src/projections/db.ts",
      "src/ledger/db.ts",
      "src/outbox/db.ts",
      "src/proposals/db.ts",
    ].map((path) => readFileSync(join(ROOT, path), "utf8")).join("\n");
    expect(stores).not.toMatch(/CREATE TABLE[^\n]*(agent_work|agent_jobs)/i);
  });
});
