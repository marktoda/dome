// tests/harness/types.ts — the API contract for the test harness.
//
// The harness is a scenario-driven simulator. Tests describe a sequence of
// moves (user commits, daemon ticks, bundle installs, etc.) against a real
// vault fixture (real git repo, real sqlite DBs, real engine), and the
// harness verifies post-conditions via a fluent matcher API after each
// move. The architecture has two layers:
//
//   1. Scenarios — multi-step narratives. Each move corresponds to a real
//      thing a user / daemon / external system does. Moves are async; the
//      Harness class is the orchestrator.
//   2. Always-true invariants — structural properties that MUST hold after
//      every state-changing move. The harness runs them automatically; a
//      violation fails the scenario at the move that triggered it, naming
//      the violated invariant.
//
// The DSL is deliberately close to prose: `await h.userCommit(...)` reads
// like "the user committed"; `await h.expectRef("refs/heads/main")
// .toHaveAdvanced()` reads like "expect main to have advanced".
//
// All types here are TYPE-LEVEL ONLY (no runtime); the runtime classes
// implementing them live in sibling files (`./harness`, `./test-clock`,
// `./assertions/*`).

import type { CommitOid } from "../../src/core/source-ref";
import type { LedgerDb } from "../../src/ledger/db";
import type { RunStatus } from "../../src/ledger/runs";
import type { OutboxDb } from "../../src/outbox/db";
import type { ProjectionDb } from "../../src/projections/db";
import type { Capability, ProcessorPhase, Trigger } from "../../src/core/processor";
import type { Effect } from "../../src/core/effect";
import type { ModelProvider } from "../../src/engine/model-invoke";
import type { OperationalWorkResult } from "../../src/engine/operational-work";

// ============================================================================
// ----- Harness setup --------------------------------------------------------
// ============================================================================

/**
 * A bundle to install into the harness vault. Two shapes:
 *
 *   - A plain `string` — the bundle id. Resolved from the SDK's shipped-
 *     bundles directory (`assets/extensions/<id>`). This is the common
 *     case: `"dome.markdown"`, `"dome.lint"`, etc.
 *   - A `{ id, root }` object — a **fixture bundle** at a custom
 *     directory root. Used by scenarios that need to exercise behavior
 *     no shipped bundle provides today (e.g., a garden-phase processor
 *     that emits a PatchEffect, for testing the cascade path). The
 *     `id` becomes the symlink name under `.dome/extensions/`; the
 *     `root` is the absolute path to the bundle's source directory
 *     (containing `manifest.yaml` + `processors/`).
 *
 * Fixture bundles live under `tests/harness/fixtures/bundles/<id>/` by
 * convention. The `root` field lets callers point anywhere — the harness
 * doesn't enforce a fixtures location.
 */
export type BundleSpec =
  | string
  | { readonly id: string; readonly root: string };

/**
 * Options for constructing a fresh harness fixture. All optional; sensible
 * defaults give an empty git-initialized vault with no bundles.
 */
export type HarnessOpts = {
  /**
   * Bundles to install at startup. Each entry is either a shipped-
   * bundle id (`string`) resolved from the SDK's `assets/extensions/`,
   * or a fixture-bundle spec (`{ id, root }`) resolved from an
   * arbitrary directory. The harness symlinks each bundle's root into
   * the vault's `.dome/extensions/<id>/` so the runtime's bundle
   * loader picks it up.
   */
  readonly bundles?: ReadonlyArray<BundleSpec>;

  /**
   * Pre-seeded files to write into the vault's working tree before the
   * initial commit. Useful for scenarios that need a non-empty baseline.
   * Paths are vault-relative.
   */
  readonly initialFiles?: Record<string, string>;

  /**
   * Whether to make an initial commit after writing `initialFiles`. Default
   * `true` — most scenarios assume HEAD exists.
   */
  readonly initialCommit?: boolean;

  /**
   * Branch name to use. Defaults to `"main"`.
   */
  readonly branch?: string;

  /**
   * Override the simulated clock. Defaults to a TestClock starting at
   * `"2026-01-01T00:00:00.000Z"`. Tests that exercise schedule triggers
   * pass a custom clock.
   */
  readonly clock?: TestClockHandle;

  /**
   * Optional provider injected into the live VaultRuntime. Scenarios use this
   * to exercise model.invoke behavior end-to-end without importing a vendor SDK.
   */
  readonly modelProvider?: ModelProvider;

  /**
   * Seed for deterministic randomness (for run-id generation, etc.).
   * Defaults to `0`.
   */
  readonly seed?: number;
};

