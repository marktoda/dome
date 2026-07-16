---
type: spec
created: 2026-05-29
updated: 2026-07-16
sources:
  - "[[v1]]"
description: "Day-to-day operating guide for Dome Home plus a foreground agent: commit-boundary loop, source-first reading, catch-up, and recovery."
---

# Foreground compiler workflow

This is the operating guide for using installed Dome Home alongside Claude
Code or another shell-capable agentic harness. Home is the canonical product
host: launchd supervises the compiler, scheduler, authenticated HTTP contracts,
and PWA. A visible standalone `dome serve` remains a hidden compatibility path
for contributors debugging the SDK, not a second product lifecycle.

## Roles

- **Claude/user** edits markdown, commits coherent work, and asks for explicit
  views when useful.
- **Git** is the queue. Committed `HEAD` movement is what Dome compiles.
- **Dome Home** is the supervised compiler and product host. It watches the
  branch, runs adoption, drains garden/operational work, and keeps projections
  current while serving the paired PWA.
- **`dome sync`** is the blocking one-shot catch-up path. It runs the same
  compiler tick when the host is off or the user wants to wait.
- **`dome status` / `dome check` / `dome resolve`** are the normal recovery
  loop. They route attention, explain state, and route owner or agent
  decisions back through normal Effect handling.
- **`dome inspect` / `dome doctor` / `dome answer`** remain advanced detail
  and compatibility commands, not the daily path.

## Session startup

1. Confirm the installed Home service is ready:

   ```bash
   dome home status --vault /path/to/vault
   ```

   Install and pair Home through [[getting-started]] first. Do not also start
   standalone `dome serve` or `dome http` against the same vault.

2. Open Claude Code in the same vault. `CLAUDE.md` imports `AGENTS.md`; Claude
   should follow the vault instructions there.

3. Check the pulse when needed:

   ```bash
   dome status --json
   ```

   `attention_required: false` means Recall reads adopted state at current
   `HEAD`. When attention is required, follow `next_actions`.

## Normal edit loop

The steady-state loop is:

```text
Claude/user edits markdown
  -> git add / git commit
  -> Dome Home observes branch movement
  -> adoption processors run to a fixed point
  -> adopted ref advances
  -> garden processors run follow-on work
  -> views read adopted projections
```

Claude should not call Dome after every file edit. Dome works at the commit
boundary. The useful moments to call Dome explicitly are:

- `dome sync --json` when the user wants to block until the latest commit is adopted.
- `dome status --json` when the user wants a cheap health/adoption pulse.
- the `dome check ...` command in status `next_actions` when status reports
  remaining attention.
- `dome resolve <id> <value>` when a Dome question has a source-grounded
  answer.
- `dome query <text>` for adopted-state recall with SourceRefs.
- `dome export-context <topic>` for a portable context packet.
- Hidden compatibility/debug commands such as `dome lint` when explicitly
  debugging the substrate.

## Source-first reading

Use native file reads/search for known pages, directories, and bounded edits.
Run `dome views --json` to discover plugin-contributed compiled views. Use
`query` for unknown or cross-vault recall and `export-context` when a
source-backed multi-page packet materially helps. Open cited markdown before
important claims or edits. If a packet misses obvious context or returns noisy
results, record that as dogfood evidence; those misses are search/context-loop
bugs to fix.

## Host-off or explicit catch-up

If Home was stopped, committed work is not lost. Its next start or an explicit
sync uses the same Git queue:

```bash
dome sync --json
```

`dome sync` compares `refs/dome/adopted/<branch>` to `HEAD`, adopts the pending
range, and then drains due operational work against the resulting adopted
commit. A long host-off period may produce more work and model cost, but it is
a latency/cost issue, not a correctness issue.

## Recovery loop

When something looks wrong, use the recovery surfaces in this order:

1. **Host truth:** run `dome home status --vault /path/to/vault`, then use
   `dome status --json` for vault attention.
   - `next_actions` is the canonical branch for Claude Code.
   - `dome sync --json` means the compiler needs to catch up or drain due
     work.
   - a `dome check ...` command means attention remains after sync or needs a
     more detailed explanation.
   - `git status --short` means there are uncommitted draft files; commit,
     ignore, or remove them before expecting Dome to adopt them.

2. **Explain attention:** run the `dome check ...` command from
   `next_actions`. The broad form is:

   ```bash
   dome check --json
   ```

   `check` includes engine health findings, content diagnostics with SourceRefs,
   open questions with ids/options, and its own `next_actions`.

3. **Route engine questions:**

   `dome check --json` decision rows carry `automation_policy` plus optional
   `risk`, `confidence`, `recommended_answer`, and `owner_needed_reason`
   fields.

   - `agent-safe` questions may be completed through `dome agent-work` by a vault-aware
     foreground agent when the answer is grounded in the listed SourceRefs,
     current adopted vault context, and one of the question's allowed options.
     `recommended_answer` is a hint, not authority.
   - `owner-needed` questions, and any question without metadata, require owner
     context. Surface the question and reason instead of guessing.
   - Open questions do not block unrelated sync, garden work, or markdown edits.
     Resolve what is clear and keep other work moving.

4. **Resolve clear questions:**

   ```bash
   dome resolve <question-id> <value>
   ```

   Recovery mutations go through first-party health processors. For example,
   failed outbox rows ask whether to `retry` or `abandon`; quarantined
   processors ask whether to reset; orphan runs ask whether to fail stale
   running rows. The answer handler emits a recovery Effect, and the engine
   applies it through the same capability-checked routing path as every other
   processor output.

5. **Inspect concrete rows only when debugging:**

   ```bash
   dome inspect diagnostics
   dome inspect questions
   dome inspect runs
   dome inspect outbox
   dome doctor
   ```

   These commands expose row-level details and compatibility surfaces. They are
   not the first thing Claude should choose during the normal loop.

6. **Rebuild only rebuildable state:**

   ```bash
   dome rebuild
   ```

   This wipes and rebuilds `projection.db` from adopted markdown and eligible
   deterministic projection processors. It does not wipe `answers.db`,
   `runs.db`, or `outbox.db`.

Do not manually edit `.dome/state` to recover. If the shipped recovery surfaces
cannot explain a stuck state, that is a V1 bug to fix in Dome rather than a
state file to patch.

## What success looks like

- `dome home status` reports the supervised host ready.
- `dome status --json` shows `attention_required: false` after sync, or
  `next_actions` points to an understandable follow-up.
- Draft counts are expected only while the user has uncommitted work.
- Diagnostics/questions/outbox/quarantine are zero or intentionally being
  resolved.
- `dome query` and `dome export-context` read from adopted state and include
  source-backed evidence.
- For nontrivial vault tasks, Claude can start from `dome export-context` or
  `dome query` instead of manually rediscovering the same files.
- Claude can continue normal markdown work without knowing SQLite, internal
  run ids, or processor implementation details.

## Related

- [[wiki/specs/harnesses]] — the broader compiler-boundary contract.
- [[wiki/specs/cli]] — command syntax and JSON schemas.
- [[wiki/specs/adoption]] — fixed-point adoption and the adopted ref.
- [[wiki/gotchas/daemon-off-while-vault-mutating]] — host-off catch-up cost.
- [[wiki/gotchas/outbox-stuck]] — failed external-action recovery.
- [[v1]] — automation-first product workflow target.
