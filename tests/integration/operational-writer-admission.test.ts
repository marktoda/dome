import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const INVENTORY: ReadonlyArray<{
  readonly opener: string;
  readonly files: ReadonlyArray<string>;
}> = [
  { opener: "openAnswersDb", files: ["src/answers/db.ts", "src/engine/host/vault-runtime.ts"] },
  { opener: "openProposalsDb", files: ["src/proposals/db.ts", "src/engine/host/vault-runtime.ts", "src/surface/proposals.ts"] },
  { opener: "openOutboxDb", files: ["src/outbox/db.ts", "src/engine/host/vault-runtime.ts"] },
  { opener: "openLedgerDb", files: ["src/ledger/db.ts", "src/engine/host/vault-runtime.ts", "src/surface/activity.ts", "src/cli/commands/inspect.ts", "src/cli/commands/repair.ts"] },
  { opener: "openRequestReceiptsDb", files: ["src/request-receipts/db.ts", "src/product-host/product-host.ts"] },
  { opener: "openDeviceAuthority", files: ["src/device-authority/device-authority.ts", "src/product-host/product-host.ts", "src/cli/commands/devices.ts", "src/backup/vault-backup.ts"] },
  { opener: "openQuarantineStore", files: ["src/engine/operational/quarantine-store.ts", "src/engine/host/vault-runtime.ts"] },
  { opener: "ensureVaultId", files: ["src/product-host/vault-id.ts", "src/product-host/product-host.ts"] },
];

const PROTECTED_CHOKEPOINTS = [
  "src/engine/host/vault-runtime.ts",
  "src/product-host/product-host.ts",
  "src/surface/proposals.ts",
  "src/surface/activity.ts",
  "src/cli/commands/inspect.ts",
  "src/cli/commands/repair.ts",
  "src/cli/commands/devices.ts",
  "src/backup/vault-backup.ts",
] as const;

describe("operational writer admission inventory", () => {
  test("every mutable operational opener remains at a reviewed seam", async () => {
    const source = new Map<string, string>();
    for await (const file of new Glob("src/**/*.ts").scan(".")) {
      source.set(file, stripTypeScriptComments(await readFile(file, "utf8")));
    }
    for (const item of INVENTORY) {
      const pattern = new RegExp(`\\b${item.opener}\\s*\\(`);
      const actual = [...source]
        .filter(([, text]) => pattern.test(text))
        .map(([file]) => file)
        .sort();
      expect(actual, `${item.opener} callsite inventory changed`).toEqual([...item.files].sort());
    }
  });

  test("each production chokepoint acquires the shared lifetime lease", async () => {
    for (const file of PROTECTED_CHOKEPOINTS) {
      const text = await readFile(file, "utf8");
      expect(text, `${file} bypasses operational writer admission`).toContain(
        "acquireOperationalWriterLease",
      );
    }
  });

  test("the coordinator is rollback-journal, never shared WAL configuration", async () => {
    const text = await readFile("src/operational-state/writer-barrier.ts", "utf8");
    expect(text).toContain("journal_mode = DELETE");
    expect(text).toContain("locking_mode = NORMAL");
    expect(text).toContain("synchronous = FULL");
    expect(text).not.toContain("configureSqliteConnection");
  });
});

/**
 * Remove comments without treating comment-looking bytes inside string or
 * template literals as comments. This fence inventories executable opener
 * callsites, not examples in API documentation.
 */
function stripTypeScriptComments(source: string): string {
  let output = "";
  let index = 0;
  let quote: "\"" | "'" | "`" | null = null;
  while (index < source.length) {
    const current = source[index]!;
    const next = source[index + 1];
    if (quote !== null) {
      output += current;
      if (current === "\\") {
        if (next !== undefined) output += next;
        index += 2;
        continue;
      }
      if (current === quote) quote = null;
      index += 1;
      continue;
    }
    if (current === "\"" || current === "'" || current === "`") {
      quote = current;
      output += current;
      index += 1;
      continue;
    }
    if (current === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        output += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      index += 2;
      continue;
    }
    output += current;
    index += 1;
  }
  return output;
}