// ============================================================================
// ----- TestClock ------------------------------------------------------------
// ============================================================================

/**
 * Simulated clock for deterministic time control. Tests don't wait for
 * real time — they call `clock.advance(ms)` to move time forward. Schedule
 * triggers (when implemented) fire based on this clock, not Date.now.
 */
export interface TestClockHandle {
  /** Current simulated time in milliseconds since epoch. */
  readonly nowMs: () => number;
  /** Current simulated time as a Date. */
  readonly now: () => Date;
  /** Current simulated time as ISO-8601 string. */
  readonly nowIso: () => string;
  /** Move simulated time forward. Returns the new time. */
  readonly advance: (ms: number) => number;
}

// ============================================================================
// ----- Scenario tags (for coverage matrix) ----------------------------------
// ============================================================================

export type EffectKind = Effect["kind"];

export type TriggerKind = Trigger["kind"];

export type CapabilityKind = Capability["kind"];

export type ScenarioGroup =
  | "basic-adoption"
  | "convergence"
  | "effect-kinds"
  | "triggers"
  | "capabilities"
  | "external-actions"
  | "lifecycle"
  | "out-of-band"
  | "accumulation"
  | "multi-bundle"
  | "cli-surface"
  | "garden-cascade"
  | "regression";

export type LifecycleEvent =
  | "crash"
  | "restart"
  | "schema-migration"
  | "bundle-install"
  | "bundle-remove"
  | "bundle-version-bump";

/**
 * One scenario tag. Tags drive the coverage-matrix meta-test: adding a new
 * effect kind / trigger / phase / capability without adding a scenario that
 * exercises it fails CI. This is the structural fence behind the "high
 * signal" property.
 */
export type ScenarioTag =
  | { readonly kind: "effect"; readonly effect: EffectKind }
  | { readonly kind: "phase"; readonly phase: ProcessorPhase }
  | { readonly kind: "trigger"; readonly trigger: TriggerKind }
  | { readonly kind: "capability"; readonly capability: CapabilityKind }
  | { readonly kind: "lifecycle"; readonly event: LifecycleEvent }
  | { readonly kind: "group"; readonly group: ScenarioGroup };

// ============================================================================
// ----- Scenario shape -------------------------------------------------------
// ============================================================================

/**
 * The shape `scenario(spec, fn)` accepts. The runtime wrapper in `./index.ts`
 * registers the scenario into the global index (for coverage-matrix
 * verification) and wraps `fn` in a `bun:test` `test()` call that creates
 * a fresh Harness, runs the body, and cleans up.
 */
export type ScenarioSpec = {
  /** Human-readable name; used as the test name in `bun test` output. */
  readonly name: string;
  /**
   * Tags for the coverage matrix. Each scenario must declare at least one
   * group tag; effect/trigger/phase/capability tags are encouraged for
   * scenarios that exercise specific architecture edges.
   */
  readonly tags: ReadonlyArray<ScenarioTag>;
  /** Harness-construction options. Same shape as `HarnessOpts`. */
  readonly harness?: HarnessOpts;
  /**
   * Optional skip flag. When `true`, the scenario is registered (so it
   * counts toward the coverage matrix) but `test.skip` is used. Document
   * the reason inline.
   */
  readonly skip?: { readonly reason: string };
  /**
   * Optional time budget. The scenario fails if `fn` exceeds this duration
   * (catches perf regressions). Default: no budget.
   */
  readonly timeoutMs?: number;
};

/** The body of a scenario — a sequence of harness moves + assertions. */
export type ScenarioBody = (h: Harness) => Promise<void>;

// ============================================================================
// ----- Move inputs ----------------------------------------------------------
// ============================================================================

