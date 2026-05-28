// tests/harness/harness.ts — the Harness runtime class.
//
// One `HarnessImpl` per scenario. Construction owns the tmpdir vault fixture
// (real git repo, real .dome/state DBs, real engine), the optional shipped
// bundles, and the open VaultRuntime. Move methods carry out the work,
// update internal snapshots, and call `runAllAlwaysTrue(this, moveDesc)`
// before returning. Cleanup closes the runtime and removes the tmpdir.
//
// Architectural notes:
//   - No mocks at the boundary. Every read goes through the same code paths
//     a real vault uses: `currentSha` / `readBlob` / `getAdoptedRef` /
//     `queryRuns` / etc.
//   - `tick()` reuses `detectDrift` + `runOneAdoption` from the CLI shared
//     module so a scenario's tick is byte-for-byte identical to one `dome
//     sync` invocation against the same vault.
//   - `install()` symlinks the shipped bundle directory into
//     `.dome/extensions/<id>/` and reopens the runtime so the new
//     processor registry is picked up. We symlink (not copy) so the
//     processor module's relative imports continue to resolve against
//     the SDK's source tree post-canonicalization.
//   - The clock is owned by the harness but NOT yet wired into the daemon
//     (Phase H1 limitation; schedule triggers don't exist in the system).
//     The always-true invariants do consume it for orphan thresholds.

