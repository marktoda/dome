---
type: spec
created: 2026-05-29
updated: 2026-05-29
sources:
  - "[[wiki/syntheses/v1-claude-code-vault-plan]]"
  - "[[v1-roadmap]]"
---

# Foreground compiler workflow

This is the v1 operating guide for using Dome day to day with Claude Code or
another shell-capable agentic harness. It is intentionally foreground-first:
`dome serve` can later be wrapped by launchd/systemd or embedded in a native
app, but the first reliable product loop is a visible compiler process next to
the agent session.

## Roles

- **Claude/user** edits markdown, commits coherent work, and asks for explicit
  views when useful.
- **Git** is the queue. Committed `HEAD` movement is what Dome compiles.
- **`dome serve`** is the foreground compiler host. It watches the branch,
  runs adoption, drains garden/operational work, and keeps projections current.
- **`dome sync`** is the blocking one-shot catch-up path. It runs the same
  compiler tick when the host is off or the user wants to wait.
- **`dome status` / `dome doctor` / `dome inspect` / `dome answer`** are the
  recovery loop. They explain state and route human decisions back through
  normal Effect handling.

## Session startup

1. Open one terminal in the vault and start the compiler:

   ```bash
   dome serve
   ```

   Use `--vault <path>` when starting outside the vault. In early dogfood this
   process should stay visible so adoption, blocking diagnostics, and garden
   failures are obvious.

2. Open Claude Code in the same vault. `CLAUDE.md` imports `AGENTS.md`; Claude
   should follow the vault instructions there.

3. Check the pulse when needed:

   ```bash
   dome status
   ```

   The git row answers whether the adopted ref is caught up:
   `sync ok | pending 0` means Recall reads adopted state at current `HEAD`.
   `sync needed` means there are committed changes that still need adoption.

## Normal edit loop

The steady-state loop is:

```text
Claude/user edits markdown
  -> git add / git commit
  -> dome serve observes branch movement
  -> adoption processors run to a fixed point
  -> adopted ref advances
  -> garden processors run follow-on work
  -> views read adopted projections
```

Claude should not call Dome after every file edit. Dome works at the commit
boundary. The useful moments to call Dome explicitly are:

- `dome sync` when the user wants to block until the latest commit is adopted.
- `dome status` when the user wants a cheap health/adoption pulse.
- `dome query <text>` for adopted-state recall with SourceRefs.
- `dome today` / `dome prep` / `dome agenda <person-or-topic>` for daily
  management surfaces.
- `dome export-context <topic>` for a portable context packet.
- `dome lint` for deterministic vault hygiene.

## Host-off catch-up

If `dome serve` was not running, committed work is not lost. The next
foreground host startup or explicit sync uses the same git queue:

```bash
dome sync
```

`dome sync` compares `refs/dome/adopted/<branch>` to `HEAD`, adopts the pending
range, and then drains due operational work against the resulting adopted
commit. A long host-off period may produce more work and model cost, but it is
a latency/cost issue, not a correctness issue.

## Recovery loop

When something looks wrong, use the recovery surfaces in this order:

1. **Pulse:** run `dome status`.
   - `sync needed` means run `dome sync` or check the foreground `serve`
     process.
   - `projection stale` means projections need refresh before projection-backed
     diagnostics or views should be treated as current; run `dome sync` when
     the user wants to wait.
   - Non-zero diagnostics, questions, failed runs, failed outbox rows, or
     quarantines mean inspect/doctor has details.

2. **Inspect concrete rows:**

   ```bash
   dome inspect diagnostics
   dome inspect questions
   dome inspect runs
   dome inspect outbox
   ```

   `inspect diagnostics` includes source refs so Claude can jump to the file
   and fix markdown. `inspect questions` gives stable row ids for `dome answer`.

3. **Run health probes:**

   ```bash
   dome doctor
   ```

   Doctor is read-only in v1. It reports failed outbox rows, stuck pending
   outbox rows, orphan running runs, processor quarantines, projection cache
   drift, adopted-ref divergence, instruction drift, and unrebuildable
   operational schema mismatches.

4. **Answer engine questions:**

   ```bash
   dome answer <question-id> <value>
   ```

   Recovery mutations go through first-party health processors. For example,
   failed outbox rows ask whether to `retry` or `abandon`; quarantined
   processors ask whether to reset; orphan runs ask whether to fail stale
   running rows. The answer handler emits a recovery Effect, and the engine
   applies it through the same capability-checked routing path as every other
   processor output.

5. **Rebuild only rebuildable state:**

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

- `dome status` shows `sync ok | pending 0`.
- Draft counts are expected only while the user has uncommitted work.
- Diagnostics/questions/outbox/quarantine are zero or intentionally being
  resolved.
- `dome query`, `dome today`, `dome prep`, `dome agenda`, and
  `dome export-context` read from adopted state and include source-backed
  evidence.
- Claude can continue normal markdown work without knowing SQLite, internal
  run ids, or processor implementation details.

## Related

- [[wiki/specs/harnesses]] — the broader compiler-boundary contract.
- [[wiki/specs/cli]] — command syntax and JSON schemas.
- [[wiki/specs/adoption]] — fixed-point adoption and the adopted ref.
- [[wiki/gotchas/daemon-off-while-vault-mutating]] — host-off catch-up cost.
- [[wiki/gotchas/outbox-stuck]] — failed external-action recovery.
- [[wiki/syntheses/v1-claude-code-vault-plan]] — product workflow target.