export type UserCommitInput = {
  /** Vault-relative file paths → new content. Empty value `null` deletes. */
  readonly files: Record<string, string | null>;
  /** Commit message. */
  readonly message: string;
  /** Author override. Defaults to `dome-test <test@local>`. */
  readonly author?: { readonly name: string; readonly email: string };
};

export type UserEditInput = {
  /** Vault-relative file paths → new content. */
  readonly files: Record<string, string | null>;
};

export type TickResult = {
  /** Whether drift was detected this tick. False = no work this tick. */
  readonly hadDrift: boolean;
  /** When `hadDrift`, the adopted ref before/after this tick. */
  readonly adoptedBefore?: CommitOid;
  readonly adoptedAfter?: CommitOid;
  /** Total diagnostics emitted across all iterations this tick. */
  readonly diagnosticCount: number;
  /** Iterations the loop ran. */
  readonly iterations: number;
  /** Whether the adoption result reported `adopted: true`. */
  readonly adopted: boolean;
  /**
   * The closure commit OID this tick landed, or null when the loop
   * reached a fixed point without engine writes. Mirrors
   * `AdoptionResult.closureCommitOid`. Tests asserting "exactly one
   * closure commit landed" can read this directly instead of scanning
   * git history for `engine(`/`adopt:` subjects.
   */
  readonly closureCommitOid: CommitOid | null;
};

// ============================================================================
// ----- Matcher interfaces ---------------------------------------------------
// ============================================================================

/**
 * `expectRef(name)` returns this matcher. Each method is an assertion that
 * runs the check + the always-true invariants. The "$HEAD" / "$LAST_COMMIT"
 * placeholders are substituted from the harness's state.
 */
export interface RefMatcher {
  /** Assert the ref equals `other` (a literal SHA or a placeholder). */
  toEqual(other: string): Promise<void>;
  /** Assert the ref equals current HEAD. */
  toEqualHead(): Promise<void>;
  /** Assert the ref moved since the last move. Captures snapshot semantics. */
  toHaveAdvanced(): Promise<void>;
  /** Assert the ref did NOT move since the last move. */
  toBeUnchanged(): Promise<void>;
  /** Assert `this ref → otherCommit` is a fast-forward / ancestor relationship. */
  toBeAncestorOf(other: string): Promise<void>;
  /** Assert the ref exists (resolves to a commit). */
  toExist(): Promise<void>;
  /** Assert the ref does NOT exist. */
  toNotExist(): Promise<void>;
}

export interface FileMatcher {
  toExist(): Promise<void>;
  toBeAbsent(): Promise<void>;
  toContain(substring: string): Promise<void>;
  toMatch(regex: RegExp): Promise<void>;
  toEqual(expectedContent: string): Promise<void>;
  /** Assert the file does NOT contain the substring. */
  toNotContain(substring: string): Promise<void>;
}

export type LedgerRunRowProjection = {
  readonly id: string;
  readonly processorId: string;
  readonly phase: ProcessorPhase;
  readonly status: RunStatus;
  readonly inputCommit: CommitOid;
  readonly outputCommit: CommitOid | null;
  readonly error: string | null;
};

/**
 * Filter shape for `Harness.expectLedger(...)`. All fields are optional;
 * undefined means "no constraint on that axis". `withOutputCommit`
 * filters by NULL vs NOT NULL on the `output_commit` column (true → only
 * rows whose run produced a closure commit; false → only rows whose run
 * did not). Composes with AND.
 */
export type LedgerFilter = {
  readonly processorId?: string;
  readonly status?: RunStatus;
  readonly withOutputCommit?: boolean;
};

export interface LedgerMatcher {
  /** Assert exactly N rows match the filter. */
  toHaveCount(n: number): Promise<void>;
  /** Assert at least one row matches; return the most recent. */
  toHaveAtLeastOne(): Promise<LedgerRunRowProjection>;
  /** Assert exactly one row matches; return it. */
  toHaveExactlyOne(): Promise<LedgerRunRowProjection>;
  /** Assert all matching rows have the given status. */
  toAllHaveStatus(status: RunStatus): Promise<void>;
  /** Assert no orphan rows (running > 60s in test clock). */
  toHaveNoOrphans(): Promise<void>;
}

