import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const ALLOWED_DIRS = [
  "src/engine/",
  "src/answers/",
  "src/proposals/",
  "src/projections/",
  "src/ledger/",
  "src/outbox/",
  // Cross-process shared/exclusive admission for gitignored operational
  // writers. This Module owns only excluded lock-protocol state.
  "src/operational-state/",
  // Deep, recovery-journaled boundary for every Dome-mediated workspace
  // write. Surfaces supply expected/desired bytes; this Module alone
  // coordinates host locking, branch CAS, and conservative materialization.
  "src/mutation/",
  // Deep portable-backup boundary: writes only private temp staging,
  // encrypted archives, and internal absent-target restore rehearsals. It
  // never edits the live vault's committed Markdown/Git tree.
  "src/backup/",
];

const ALLOWED_FILES = new Set([
  "src/engine-commit.ts",
  "src/git.ts",
  // Private crash-recovery implementation of src/git.ts's existing mutation
  // boundary. Only git.ts imports this Module; it owns exact Git lock
  // candidates and witnesses, not a second public write path.
  "src/git-owned-lock.ts",
  "src/cli/commands/init.ts",
  // Preview-first, plan-digest-consented pre-runtime vault adaptation. This
  // deep Module owns only the closed setup action inventory, exact tree
  // commits, and same-directory atomic publications; it cannot perform Home,
  // model, integration, or ordinary engine mutation. init.ts remains allowed
  // only until the next checkpoint collapses that adapter onto this seam.
  "src/setup/apply.ts",
  // Kernel-relative implementation behind setup/apply's publication seam.
  // It holds and revalidates no-follow ancestor descriptors and confines
  // temp, witness, and final-name mutations to their admitted vault parent.
  "src/setup/anchored-files.ts",
  // Host-level service scaffolding (launchd plist / systemd user unit +
  // gitignored log dir), not an engine write path — same boundary class as
  // init.ts.
  "src/cli/commands/install.ts",
  "src/platform/launchd.ts",
  // macOS-only atomic no-replace directory publication for verified blank-host
  // restores. This is a host filesystem boundary, not a vault content writer.
  "src/platform/exclusive-rename.ts",
  // Shared inode-bound private-directory staging used by Home and complete
  // product release tooling. It writes only an absent caller-selected host
  // output and owned same-filesystem temporary state, never vault content.
  "src/platform/private-directory-publication.ts",
  "src/product-host/home-lifecycle.ts",
  // Strict Home archive materialization writes and removes only one private
  // mode-0700 temp workspace after bounded read, normalized USTAR inspection,
  // and full artifact verification. It never mutates vault knowledge/state.
  "src/product-host/home-artifact-archive.ts",
  // Private SQLite-backed Product Host lifecycle ownership and suspension
  // journal. Its schema migration preserves active operational recovery truth;
  // it never writes the vault's Git or Markdown substrate.
  "src/product-host/home-lifecycle-suspension.ts",
  // Host-level immutable Home releases and the closed per-vault selector.
  // This boundary never writes vault knowledge or operational state.
  "src/product-host/home-installation.ts",
  // Deep exact-selector publication boundary used only while the durable
  // upgrade journal and lifecycle suspension own cutover. It performs a
  // no-follow expected-byte CAS-shaped replacement of installation/plist
  // documents and verifies desired bytes; it never writes Git or Markdown.
  "src/product-host/home-selection.ts",
  // Preview-first, explicit-authorization migration boundary for the one
  // supported legacy Home credential slot. Apply runs under lifecycle plus
  // managed-release ownership, replaces only generated selector documents,
  // and tombstones/removes exact contaminated operational archives; it never
  // writes Git or Markdown knowledge.
  "src/product-host/home-credential-residue.ts",
  // Durable operational rollback boundary for Home upgrades. It writes only
  // the external per-installation journal/snapshot and exact gitignored state
  // restoration targets; it never writes Git or Markdown knowledge.
  "src/product-host/home-upgrade-transaction.ts",
  // Terminal upgrade-retirement boundary. It creates the private immutable
  // history root and owns the one no-replace active -> history transaction
  // rename after lifecycle, writer-barrier, selector, and service proof. It
  // never edits vault knowledge or operational-store contents.
  "src/product-host/home-upgrade-history.ts",
  // Closed journal-guarded durable operational-store migration boundary. It
  // creates only caller-owned deterministic private preflight subdirectories
  // and migrates approved SQLite stores; it never writes Git or Markdown.
  "src/product-host/home-store-migrations.ts",
  // External private/fsynced evidence paired with the operational writer
  // coordinator during a Home upgrade transaction.
  "src/product-host/home-upgrade-barrier.ts",
  "src/cli/commands/install-systemd.ts",
  // Stable opaque Product Host identity in gitignored operational state. The
  // exclusive create is not a Markdown/Git write path.
  "src/product-host/vault-id.ts",
  // The retrieval-miss log: appends one dated bullet to
  // meta/retrieval-misses.md and lands it as one ordinary human commit via
  // commitSingleFileOnHead — exactly like `dome capture`/`dome settle`. Same
  // boundary class; the daemon constructs the Proposal from branch drift.
  "src/surface/report-miss.ts",
  // The explicit adopted-ref divergence recovery chokepoint: moves
  // refs/dome/adopted/<branch> (with a refs/dome/backup/ copy first) via the
  // src/git ref helpers after the user confirms a history rewrite. The only
  // user-facing non-fast-forward cursor move; see
  // docs/wiki/gotchas/adopted-ref-divergence.md.
  "src/cli/commands/reanchor.ts",
  // Explicit guarded repair surface. `task-anchors --apply` edits vault
  // markdown only after a dry-run-able plan; run-ledger mutations route through
  // src/ledger/. Same operator-confirmed repair boundary class as reanchor.
  "src/cli/commands/repair.ts",
  // The HTTP server's POST /transcribe handler writes the uploaded audio to a
  // mkdtemp temp directory, invokes the configured whisper command against it,
  // and deletes the dir in a finally block. This is a process-scoped temp-file
  // write (not a vault write), in the same boundary class as capture.ts.
  "src/http/server.ts",
  // The eval harness materializes a throwaway temp vault from a fixture
  // (mkdtemp → cp seed files → init repo → symlink bundle → commit) so the
  // brief golden case can run through the real engine. Not a vault write
  // path — it scaffolds a disposable fixture vault, same boundary class as
  // the harness's tmpdir scaffolding.
  "src/eval/cases/brief.ts",
  // Process-scoped operational append-only log; not a vault write — same
  // class as the server's POST /transcribe temp-write. Appends one JSON line
  // per agent-session turn to a configurable path for post-hoc diagnostics.
  "src/http/agent-log.ts",
  // The shared store-opener seam: prepareStore + openSimpleStore. The single
  // meta-row write (DELETE+INSERT in a tx) is the same operational write the
  // four store boundaries (src/{projections,ledger,outbox,answers}/, already in
  // ALLOWED_DIRS) each did inline before — hoisted to one place. Same boundary
  // class as those store dirs; not a vault write path.
  "src/sqlite/open-store.ts",
  // SQLite snapshot mechanic writes only private caller-owned staging and the
  // caller-owned destination. It copies DB/WAL bytes first, then opens that
  // private copy; it never opens or mutates the live source database.
  "src/sqlite/snapshot.ts",
]);