import fs from "node:fs";
import {
  mkdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import git from "isomorphic-git";

import { adoptedRefName, getAdoptedRef } from "../../src/adopted-ref";
import { runCli as runCliDispatch } from "../../src/cli/index";
import { commitOid, type CommitOid } from "../../src/core/source-ref";
import {
  detectDrift,
  resolveShippedBundlesRoot,
  runOneAdoption,
} from "../../src/cli/commands/sync-shared";
import {
  commit as gitCommit,
  currentSha,
  findGitRoot,
  initRepo,
  isAncestor as gitIsAncestor,
  log as gitLog,
} from "../../src/git";
import {
  openVaultRuntime,
  type VaultRuntime,
} from "../../src/engine/vault-runtime";

import { CommitMatcherImpl, _parseTrailers } from "./assertions/commits";
import { FileMatcherImpl } from "./assertions/files";
import { LedgerMatcherImpl } from "./assertions/ledger";
import { OutboxMatcherImpl } from "./assertions/outbox";
import { ProjectionMatcherImpl } from "./assertions/projection";
import { RefMatcherImpl } from "./assertions/refs";
import { runAllAlwaysTrue } from "./assertions/always-true";
import { TestClock } from "./test-clock";
import type {
  BundleSpec,
  CommitMatcher,
  FileMatcher,
  GitView,
  Harness,
  HarnessOpts,
  LedgerFilter,
  LedgerMatcher,
  OutboxMatcher,
  ProjectionMatcher,
  RefMatcher,
  RefsView,
  TickResult,
  UserCommitInput,
  UserEditInput,
} from "./types";
import type { LedgerDb } from "../../src/ledger/db";
import type { OutboxDb } from "../../src/outbox/db";
import type { ProjectionDb } from "../../src/projections/db";

const DEFAULT_BRANCH = "main";
const DEFAULT_AUTHOR = {
  name: "dome-test",
  email: "test@local",
} as const;

// ----- Public class --------------------------------------------------------

export class HarnessImpl implements Harness {
  readonly vaultPath: string;
  readonly branch: string;
  readonly clock: TestClock;

  private runtime: VaultRuntime;
  private readonly installedBundles: Set<string>;
  private snapshotRefs: { head: string | null; adopted: string | null };
  readonly refs: RefsView;
  readonly git: GitView;

  private constructor(args: {
    vaultPath: string;
    branch: string;
    clock: TestClock;
    runtime: VaultRuntime;
    installedBundles: Set<string>;
  }) {
    this.vaultPath = args.vaultPath;
    this.branch = args.branch;
    this.clock = args.clock;
    this.runtime = args.runtime;
    this.installedBundles = args.installedBundles;
    this.snapshotRefs = { head: null, adopted: null };
    this.refs = makeRefsView(this);
    this.git = makeGitView(this);
  }

  // ----- Construction / cleanup --------------------------------------------

  static async create(opts: HarnessOpts = {}): Promise<HarnessImpl> {
    const vaultPath = mkdtempSync(join(tmpdir(), "dome-harness-"));
    const branch = opts.branch ?? DEFAULT_BRANCH;
    // H1 only accepts a `TestClock` instance for `opts.clock`. The
    // `TestClockHandle` interface allows other implementations, but
    // none exist yet — schedule triggers (and their alternate clocks)
    // are a later-phase concern.
    if (opts.clock !== undefined && !(opts.clock instanceof TestClock)) {
      throw new Error(
        "harness: opts.clock must be an instance of TestClock in v1.0 (foreign TestClockHandles not yet supported)",
      );
    }
    const clock = opts.clock ?? new TestClock();

    await initRepo(vaultPath, branch);

    // Write initialFiles + the initial commit. The initial commit is
    // structurally important — most scenarios assume HEAD exists, and
    // `dome sync` short-circuits to `no-commits` otherwise.
    if (opts.initialFiles !== undefined) {
      for (const [p, content] of Object.entries(opts.initialFiles)) {
        if (content === null) continue;
        await mkdir(dirname(join(vaultPath, p)), { recursive: true });
        await writeFile(join(vaultPath, p), content, "utf8");
      }
    }

    const makeInitial = opts.initialCommit !== false;
    if (makeInitial) {
      // Always seed at least one commit. Even when initialFiles is
      // empty, we drop a `.dome/.gitkeep` file so the repo has a HEAD
      // and the adopted-ref substrate can operate.
      const filesArg: string[] =
        opts.initialFiles !== undefined
          ? Object.keys(opts.initialFiles)
          : [];
      if (filesArg.length === 0) {
        await mkdir(join(vaultPath, ".dome"), { recursive: true });
        await writeFile(join(vaultPath, ".dome", ".gitkeep"), "", "utf8");
        filesArg.push(".dome/.gitkeep");
      }
      await gitCommit({
        path: vaultPath,
        message: "harness: initial commit",
        files: filesArg,
        author: { name: DEFAULT_AUTHOR.name, email: DEFAULT_AUTHOR.email },
      });
    }

    // Set up bundles. The shipped-bundle directory is the SDK's
    // `assets/extensions/` for plain-string bundle ids; fixture-bundle
    // specs (`{ id, root }`) resolve to their declared root. Each
    // bundle is *symlinked* into the vault's `.dome/extensions/<id>/`.
    // We symlink (not copy) so the processor module's relative imports
    // (`../../../../src/core/effect`) continue to resolve against the
    // source location after Bun canonicalizes the file URL during
    // dynamic-import — this matters for fixture bundles that may live
    // under `tests/harness/fixtures/bundles/...`, whose relative imports
    // need to land in the SDK's `src/` tree.
    const installedBundles = new Set<string>();
    await mkdir(join(vaultPath, ".dome", "extensions"), { recursive: true });
    for (const spec of opts.bundles ?? []) {
      const { id, src } = resolveBundleSource(spec);
      const dst = join(vaultPath, ".dome", "extensions", id);
      await symlink(src, dst, "dir");
      installedBundles.add(id);
    }

    // Open the runtime against the (possibly-empty) bundles root.
    const runtime = await openRuntime(vaultPath);

    const harness = new HarnessImpl({
      vaultPath,
      branch,
      clock,
      runtime,
      installedBundles,
    });
    await harness.snapshot();
    return harness;
  }

  async cleanup(): Promise<void> {
    try {
      await this.runtime.close();
    } catch {
      // Best-effort close — a double-close from a prior cleanup-on-throw
      // is non-fatal.
    }
    try {
      await rm(this.vaultPath, { recursive: true, force: true });
    } catch {
      // Best-effort rm. Tmpdir-scoped paths are auto-cleaned by the OS.
    }
  }

  // ----- User moves --------------------------------------------------------

  async userCommit(input: UserCommitInput): Promise<CommitOid> {
    await this.snapshot();
    for (const [p, content] of Object.entries(input.files)) {
      const full = join(this.vaultPath, p);
      if (content === null) {
        try {
          await unlink(full);
        } catch {
          // Treat missing-file deletes as no-ops; the index/commit will
          // pick up whatever's there.
        }
        continue;
      }
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
    }
    const author = input.author ?? DEFAULT_AUTHOR;
    const sha = await gitCommit({
      path: this.vaultPath,
      message: input.message,
      files: Object.keys(input.files),
      author: { name: author.name, email: author.email },
    });
    await runAllAlwaysTrue(this, `userCommit("${input.message}")`);
    return commitOid(sha);
  }

  async userEdit(input: UserEditInput): Promise<void> {
    await this.snapshot();
    for (const [p, content] of Object.entries(input.files)) {
      const full = join(this.vaultPath, p);
      if (content === null) {
        try {
          await unlink(full);
        } catch {
          // No-op
        }
        continue;
      }
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
    }
    await runAllAlwaysTrue(this, `userEdit(${Object.keys(input.files).length} file(s))`);
  }

  async userDelete(paths: ReadonlyArray<string>): Promise<void> {
    await this.snapshot();
    for (const p of paths) {
      try {
        await unlink(join(this.vaultPath, p));
      } catch {
        // Best-effort delete; missing path is a no-op.
      }
    }
    await runAllAlwaysTrue(this, `userDelete([${paths.join(", ")}])`);
  }

  async userCheckout(ref: string): Promise<void> {
    await this.snapshot();
    await git.checkout({ fs, dir: this.vaultPath, ref });
    await runAllAlwaysTrue(this, `userCheckout(${ref})`);
  }

  // ----- Daemon / engine moves --------------------------------------------

  async tick(): Promise<TickResult> {
    await this.snapshot();
    const drift = await detectDrift(this.vaultPath);
    if (drift.kind === "detached-head" || drift.kind === "no-commits") {
      throw new Error(`harness.tick: unworkable state '${drift.kind}'`);
    }
    if (drift.kind === "in-sync") {
      await runAllAlwaysTrue(this, "tick (in-sync no-op)");
      return {
        hadDrift: false,
        diagnosticCount: 0,
        iterations: 0,
        adopted: true,
        closureCommitOid: null,
      };
    }
    // drift.kind === "drift"
    const adoptedBefore = drift.info.base;
    const adoptedTargetBefore = drift.info.head;
    // Phase 4c: thread the TestClock through to the scheduler so
    // schedule triggers fire deterministically against simulated time.
    // CLI callers default to `() => new Date()` (real time); harness
    // scenarios advance time via `h.clock.advance(ms)` and the scheduler
    // sees the advanced value.
    const result = await runOneAdoption({
      runtime: this.runtime,
      drift: drift.info,
      now: () => this.clock.now(),
    });
    await runAllAlwaysTrue(
      this,
      `tick (${adoptedBefore.slice(0, 7)}..${adoptedTargetBefore.slice(0, 7)})`,
    );
    return {
      hadDrift: true,
      adoptedBefore,
      adoptedAfter: result.adoptedRef,
      diagnosticCount: result.diagnostics.length,
      iterations: result.iterations,
      adopted: result.adopted,
      closureCommitOid: result.closureCommitOid,
    };
  }

  async advance(ms: number): Promise<void> {
    await this.snapshot();
    this.clock.advance(ms);
    await runAllAlwaysTrue(this, `advance(${ms}ms)`);
  }

  async forceSync(): Promise<TickResult> {
    // H1: `--force-advance` is surfaced by `dome sync` but the underlying
    // `runOneAdoption` doesn't take a flag in v1.0 — the force-advance
    // toggle lives in `setAdoptedRef` and is engaged on the CLI side.
    // For H1, force-sync is the same as `tick()`; the explicit method
    // exists so scenarios can document the intent and future phases
    // wire the flag through.
    return this.tick();
  }

  async crashAndRestart(): Promise<void> {
    await this.snapshot();
    await this.runtime.close();
    this.runtime = await openRuntime(this.vaultPath);
    await runAllAlwaysTrue(this, "crashAndRestart");
  }

  async reopenRuntime(): Promise<void> {
    await this.snapshot();
    await this.runtime.close();
    this.runtime = await openRuntime(this.vaultPath);
    await runAllAlwaysTrue(this, "reopenRuntime");
  }

  // ----- Bundle moves ------------------------------------------------------

  async install(bundles: ReadonlyArray<BundleSpec>): Promise<void> {
    await this.snapshot();
    const newlyInstalled: string[] = [];
    for (const spec of bundles) {
      const { id, src } = resolveBundleSource(spec);
      if (this.installedBundles.has(id)) continue;
      const dst = join(this.vaultPath, ".dome", "extensions", id);
      await symlink(src, dst, "dir");
      this.installedBundles.add(id);
      newlyInstalled.push(id);
    }
    if (newlyInstalled.length > 0) {
      await this.runtime.close();
      this.runtime = await openRuntime(this.vaultPath);
    }
    await runAllAlwaysTrue(this, `install([${newlyInstalled.join(", ")}])`);
  }

  async uninstall(bundleId: string): Promise<void> {
    await this.snapshot();
    if (this.installedBundles.has(bundleId)) {
      const dst = join(this.vaultPath, ".dome", "extensions", bundleId);
      // The install path symlinks; unlink removes the symlink without
      // recursing into the SDK's source directory.
      try {
        await unlink(dst);
      } catch {
        // Already gone or never linked — non-fatal.
      }
      this.installedBundles.delete(bundleId);
      await this.runtime.close();
      this.runtime = await openRuntime(this.vaultPath);
    }
    await runAllAlwaysTrue(this, `uninstall(${bundleId})`);
  }

  // ----- DB handles --------------------------------------------------------

  get ledger(): LedgerDb {
    return this.runtime.ledgerDb;
  }

  get projection(): ProjectionDb {
    return this.runtime.projectionDb;
  }

  get outbox(): OutboxDb {
    return this.runtime.outboxDb;
  }

  // ----- Snapshot ----------------------------------------------------------

  async snapshot(): Promise<void> {
    let head: string | null;
    try {
      head = await currentSha(this.vaultPath);
    } catch {
      head = null;
    }
    const adopted = await getAdoptedRef(this.vaultPath, this.branch);
    this.snapshotRefs = { head, adopted };
  }

  // ----- Matcher factories -------------------------------------------------

  expectRef(name: string): RefMatcher {
    const snapshotVal =
      name === `refs/heads/${this.branch}`
        ? this.snapshotRefs.head
        : name === adoptedRefName(this.branch)
          ? this.snapshotRefs.adopted
          : null;
    return new RefMatcherImpl(this, name, snapshotVal);
  }

  expectFile(path: string, opts?: { atCommit?: string }): FileMatcher {
    return new FileMatcherImpl(this, path, opts?.atCommit ?? null);
  }

  expectLedger(filter?: LedgerFilter): LedgerMatcher {
    return new LedgerMatcherImpl(this, filter ?? {});
  }

  expectProjection(): ProjectionMatcher {
    return new ProjectionMatcherImpl(this);
  }

  expectOutbox(): OutboxMatcher {
    return new OutboxMatcherImpl(this);
  }

  expectCommit(commitRef: string): CommitMatcher {
    return new CommitMatcherImpl(this, commitRef);
  }

  // ----- CLI invocation ---------------------------------------------------

  async runCli(args: ReadonlyArray<string>): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }> {
    await this.snapshot();
    // Close the harness's runtime before invoking the CLI command — the
    // command opens its own VaultRuntime against the same SQLite files,
    // and two open handles racing on the same DB file is the kind of
    // subtle corruption we'd rather not debug. SQLite's
    // `sqlite3_close_v2` is idempotent so a double-close on cleanup is
    // safe.
    await this.runtime.close();

    // Capture console output. `runCli` writes via `console.log` /
    // `console.error`; the overrides collect each call into arrays and
    // join with newlines at the end. Bun's console is synchronous, so
    // there's no race between the command writing and our test
    // restoring the original handlers.
    const captured = { out: [] as string[], err: [] as string[] };
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...parts: unknown[]) =>
      captured.out.push(parts.map((p) => stringifyForCapture(p)).join(" "));
    console.error = (...parts: unknown[]) =>
      captured.err.push(parts.map((p) => stringifyForCapture(p)).join(" "));

    let exitCode: number;
    try {
      // Append `--vault <path>` + `--bundles-root <vault>/.dome/extensions`
      // so the CLI command targets this harness's vault. The
      // bundles-root override matches how `tick()` / `install()` wire
      // the symlinked bundles into the runtime — without it the CLI
      // would load the SDK's shipped bundles which differ from the
      // scenario's installed set.
      const fullArgs: string[] = [
        ...args,
        "--vault",
        this.vaultPath,
        "--bundles-root",
        join(this.vaultPath, ".dome", "extensions"),
      ];
      exitCode = await runCliDispatch(fullArgs);
    } finally {
      console.log = origLog;
      console.error = origErr;
      // Reopen the harness's runtime so subsequent matchers see the
      // post-command state. The command may have written rows to the
      // projection / ledger; reopening picks up the new SQLite state.
      this.runtime = await openRuntime(this.vaultPath);
    }

    await runAllAlwaysTrue(this, `runCli([${args.join(" ")}])`);

    return {
      exitCode,
      stdout: captured.out.join("\n"),
      stderr: captured.err.join("\n"),
    };
  }

  // ----- Always-true runner -----------------------------------------------

  async assertAlwaysTrue(): Promise<void> {
    await runAllAlwaysTrue(this, "assertAlwaysTrue (explicit)");
  }
}

