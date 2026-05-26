// Doctor structural-check coverage. One test per check added in commit 8.
// See src/cli/commands/doctor.ts and docs/wiki/specs/cli.md §"dome doctor".

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, utimes, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { domeInit } from "../../src/cli/commands/init";
import { domeDoctor } from "../../src/cli/commands/doctor";

async function makeFreshVault(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "dome-doctor-"));
  const target = join(base, "v");
  await domeInit(target);
  return {
    path: target,
    cleanup: async () => { await rm(base, { recursive: true, force: true }); },
  };
}

describe("doctor structural checks", () => {
  test("flags short-form wikilinks (WIKILINKS_ARE_FULLPATH)", async () => {
    const v = await makeFreshVault();
    try {
      await writeFile(
        join(v.path, "wiki", "entities", "alice.md"),
        "---\ntype: entity\n---\n# Alice\n\nReferences [[bob]] in passing.",
      );
      const r = await domeDoctor(v.path);
      expect(r.ok).toBe(true);
      if (r.ok) {
        const hit = r.value.violations.find(x => x.includes("short-form wikilink") && x.includes("bob"));
        expect(hit).toBeDefined();
      }
    } finally {
      await v.cleanup();
    }
  });

  test("flags unresolved full-path wikilinks", async () => {
    const v = await makeFreshVault();
    try {
      await writeFile(
        join(v.path, "wiki", "entities", "alice.md"),
        "---\ntype: entity\n---\n# Alice\n\nLinks to [[wiki/entities/nonexistent]].",
      );
      const r = await domeDoctor(v.path);
      expect(r.ok).toBe(true);
      if (r.ok) {
        const hit = r.value.violations.find(x => x.includes("unresolved wikilink"));
        expect(hit).toBeDefined();
      }
    } finally {
      await v.cleanup();
    }
  });

  test("flags unknown wiki subdirectories", async () => {
    const v = await makeFreshVault();
    try {
      await mkdir(join(v.path, "wiki", "frogs"), { recursive: true });
      await writeFile(join(v.path, "wiki", "frogs", "kermit.md"), "# kermit");
      const r = await domeDoctor(v.path);
      expect(r.ok).toBe(true);
      if (r.ok) {
        const hit = r.value.violations.find(x => x.includes("frogs/") && x.includes("unknown wiki subdirectory"));
        expect(hit).toBeDefined();
      }
    } finally {
      await v.cleanup();
    }
  });

  test("flags raw files modified after creation (RAW_IS_IMMUTABLE heuristic)", async () => {
    const v = await makeFreshVault();
    try {
      const rawDir = join(v.path, "raw", "captures");
      await mkdir(rawDir, { recursive: true });
      const rawPath = join(rawDir, "drop.md");
      await writeFile(rawPath, "# original");
      // Force mtime well past ctime. Set atime/mtime to "now + 1 hour".
      const future = new Date(Date.now() + 3600_000);
      await utimes(rawPath, future, future);
      const r = await domeDoctor(v.path);
      expect(r.ok).toBe(true);
      if (r.ok) {
        // The heuristic depends on birthtime being available; skip the assertion
        // on platforms where birthtimeMs is unreliable (returns 0).
        const { statSync } = await import("node:fs");
        const st = statSync(rawPath);
        if (st.birthtimeMs > 0) {
          const hit = r.value.violations.find(x => x.includes("raw file modified after creation"));
          expect(hit).toBeDefined();
        }
      }
    } finally {
      await v.cleanup();
    }
  });

  test("flags non-monotonic log.md timestamps", async () => {
    const v = await makeFreshVault();
    try {
      // Append two log entries with reversed timestamps to log.md.
      const logPath = join(v.path, "log.md");
      const reversed =
        "## [2026-05-26T12:00:00.000Z] wrote | x\n\n" +
        "## [2026-05-25T12:00:00.000Z] wrote | y\n\n";
      const { readFile, writeFile: wf } = await import("node:fs/promises");
      const current = await readFile(logPath, "utf8");
      await wf(logPath, current + reversed);
      const r = await domeDoctor(v.path);
      expect(r.ok).toBe(true);
      if (r.ok) {
        const hit = r.value.violations.find(x => x.includes("non-monotonic timestamp"));
        expect(hit).toBeDefined();
      }
    } finally {
      await v.cleanup();
    }
  });

  test("reports unknown frontmatter fields as soft warnings (info, not violations) per page-schema.md", async () => {
    const v = await makeFreshVault();
    try {
      await writeFile(
        join(v.path, "wiki", "entities", "alice.md"),
        "---\ntype: entity\nbogus_field: nope\n---\n# Alice",
      );
      const r = await domeDoctor(v.path);
      expect(r.ok).toBe(true);
      if (r.ok) {
        // Soft warning lands in info; exit code stays 0 (clean).
        const infoHit = r.value.info.find(x => x.includes("unknown frontmatter field") && x.includes("bogus_field"));
        expect(infoHit).toBeDefined();
        const violationHit = r.value.violations.find(x => x.includes("bogus_field"));
        expect(violationHit).toBeUndefined();
      }
    } finally {
      await v.cleanup();
    }
  });

  test("reads extension frontmatter_extras from page-types.yaml to accept declared fields", async () => {
    const v = await makeFreshVault();
    try {
      // Declare a gotcha extension with frontmatter_extras matching page-schema.md.
      await writeFile(
        join(v.path, ".dome", "page-types.yaml"),
        `defaults: [entity, concept, source, synthesis]
extensions:
  - name: gotcha
    frontmatter_extras:
      severity: low | medium | high
      first_observed: <date>
`,
      );
      await mkdir(join(v.path, "wiki", "gotchas"), { recursive: true });
      await writeFile(
        join(v.path, "wiki", "gotchas", "test-gotcha.md"),
        "---\ntype: gotcha\nseverity: medium\nfirst_observed: 2026-05-25\n---\n# Test",
      );
      const r = await domeDoctor(v.path);
      expect(r.ok).toBe(true);
      if (r.ok) {
        const severityFlagged = r.value.info.find(x => x.includes("test-gotcha.md") && x.includes("severity"));
        expect(severityFlagged).toBeUndefined();
        const firstObservedFlagged = r.value.info.find(x => x.includes("test-gotcha.md") && x.includes("first_observed"));
        expect(firstObservedFlagged).toBeUndefined();
      }
    } finally {
      await v.cleanup();
    }
  });

  test("reports unused page-type extensions as info, not violation", async () => {
    const v = await makeFreshVault();
    try {
      // Declare an extension page-type but never use it.
      const ptPath = join(v.path, ".dome", "page-types.yaml");
      await writeFile(
        ptPath,
        "defaults: [entity, concept, source, synthesis]\nextensions:\n  - moodboard\n",
      );
      const r = await domeDoctor(v.path);
      expect(r.ok).toBe(true);
      if (r.ok) {
        const hit = r.value.info.find(x => x.includes("moodboard") && x.includes("declared but no page uses"));
        expect(hit).toBeDefined();
        // Should be info, not a violation.
        const violation = r.value.violations.find(x => x.includes("moodboard"));
        expect(violation).toBeUndefined();
      }
    } finally {
      await v.cleanup();
    }
  });

  test("reports violation when AGENTS.md is missing", async () => {
    const v = await makeFreshVault();
    try {
      await rm(join(v.path, "AGENTS.md"));
      const r = await domeDoctor(v.path);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.violations.some(s => s.toLowerCase().includes("agents.md"))).toBe(true);
      expect(r.value.exitCode).toBe(1);
    } finally {
      await v.cleanup();
    }
  });

  test("reports violation when CLAUDE.md shim is missing", async () => {
    const v = await makeFreshVault();
    try {
      await rm(join(v.path, "CLAUDE.md"));
      const r = await domeDoctor(v.path);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.violations.some(s => s.toLowerCase().includes("claude.md"))).toBe(true);
    } finally {
      await v.cleanup();
    }
  });

  test("passes when AGENTS.md and CLAUDE.md are both present and well-formed", async () => {
    const v = await makeFreshVault();
    try {
      const r = await domeDoctor(v.path);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const surfaces = r.value.violations.filter(s =>
        s.toLowerCase().includes("agents.md") || s.toLowerCase().includes("claude.md"),
      );
      expect(surfaces.length).toBe(0);
    } finally {
      await v.cleanup();
    }
  });
});
