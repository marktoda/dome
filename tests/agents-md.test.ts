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

  test("lists the enabled invariant set from config (the same projection MCP `instructions` uses)", () => {
    // SHIPPED_VAULT_CONFIG.invariants has 5 entries flagged "enabled":
    // EVERY_WRITE_IS_LOGGED, PAGE_TYPE_BY_DIRECTORY, WIKILINKS_ARE_FULLPATH,
    // INBOX_IS_EPHEMERAL, plus PAGE_CREATION_REQUIRES_RECURRENCE (disabled).
    const out = buildAgentsMdTemplated(SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES, ["ingest"]);
    expect(out).toContain("EVERY_WRITE_IS_LOGGED");
    expect(out).toContain("PAGE_TYPE_BY_DIRECTORY");
    expect(out).toContain("WIKILINKS_ARE_FULLPATH");
    expect(out).toContain("INBOX_IS_EPHEMERAL");
    // PAGE_CREATION_REQUIRES_RECURRENCE is disabled in shipped config; should NOT appear.
    expect(out).not.toContain("PAGE_CREATION_REQUIRES_RECURRENCE");
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
