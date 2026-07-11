// first-party-defaults: the shipped grant/config defaults for the built-in
// dome.* bundles, in the raw YAML-ish shape the config loader consumes.
//
// This data lives at src/ root — importable by BOTH the CLI renderer
// (src/cli/default-vault-config.ts, which writes `.dome/config.yaml`) AND the
// engine config loader (src/engine/core/capability-policy.ts, which expands
// the `grants: standard` preset at load time). Keeping it here — instead of in
// src/cli/ — is what lets the engine read shipped defaults without an
// engine→cli upward import (the layering fence in
// tests/integration/surface-adapter-imports.ts + engine-import-direction).

/**
 * A raw grant value as it appears under `extensions.<bundle>.grant.<key>` in
 * `.dome/config.yaml`: a path/namespace list, an enable flag, a cost object,
 * etc. Parsed into concrete `Capability` records by the config loader.
 */
export type DefaultGrantValue =
  | boolean
  | number
  | string
  | ReadonlyArray<string>
  | Readonly<Record<string, boolean | number | string>>;

/**
 * Opaque per-extension `config:` payload (`extensions.<bundle>.config`).
 * Recursive JSON-ish shape so defaults can carry nested mappings (e.g. the
 * dome.sources subscriptions block). Rendered to YAML by
 * `renderConfigValue` and round-trip-tested against `defaultConfigRecord`.
 */
export type DefaultConfigValue =
  | boolean
  | number
  | string
  | ReadonlyArray<DefaultConfigValue>
  | { readonly [key: string]: DefaultConfigValue };

export type FirstPartyExtensionDefault = {
  readonly id: string;
  readonly enabled: boolean;
  /**
   * Optional shipped per-extension config (`extensions.<bundle>.config`).
   * Used where the consent surface ships visible-but-off defaults — e.g.
   * dome.sources ships the calendar subscription with `enabled: false`
   * so opting in is a one-line flip (wiki/specs/sources.md).
   */
  readonly config?: Readonly<Record<string, DefaultConfigValue>>;
  readonly grant: Readonly<Record<string, DefaultGrantValue>>;
  /**
   * Optional per-processor REPLACEMENT grants
   * (`extensions.<bundle>.processors.<id>.grant`). Used where one processor's
   * effective grant must differ from the bundle's — e.g. the
   * preference-promotion answer handler is the single processor allowed to
   * auto-write `core.md` (memory decision 4; wiki/specs/preferences.md).
   */
  readonly processors?: Readonly<
    Record<string, Readonly<Record<string, DefaultGrantValue>>>
  >;
};

/**
 * The source kinds `dome init --with-source <kind>` can scaffold: each has a
 * shipped fetch-adapter template at `assets/source-handlers/claude-<kind>.sh`
 * and a standard subscription stanza below. Scaffolding NEVER enables a
 * subscription — `enabled: false` is the shipped consent stance
 * (wiki/specs/sources.md); the owner reviews the script, then flips it.
 */
export type DefaultSourceKind = "calendar" | "slack";

export const DEFAULT_SOURCE_KINDS: ReadonlyArray<DefaultSourceKind> =
  Object.freeze(["calendar", "slack"]);

/**
 * The standard subscription stanza for a shipped source kind. Schedules sit
 * before the 05:30 morning brief so the day's feeds are committed in time:
 * calendar at 05:10, slack at 05:15.
 */
export function defaultSourceSubscription(
  kind: DefaultSourceKind,
): Readonly<Record<string, DefaultConfigValue>> {
  switch (kind) {
    case "calendar":
      return Object.freeze({
        enabled: false,
        schedule: "10 5 * * *",
        output_path: "sources/calendar/{date}.md",
        command: Object.freeze(["sh", ".dome/bin/fetch-calendar.sh"]),
      });
    case "slack":
      return Object.freeze({
        enabled: false,
        schedule: "15 5 * * *",
        output_path: "sources/slack/{date}.md",
        command: Object.freeze(["sh", ".dome/bin/fetch-slack.sh"]),
      });
  }
  const _exhaustive: never = kind;
  return _exhaustive;
}