export interface ProjectionMatcher {
  /** Assert N rows in the diagnostics table match the filter. */
  diagnostics(filter?: { severity?: string; code?: string }): {
    toHaveCount(n: number): Promise<void>;
    toContainMessage(substring: string): Promise<void>;
    /**
     * Assert every matching row's `adopted_commit` column equals
     * `expected`. Designed for sub-Proposal frame-correctness
     * scenarios — diagnostics emitted inside a sub-adoption should be
     * tagged with the sub-Proposal's head, not the parent's.
     */
    toAllHaveAdoptedCommit(expected: string): Promise<void>;
  };
  /** Assert N rows in the facts table match the filter. */
  facts(filter?: { predicate?: string; subjectId?: string; objectString?: string }): {
    toHaveCount(n: number): Promise<void>;
  };
  /** Assert N rows in the questions table match the filter. */
  questions(): {
    toHaveCount(n: number): Promise<void>;
    toContainQuestion(substring: string): Promise<void>;
  };
}

export interface OutboxMatcher {
  /** Assert N rows in the outbox match the filter. */
  toHaveCount(filter?: { status?: "pending" | "sent" | "failed" }): {
    matching(n: number): Promise<void>;
  };
  toHaveNoStaleRows(maxAgeMs: number): Promise<void>;
}

export interface CommitMatcher {
  toHaveAllTrailers(required: ReadonlyArray<string>): Promise<void>;
  /**
   * Assert specific trailer values. Each key/value pair in `expected` must
   * be present on the commit AND its value must equal exactly. Useful for
   * verifying `Dome-Base` / `Dome-Source-Head` correctness on engine
   * commits — the Phase 4a' sink-frame bug landed wrong values without
   * affecting trailer presence, so `toHaveAllTrailers` alone wouldn't
   * have caught it.
   */
  toHaveTrailerValues(expected: Record<string, string>): Promise<void>;
  toHaveSubjectMatching(pattern: RegExp): Promise<void>;
  toHaveParent(expectedParent: string): Promise<void>;
}

// ============================================================================
// ----- Harness inspection surfaces (read-only views) ------------------------
// ============================================================================

/** Read-only access to the vault's refs. */
export interface RefsView {
  head(): Promise<CommitOid>;
  adopted(branch?: string): Promise<CommitOid | null>;
  current(): Promise<{ head: CommitOid; adopted: CommitOid | null }>;
}

/** Read-only access to git history. */
export interface GitView {
  log(opts?: { limit?: number }): Promise<ReadonlyArray<{ oid: CommitOid; subject: string }>>;
  commitsMatching(subjectPattern: RegExp): Promise<
    ReadonlyArray<{ oid: CommitOid; subject: string; trailers: Record<string, string> }>
  >;
  commitExists(oid: string): Promise<boolean>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
}

// ============================================================================
// ----- The Harness class shape (the runtime is in ./harness.ts) -------------
// ============================================================================

/**
 * The Harness class is the orchestrator. Tests construct one per scenario
 * via `scenario(spec, async (h) => { ... })` which calls
 * `Harness.create(opts)` and cleans up at the end. The class is mutable —
 * each move advances internal state.
 */
export interface Harness {
  // ----- Stable handles -----
  readonly vaultPath: string;
  readonly branch: string;
  readonly clock: TestClockHandle;
  readonly ledger: LedgerDb;
  readonly projection: ProjectionDb;
  readonly outbox: OutboxDb;
  readonly refs: RefsView;
  readonly git: GitView;

  // ----- User moves -----
  /** Write files to the working tree + git add + git commit. Returns the
   *  new HEAD commit oid. */
  userCommit(input: UserCommitInput): Promise<CommitOid>;
  /** Modify the working tree without committing. */
  userEdit(input: UserEditInput): Promise<void>;
  /** Delete files from the working tree (and stage the deletion via add -A). */
  userDelete(paths: ReadonlyArray<string>): Promise<void>;
  /** Checkout a ref. */
  userCheckout(ref: string): Promise<void>;