const FORBIDDEN_PATTERNS: ReadonlyArray<{
  readonly name: string;
  readonly pattern: RegExp;
}> = [
  { name: "Bun.write", pattern: /\bBun\.write\(/ },
  { name: "writeFile", pattern: /\.writeFile(?:Sync)?\(|\bwriteFile\(/ },
  { name: "appendFile", pattern: /\.appendFile(?:Sync)?\(|\bappendFile\(/ },
  { name: "unlink", pattern: /\.unlink(?:Sync)?\(|\bunlink\(/ },
  { name: "rename", pattern: /\.rename(?:Sync)?\(|\brename\(/ },
  { name: "mkdir", pattern: /\.mkdir(?:Sync)?\(|\bmkdir\(/ },
  {
    name: "sqlite mutation",
    pattern: /\.(?:exec|run)\(\s*['"`]\s*(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)/i,
  },
  {
    name: "git mutation",
    pattern: /\bgit\.(?:commit|add|checkout|merge|push|writeRef|writeBlob|writeTree)\(/,
  },
];

describe("no direct mutation outside engine boundaries", () => {
  test("source files outside approved mutation boundaries do not call write APIs", async () => {
    const violations: string[] = [];
    for await (const file of new Glob("src/**/*.ts").scan(".")) {
      if (isAllowedMutationBoundary(file)) continue;
      const text = await readFile(file, "utf8");
      if (text.startsWith("// @engine-internal:")) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        for (const forbidden of FORBIDDEN_PATTERNS) {
          if (forbidden.pattern.test(line)) {
            violations.push(
              `${file}:${i + 1}: ${forbidden.name}: ${line.trim()}`,
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("the private owned-lock implementation stays behind the Git boundary", async () => {
    const consumers: string[] = [];
    for await (const file of new Glob("src/**/*.ts").scan(".")) {
      const text = await readFile(file, "utf8");
      if (text.includes("git-owned-lock")) consumers.push(file);
    }

    expect(consumers.sort()).toEqual(["src/git.ts"]);
  });
});

function isAllowedMutationBoundary(file: string): boolean {
  return (
    ALLOWED_DIRS.some((dir) => file.startsWith(dir)) ||
    ALLOWED_FILES.has(file)
  );
}
