// DeclarativeHookSchema exercises C5: parseDeclarativeHook now returns a
// Result<DeclarativeHook, ValidationError> instead of throwing string errors.
// Mirrors the Tool-surface Result<T, E> discipline and closes the first scar
// site named in gotchas/boundary-validation-via-zod.md.

import { describe, test, expect } from "bun:test";
import { parseDeclarativeHook } from "../../src/hooks/yaml-loader";

describe("DeclarativeHookSchema", () => {
  test("valid YAML parses to Result.ok(hook)", () => {
    const yaml = `event: document.written\npath_pattern: "inbox/raw/*"\nworkflow: ingest\n`;
    const r = parseDeclarativeHook(yaml);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.event).toBe("document.written");
      expect(r.value.workflow).toBe("ingest");
      expect(r.value.path_pattern).toBe("inbox/raw/*");
    }
  });

  test("invalid YAML (wrong type) returns Result.err(ValidationError)", () => {
    const yaml = `event: 42\nworkflow: ingest\n`; // event is wrong type
    const r = parseDeclarativeHook(yaml);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("validation");
    }
  });

  test("missing required fields returns Result.err", () => {
    const yaml = `path_pattern: "inbox/raw/*"\n`; // no event, no workflow
    const r = parseDeclarativeHook(yaml);
    expect(r.ok).toBe(false);
  });

  test("unknown workflow name returns Result.err", () => {
    const yaml = `event: document.written\nworkflow: not-a-real-workflow\n`;
    const r = parseDeclarativeHook(yaml);
    expect(r.ok).toBe(false);
  });

  test("malformed YAML text returns Result.err", () => {
    // Yaml that parses to a non-object scalar — the schema rejects.
    const yaml = `42`;
    const r = parseDeclarativeHook(yaml);
    expect(r.ok).toBe(false);
  });
});