  // ----- Daemon / engine moves -----
  /** One drift-detect + adopt cycle. Equivalent to `dome sync` once. */
  tick(): Promise<TickResult>;
  /** Move simulated time forward; call tick/drainOperationalWork to fire due work. */
  advance(ms: number): Promise<void>;
  /** Drain due schedule, queued job, and outbox work against the adopted state. */
  drainOperationalWork(): Promise<OperationalWorkResult>;
  /** Force `dome sync --force-advance` semantics. */
  forceSync(): Promise<TickResult>;
  /** Close the runtime, then re-open. Simulates daemon restart. */
  crashAndRestart(): Promise<void>;
  /** Reopen the runtime with whatever bundles are currently installed. */
  reopenRuntime(): Promise<void>;

  // ----- Bundle moves -----
  /** Install bundles. Each entry is either a shipped-bundle id
   *  (e.g., `"dome.markdown"`) or a fixture-bundle spec
   *  (`{ id, root }`) per `BundleSpec`. Reopens the runtime so the
   *  new bundle's processors are loaded. */
  install(bundles: ReadonlyArray<BundleSpec>): Promise<void>;
  /** Uninstall a bundle by id. Reopens the runtime. */
  uninstall(bundleId: string): Promise<void>;

  // ----- Snapshot semantics for `toHaveAdvanced` / `toBeUnchanged` -----
  /** Capture current state as a snapshot. Subsequent matchers compare
   *  against this. Called automatically by every move method; tests can
   *  call it explicitly to define a custom checkpoint. */
  snapshot(): Promise<void>;

  // ----- Assertions / matchers -----
  expectRef(name: string): RefMatcher;
  expectFile(path: string, opts?: { atCommit?: string }): FileMatcher;
  expectLedger(filter?: LedgerFilter): LedgerMatcher;
  expectProjection(): ProjectionMatcher;
  expectOutbox(): OutboxMatcher;
  expectCommit(commitRef: string): CommitMatcher;

  // ----- Always-true invariant runner (also called automatically after moves) -----
  /** Run all always-true structural invariants. Failure throws with a
   *  message naming the violated invariant. Each move method calls this
   *  internally; tests can also invoke it explicitly. */
  assertAlwaysTrue(): Promise<void>;

  // ----- CLI invocation -----
  /**
   * Invoke a Dome CLI command in-process (not via subprocess). Closes the
   * harness's open runtime before invocation (the CLI command opens its
   * own runtime against the same vault path; SQLite handles must not
   * overlap), captures stdout + stderr by overriding `console.log` /
   * `console.error`, dispatches via the same `runCli` the `bin/dome` shim
   * uses, then reopens the harness's runtime so subsequent matchers see
   * any state the command landed.
   *
   * The `args` array follows shell-style positionals + flags
   * (e.g., `["run", "orphan-pages", "--json"]`). The harness prepends
   * `--vault <vaultPath>` automatically so the CLI targets the
   * scenario's vault.
   */
  runCli(args: ReadonlyArray<string>): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }>;

  // ----- Cleanup -----
  cleanup(): Promise<void>;
}

// ============================================================================
// ----- Always-true invariants -----------------------------------------------
// ============================================================================

/**
 * One always-true invariant. The harness runs every entry's `check`
 * function after each state-changing move. If any throws, the scenario
 * fails with a message naming the invariant.
 *
 * Invariants are NAMED. Each name matches a docs/wiki/invariants/*.md
 * entry (or a substrate-supported runtime claim). Adding a new invariant
 * doc should be accompanied by an entry here.
 */
export type AlwaysTrueInvariant = {
  readonly name: string;
  readonly description: string;
  readonly check: (h: Harness) => Promise<void>;
};

// ============================================================================
// ----- Scenario registry ----------------------------------------------------
// ============================================================================

/**
 * Each `scenario(...)` call registers into this in-memory index. The
 * coverage-matrix meta-test reads from this index to verify that every
 * effect kind / trigger / phase / capability has at least one scenario.
 *
 * The index is module-scoped to `./index.ts`; this type is exported
 * here so the meta-test can read it.
 */
export type ScenarioRegistryEntry = {
  readonly spec: ScenarioSpec;
};