// ----- Helpers -------------------------------------------------------------

async function openRuntime(vaultPath: string): Promise<VaultRuntime> {
  const bundlesRoot = join(vaultPath, ".dome", "extensions");
  const result = await openVaultRuntime({ vaultPath, bundlesRoot });
  if (!result.ok) {
    throw new Error(
      `harness: openVaultRuntime failed: ${JSON.stringify(result.error)}`,
    );
  }
  return result.value;
}


// ----- Read surfaces -------------------------------------------------------

function makeRefsView(h: HarnessImpl): RefsView {
  return {
    async head(): Promise<CommitOid> {
      const sha = await currentSha(h.vaultPath);
      if (sha === null) {
        throw new Error(
          `harness.refs.head: vault ${h.vaultPath} has no HEAD (no commits yet)`,
        );
      }
      return commitOid(sha);
    },
    async adopted(branch?: string): Promise<CommitOid | null> {
      const raw = await getAdoptedRef(h.vaultPath, branch ?? h.branch);
      return raw === null ? null : commitOid(raw);
    },
    async current(): Promise<{ head: CommitOid; adopted: CommitOid | null }> {
      const sha = await currentSha(h.vaultPath);
      if (sha === null) {
        throw new Error(
          `harness.refs.current: vault ${h.vaultPath} has no HEAD`,
        );
      }
      const adopted = await getAdoptedRef(h.vaultPath, h.branch);
      return {
        head: commitOid(sha),
        adopted: adopted === null ? null : commitOid(adopted),
      };
    },
  };
}

