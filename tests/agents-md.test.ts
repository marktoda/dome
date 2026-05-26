import { describe, test, expect } from "bun:test";
import {
  USER_PROSE_BEGIN,
  USER_PROSE_END,
  buildAgentsMdTemplated,
  mergeAgentsMd,
  buildInitialAgentsMd,
} from "../src/agents-md";
import { SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES } from "../src/shipped-defaults";

describe("buildAgentsMdTemplated", () => {
  test("includes enabled invariant names from the vault config", () => {
    const out = buildAgentsMdTemplated(SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES, ["ingest", "query", "lint"]);
    expect(out).toContain("EVERY_WRITE_IS_LOGGED");
    expect(out).toContain("PAGE_TYPE_BY_DIRECTORY");
    expect(out).toContain("WIKILINKS_ARE_FULLPATH");
    expect(out).not.toContain("SENSITIVE_GOES_TO_INBOX");
  });

  test("includes declared page-type defaults", () => {
    const out = buildAgentsMdTemplated(SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES, []);
    expect(out).toContain("entity");
    expect(out).toContain("concept");
    expect(out).toContain("source");
    expect(out).toContain("synthesis");
  });

  test("includes shipped workflow names passed in", () => {
    const out = buildAgentsMdTemplated(SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES, ["ingest", "lint", "export-context"]);
    expect(out).toContain("ingest");
    expect(out).toContain("lint");
    expect(out).toContain("export-context");
  });

  test("includes the offline-rule-surface pointer at docs/wiki/invariants/", () => {
    const out = buildAgentsMdTemplated(SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES, ["ingest"]);
    expect(out).toContain("docs/wiki/invariants/");
    expect(out.toLowerCase()).toContain("offline");
  });

  test("includes the full canonical invariant set, including axioms", () => {
    const out = buildAgentsMdTemplated(SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES, ["ingest"]);
    // Axioms (enforced structurally regardless of config) must appear.
    expect(out).toContain("RAW_IS_IMMUTABLE");
    expect(out).toContain("HOOKS_CANNOT_BYPASS_TOOLS");
    expect(out).toContain("INDEX_AND_LOG_ARE_DISPATCHER_OWNED");
    expect(out).toContain("MARKDOWN_IS_SOURCE_OF_TRUTH");
    expect(out).toContain("VAULT_IS_GIT_REPO");
    // Shipped-default invariants present in SHIPPED_VAULT_CONFIG must appear.
    expect(out).toContain("EVERY_WRITE_IS_LOGGED");
    expect(out).toContain("PAGE_TYPE_BY_DIRECTORY");
    // Newly added compiler-reframe invariants must appear.
    expect(out).toContain("AGENTS_MD_IS_ORIENTATION_SURFACE");
    expect(out).toContain("VAULT_RECONCILES_AFTER_NATIVE_WRITE");
  });
});

describe("buildInitialAgentsMd", () => {
  test("wraps templated content with user-prose delimiters at the end (empty user-prose)", () => {
    const out = buildInitialAgentsMd(SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES, ["ingest"]);
    expect(out).toContain(USER_PROSE_BEGIN);
    expect(out).toContain(USER_PROSE_END);
    const beginIdx = out.indexOf(USER_PROSE_BEGIN);
    const endIdx = out.indexOf(USER_PROSE_END);
    expect(beginIdx).toBeGreaterThan(0);
    expect(endIdx).toBeGreaterThan(beginIdx);
    const userProse = out.slice(beginIdx + USER_PROSE_BEGIN.length, endIdx);
    expect(userProse.trim()).toBe("");
  });
});

describe("mergeAgentsMd", () => {
  test("preserves the user-prose section byte-for-byte when regenerating templated content", () => {
    const existing = buildInitialAgentsMd(SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES, ["ingest"]);
    const customProse = "## My personal naming conventions\n\nProject codenames use `proj-` prefix.\n";
    const withCustomProse = existing.replace(
      `${USER_PROSE_BEGIN}\n\n${USER_PROSE_END}`,
      `${USER_PROSE_BEGIN}\n${customProse}${USER_PROSE_END}`,
    );

    const newPageTypes = { ...SHIPPED_PAGE_TYPES, defaults: [...SHIPPED_PAGE_TYPES.defaults, "person"] };
    const newTemplated = buildAgentsMdTemplated(SHIPPED_VAULT_CONFIG, newPageTypes, ["ingest", "query"]);
    const merged = mergeAgentsMd(withCustomProse, newTemplated);

    expect(merged).toContain(customProse);
    expect(merged).toContain("person");
    expect(merged).toContain("query");
  });

  test("when existing file has no delimiters, returns the templated content + an empty user-prose section", () => {
    const malformed = "# Just some prose without delimiters\n";
    const templated = buildAgentsMdTemplated(SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES, ["ingest"]);
    const merged = mergeAgentsMd(malformed, templated);

    expect(merged).toContain(USER_PROSE_BEGIN);
    expect(merged).toContain(USER_PROSE_END);
    expect(merged).toContain(templated);
  });
});
