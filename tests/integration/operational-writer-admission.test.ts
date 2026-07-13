import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const INVENTORY: ReadonlyArray<{
  readonly opener: string;
  readonly calls: Readonly<Record<string, number>>;
}> = [
  { opener: "openAnswersDb", calls: { "src/answers/db.ts": 1, "src/engine/host/vault-runtime.ts": 1 } },
  { opener: "openProposalsDb", calls: { "src/proposals/db.ts": 1, "src/engine/host/vault-runtime.ts": 1, "src/surface/proposals.ts": 3 } },
  { opener: "openOutboxDb", calls: { "src/outbox/db.ts": 1, "src/engine/host/vault-runtime.ts": 1 } },
  { opener: "openLedgerDb", calls: { "src/ledger/db.ts": 1, "src/engine/host/vault-runtime.ts": 1, "src/surface/activity.ts": 1, "src/cli/commands/inspect.ts": 1, "src/cli/commands/repair.ts": 1 } },
  { opener: "openRequestReceiptsDb", calls: { "src/request-receipts/db.ts": 1, "src/product-host/product-host.ts": 1 } },
  { opener: "openDeviceAuthority", calls: { "src/device-authority/device-authority.ts": 1, "src/product-host/product-host.ts": 1, "src/cli/commands/devices.ts": 1, "src/backup/vault-backup.ts": 2 } },
  { opener: "openQuarantineStore", calls: { "src/engine/operational/quarantine-store.ts": 1, "src/engine/host/vault-runtime.ts": 1 } },
  { opener: "ensureVaultId", calls: { "src/product-host/vault-id.ts": 1, "src/product-host/product-host.ts": 1 } },
];

const PROTECTED_CHOKEPOINTS: Readonly<Record<string, number>> = {
  "src/engine/host/vault-runtime.ts": 1,
  "src/product-host/home-lifecycle-suspension.ts": 3,
  "src/product-host/home-lifecycle.ts": 1,
  "src/surface/proposals.ts": 3,
  "src/surface/activity.ts": 1,
  "src/cli/commands/inspect.ts": 1,
  "src/cli/commands/repair.ts": 1,
  "src/cli/commands/devices.ts": 1,
  "src/backup/vault-backup.ts": 1,
};

describe("operational writer admission inventory", () => {
  test("every mutable operational opener remains at a reviewed seam", async () => {
    const source = new Map<string, string>();
    for await (const file of new Glob("src/**/*.ts").scan(".")) {
      source.set(file, stripTypeScriptComments(await readFile(file, "utf8")));
    }
    for (const item of INVENTORY) {
      const pattern = new RegExp(`\\b${item.opener}\\s*\\(`, "g");
      const actual = Object.fromEntries([...source]
        .map(([file, text]) => [file, [...text.matchAll(pattern)].length] as const)
        .filter(([, count]) => count > 0));
      expect(actual, `${item.opener} callsite inventory changed`).toEqual(item.calls);
    }
  });

  test("each production chokepoint acquires the shared lifetime lease", async () => {
    for (const [file, count] of Object.entries(PROTECTED_CHOKEPOINTS)) {
      const text = stripTypeScriptComments(await readFile(file, "utf8"));
      expect(
        [...text.matchAll(/\bacquireOperationalWriterLease\s*\(/g)].length,
        `${file} operational writer admission count changed`,
      ).toBe(count);
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
