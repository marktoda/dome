import { describe, test, expect } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domeInit } from "../../src/cli/commands/init";
import { domeDoctor } from "../../src/cli/commands/doctor";
import { USER_PROSE_BEGIN, USER_PROSE_END } from "../../src/agents-md";

describe("AGENTS_MD_IS_ORIENTATION_SURFACE", () => {
  test("dome init writes AGENTS.md with templated sections + user-prose delimiters", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-amios-"));
    const target = join(base, "v");
    try {
      const r = await domeInit(target);
      expect(r.ok).toBe(true);
      const body = await readFile(join(target, "AGENTS.md"), "utf8");
      expect(body).toContain("<!-- BEGIN user-prose -->");
      expect(body).toContain("<!-- END user-prose -->");
      expect(body).toContain("EVERY_WRITE_IS_LOGGED");
      expect(body).toContain("entity");
      expect(body).toContain("ingest");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("CLAUDE.md shim at vault root points at AGENTS.md", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-amios-claude-"));
    const target = join(base, "v");
    try {
      await domeInit(target);
      const body = await readFile(join(target, "CLAUDE.md"), "utf8");
      expect(body.trim()).toBe("See AGENTS.md.");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("dome doctor --repair preserves user-prose across regeneration", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-amios-repair-"));
    const target = join(base, "v");
    try {
      await domeInit(target);
      const agentsPath = join(target, "AGENTS.md");
      const before = await readFile(agentsPath, "utf8");
      const customProse = "\n## Custom\n\nMine!\n\n";
      await writeFile(
        agentsPath,
        before.replace(
          /<!-- BEGIN user-prose -->\n\n<!-- END user-prose -->/,
          `<!-- BEGIN user-prose -->${customProse}<!-- END user-prose -->`,
        ),
      );

      const r = await domeDoctor(target, { repair: true });
      expect(r.ok).toBe(true);
      const after = await readFile(agentsPath, "utf8");
      expect(after).toContain(customProse);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("dome doctor reports violation when AGENTS.md is missing", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-amios-missing-"));
    const target = join(base, "v");
    try {
      await domeInit(target);
      await rm(join(target, "AGENTS.md"));
      const r = await domeDoctor(target, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.violations.some(v => v.toLowerCase().includes("agents.md"))).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("invariant doc names the same user-prose delimiters as the agents-md.ts runtime constants", async () => {
    const invariantDocPath = join(
      import.meta.dir,
      "..",
      "..",
      "docs",
      "wiki",
      "invariants",
      "AGENTS_MD_IS_ORIENTATION_SURFACE.md",
    );
    const docText = await readFile(invariantDocPath, "utf8");
    expect(docText).toContain(USER_PROSE_BEGIN);
    expect(docText).toContain(USER_PROSE_END);
  });

  test("delimiter gotcha doc names the same literals (canonical scar doc)", async () => {
    const gotchaPath = join(
      import.meta.dir,
      "..",
      "..",
      "docs",
      "wiki",
      "gotchas",
      "agents-md-delimiter-shape.md",
    );
    const gotchaText = await readFile(gotchaPath, "utf8");
    expect(gotchaText).toContain(USER_PROSE_BEGIN);
    expect(gotchaText).toContain(USER_PROSE_END);
  });
});