function makeGitView(h: HarnessImpl): GitView {
  return {
    async log(opts?: { limit?: number }) {
      const depth = opts?.limit ?? 100;
      const entries = await gitLog({ path: h.vaultPath, depth });
      return entries.map((e) => ({
        oid: commitOid(e.oid),
        subject: extractSubject(e.commit.message),
      }));
    },
    async commitsMatching(subjectPattern: RegExp) {
      // Walk the entire history (or up to a generous cap). For H1 we
      // assume scenarios produce a small commit count; the cap exists
      // so a pathological case doesn't iterate millions of objects.
      const entries = await gitLog({ path: h.vaultPath, depth: 1000 });
      const out: Array<{
        oid: CommitOid;
        subject: string;
        trailers: Record<string, string>;
      }> = [];
      for (const e of entries) {
        const subject = extractSubject(e.commit.message);
        if (subjectPattern.test(subject)) {
          out.push({
            oid: commitOid(e.oid),
            subject,
            trailers: _parseTrailers(e.commit.message),
          });
        }
      }
      return out;
    },
    async commitExists(oid: string): Promise<boolean> {
      try {
        const root = await findGitRoot(h.vaultPath);
        if (root === null) return false;
        await git.readCommit({ fs, dir: root, oid });
        return true;
      } catch {
        return false;
      }
    },
    async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
      if (ancestor === descendant) return true;
      return gitIsAncestor({
        path: h.vaultPath,
        ancestor,
        descendant,
      });
    },
  };
}

function extractSubject(message: string): string {
  const idx = message.indexOf("\n");
  return idx === -1 ? message : message.slice(0, idx);
}

/**
 * Resolve a `BundleSpec` to `(id, src)` — the symlink name and the
 * source directory to symlink. Shipped-bundle ids (`string`) resolve
 * against `resolveShippedBundlesRoot()`; fixture-bundle specs
 * (`{ id, root }`) resolve directly against their declared root.
 *
 * Lives as a pure helper so both `HarnessImpl.create` and
 * `HarnessImpl.install` share one resolution rule.
 */
function resolveBundleSource(spec: BundleSpec): { id: string; src: string } {
  if (typeof spec === "string") {
    return { id: spec, src: join(resolveShippedBundlesRoot(), spec) };
  }
  return { id: spec.id, src: spec.root };
}

/**
 * Stringify a `console.log` / `console.error` argument for the
 * `runCli` capture buffer. Strings pass through; everything else goes
 * through `String(...)` which mirrors `console`'s default formatting.
 */
function stringifyForCapture(value: unknown): string {
  if (typeof value === "string") return value;
  return String(value);
}