export const FIRST_PARTY_EXTENSION_DEFAULTS: ReadonlyArray<FirstPartyExtensionDefault> =
  Object.freeze([
    extension("dome.lint", true, {
      read: ["**/*.md"],
    }),
    extension("dome.markdown", true, {
      read: [
        "**/*.md",
        // core.md is named explicitly (not left to "**/*.md" matching) so
        // the dome.markdown.core-size lint's read grant survives vaults
        // that narrow the markdown read scope (e.g. to wiki/**) — see
        // docs/memory.md §"Vault rollout".
        "core.md",
        ".dome/page-types.yaml",
        "**/*.{png,jpg,jpeg,gif,webp,svg,avif}",
        "raw/**",
      ],
      "patch.auto": ["**/*.md"],
      // The deterministic attic-sweep janitor's archive move
      // (write attic/<path> + delete <path>) never applies
      // inline — a SEPARATE capability from patch.auto above, routed to
      // proposals.db for `dome apply`.
      "patch.propose": ["notes/**", "wiki/**", "attic/**"],
      "graph.write": ["dome.page.*"],
      "question.ask": true,
    }),
    extension("dome.graph", true, {
      read: ["**/*.md"],
      "graph.write": ["dome.graph.*"],
    }),
    extension("dome.daily", true, {
      // Source files feed dome.daily.compose-blocks' deterministic agenda and
      // honest source record.
      // without them the reads return null and the blocks silently never
      // render (grant-scoped snapshot misses are silent).
      read: [
        "wiki/**/*.md",
        "notes/*.md",
        "sources/calendar/*.md",
        "sources/slack/*.md",
      ],
      "patch.auto": ["wiki/**/*.md", "notes/*.md"],
      "graph.write": ["dome.daily.*"],
      "question.ask": true,
      // dome.daily.compose-blocks reads open question rows via
      // ctx.operational.questions to render the deterministic "To decide"
      // block (daily-surface §"Block ownership").
      "questions.read": true,
      // dome.daily.compose-blocks reads pending garden-proposal rows via
      // ctx.operational.proposals to render the deterministic "To review"
      // block (daily-surface §"Block ownership").
      "proposals.read": true,
    }),
    extension("dome.claims", true, {
      read: ["wiki/**/*.md", "notes/*.md"],
      "patch.auto": ["wiki/**/*.md", "notes/*.md"],
      "graph.write": ["dome.claims.*"],
    }),
    extension(
      "dome.agent",
      true,
      {
        // core.md is deliberately read-only here (the canonical propose-only
        // grant shape): agents read core memory every run but never
        // auto-write it. Keep core.md out of the bundle patch.auto — its
        // only gated writers are the two block-scoped processors with the
        // narrow per-processor replacement grants below (each owns a
        // distinct generated block; everything else is propose-only).
        read: [
          "wiki/**/*.md",
          "notes/**/*.md",
          "inbox/**/*.md",
          "index.md",
          "log.md",
          "sources/calendar/*.md",
          "sources/slack/*.md",
          "core.md",
          "preferences/signals.md",
        ],
        // index.md and log.md are deliberately absent here (read stays
        // above): the index is a generated projection of description
        // frontmatter and the activity log is git history — agents read
        // them for context but never write them.
        "patch.auto": [
          "wiki/**/*.md",
          "notes/**/*.md",
          "inbox/processed/*.md",
          "inbox/raw/*.md",
          "preferences/signals.md",
        ],
        // Semantic gardening is judgment-heavy: every change is proposed.
        "patch.propose": ["wiki/**/*.md"],
        // Proposal decisions are the garden's durable memory; exact rejected
        // or pending opportunities are not regenerated.
        "proposals.read": true,
        // dome.preference.* carries the deterministic preference counter
        // facts (wiki/specs/preferences.md) emitted by
        // dome.agent.preference-signals; the model processors declare no
        // graph.write (MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS).
        "graph.write": ["dome.preference.*"],
        // The shipped guardrail now that the bundle ships enabled by default
        // (product-review-3 Task 17 — "the brain ships on"): a modest
        // extension-wide daily pool, not a disabled bundle, protects model
        // dollars. Per-processor declared caps in manifest.yaml (ingest/brief
        // $5, garden $10) sit above this
        // pool, so $2/day is the binding limit across the whole bundle until
        // an owner deliberately raises this grant.
        "model.invoke": Object.freeze({ maxDailyCostUsd: 2 }),
        "question.ask": true,
      },
      {
        // The two-gated-writers contract (memory decision 4 evolved;
        // wiki/specs/preferences.md): core.md's only auto-writers are these
        // two deterministic processors, each owning ONE distinct generated
        // block. The promotion answer handler owns promoted-preferences
        // (the promotion question WAS the owner review); active-projects
        // owns the active-projects block. Replacement grants stay exact:
        // the core page (+ the signals page for rejection tombstones) and,
        // for active-projects, the dailies its tallies are derived from.
        "dome.agent.preference-promotion-answer": Object.freeze({
          read: ["core.md", "preferences/signals.md"],
          "patch.auto": ["core.md", "preferences/signals.md"],
        }),
        "dome.agent.active-projects": Object.freeze({
          read: ["core.md", "wiki/dailies/*.md"],
          "patch.auto": ["core.md"],
        }),
        // The DETERMINISTIC index extractors (not model processors) publish the
        // cross-bundle facts the cockpit's today view reads: brief-index emits
        // dome.agent.brief from the daily note's brief block, calendar-index
        // emits dome.agent.calendar.event from sources/calendar. The bundle-wide
        // graph.write stays dome.preference.* (MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS);
        // these per-processor grants are the exact namespaces each deterministic
        // extractor needs. Replacement grants restate read.
        "dome.agent.brief-index": Object.freeze({
          read: ["wiki/dailies/*.md", "notes/*.md"],
          "graph.write": ["dome.agent"],
        }),
        "dome.agent.calendar-index": Object.freeze({
          read: ["sources/calendar/*.md"],
          "graph.write": ["dome.agent.calendar.*"],
        }),
      },
    ),
    extension("dome.search", true, {
      read: ["**/*.md"],
      "search.write": ["**/*.md"],
    }),
    // dome.sources — external-feed subscriptions (wiki/specs/sources.md).
    // The bundle is enabled (its 15-minute fetch tick is a cheap no-op when
    // nothing is due) but every shipped subscription is `enabled: false`:
    // consent is the per-subscription flip plus the vault-authored fetch
    // command (copy assets/source-handlers/claude-calendar.sh into
    // .dome/bin/ and adjust).
    extensionWithConfig(
      "dome.sources",
      true,
      {
        subscriptions: {
          calendar: defaultSourceSubscription("calendar"),
        },
      },
      {
        read: ["sources/**/*.md", ".dome/config.yaml"],
        external: ["sources.fetch"],
      },
    ),
    extension(
      "dome.health",
      true,
      {
        read: ["**"],
        "outbox.read": ["failed"],
        "question.ask": true,
        "outbox.recover": true,
        "quarantine.read": true,
        "quarantine.recover": true,
        "run.read": ["running"],
        "run.recover": true,
      },
      {
        // The weekly report card needs a WIDER run.read (all statuses, to count
        // failures/quarantines/productive) plus patch.auto — neither of which
        // the recovery-processor bundle grant carries. A replacement grant
        // scopes it exactly: the two files it writes, all run statuses, and
        // questions.read; it does NOT inherit the bundle's read:["**"], so the
        // reads it needs are restated. Normative: daily-surface §"Report card".
        "dome.health.report-card": Object.freeze({
          read: [
            "wiki/dailies/*.md",
            "meta/report-card.md",
            "meta/retrieval-misses.md",
            // The trust-ladder section resolves producer autonomy from the
            // vault grant surface.
            ".dome/config.yaml",
          ],
          "patch.auto": ["meta/report-card.md", "wiki/dailies/*.md"],
          "run.read": true,
          "questions.read": true,
          "proposals.read": true,
        }),
        // The trust ladder (wiki/specs/proposals.md §"Trust ladder"): reads
        // proposal rows + run rows + the config, proposes comment-preserving
        // config diffs (patch.propose scoped to the config file ONLY — the
        // gardener can never auto-apply its own autonomy change), and raises
        // self-clearing dormancy diagnostics (a finding, not a question — no
        // answer could unlock an engine action). A replacement grant, narrower
        // than the recovery-bundle grant it does not inherit.
        "dome.health.trust-review": Object.freeze({
          read: [".dome/config.yaml"],
          "patch.propose": [".dome/config.yaml"],
          "proposals.read": true,
          "run.read": true,
        }),
      },
    ),
  ]);

function extension(
  id: string,
  enabled: boolean,
  grant: Readonly<Record<string, DefaultGrantValue>>,
  processors?: Readonly<
    Record<string, Readonly<Record<string, DefaultGrantValue>>>
  >,
): FirstPartyExtensionDefault {
  return Object.freeze({
    id,
    enabled,
    grant: Object.freeze(grant),
    ...(processors !== undefined
      ? { processors: Object.freeze(processors) }
      : {}),
  });
}

function extensionWithConfig(
  id: string,
  enabled: boolean,
  config: Readonly<Record<string, DefaultConfigValue>>,
  grant: Readonly<Record<string, DefaultGrantValue>>,
): FirstPartyExtensionDefault {
  return Object.freeze({
    id,
    enabled,
    config: Object.freeze(config),
    grant: Object.freeze(grant),
  });
}
