---
type: guide
tags:
  - onboarding
  - dome-home
  - pwa
created: 2026-06-12
updated: 2026-07-16
sources:
  - "[[wiki/specs/product-host]]"
  - "[[wiki/specs/cli]]"
  - "[[wiki/specs/daily-surface]]"
description: "Dome Home onboarding: artifact, vault, Keychain setup, supervised host, paired PWA, first capture and recovery."
---

# Getting started with Dome Home

Dome Home is the one product beginning. It runs one Markdown/Git vault under a
supervised local host and serves the paired PWA at `http://127.0.0.1:3663/`.
The first supported beta is one owner on Apple Silicon macOS. Standalone
`dome serve`, `dome install`, and `dome http` remain advanced compatibility
tools; they are not needed for this walkthrough.

## 1. Obtain Dome Home

There is no public download or package-registry release yet. Use an expanded,
reviewed artifact supplied by the project owner. If you are building it
yourself, use Apple Silicon macOS, Bun 1.x, Git, and an installed stable Google
Chrome. The release gate launches Chrome and refuses a dirty source tree.

From a clean checkout:

```sh
bun install --frozen-lockfile
bun run build:home-artifact -- --output "$HOME/Dome-artifact"
```

The output directory must not already exist. The command runs the product
gates and prints JSON containing `directory`, the expanded artifact that may be
invoked, plus `archive` and their evidence. Set a shell variable to the exact
binary in the printed `directory`:

```sh
DOME="/path/from-the-directory-field/bin/dome"
"$DOME" --help
```

The artifact contains its pinned runtime, PWA, provider helper, and backup
tools. Do not replace `DOME` with the checkout's `bin/dome`: Home installation
verifies and copies the exact invoking artifact.

## 2. Initialize a new vault or explicitly adapt an existing vault

Choose an absolute path whose parent already exists. For a new vault:

```sh
VAULT="$HOME/Documents/My Vault"
"$DOME" init "$VAULT"
```

For an existing Obsidian or Git vault, do not use implicit init consent. Follow
the preview, external retained-plan, and digest flow in the README. Dome then
adapts only the reviewed inventory and returns a fresh plan without mutation if
the vault changes before apply.

For a new directory, init creates only the canonical Git-backed Dome scaffold
and its exact setup commit. It does not create example knowledge, source
adapters, or model-provider scripts. Review the setup commit before Home:

```sh
git -C "$VAULT" status --short
git -C "$VAULT" log --oneline -3
```

Do not commit `.dome/state`; the generated `.gitignore` excludes operational
databases and logs. Dome requires an ordinary Git identity for commits.

`dome init` is idempotent for the complete vault it created. The former source,
provider, and refresh flags are retired; existing-vault changes require the
explicit setup consent flow.

## 3. Install Home (a model is optional)

A fresh minimal vault deliberately has no model provider. Capture, Git-backed
adoption, tasks, deterministic Today content, and vault browsing work without
one. Install and verify the supervised Home service first:

```sh
"$DOME" home install --vault "$VAULT"
"$DOME" home status --vault "$VAULT"
"$DOME" status --vault "$VAULT"
```

Home installs a per-vault launchd service, copies the verified artifact into
its immutable managed release store, and waits for pairing readiness. launchd
restarts it after process crashes and on later logins/reboots. Product logs are at
`$VAULT/.dome/state/home.log`.

Ask, model-assisted ingestion, consolidation, and the morning brief require an
explicit `model_provider` configuration. The guided `dome setup model` flow is
planned for the next productization mission; M5 does not silently add a
provider script or API-key path. Advanced users may explicitly configure the
documented command-provider seam in `.dome/config.yaml`, then run
`dome home setup configure --vault "$VAULT"` to store its credential in the macOS login
Keychain. Do not run that credential command on a fresh minimal vault: it will
truthfully report that provider configuration is required first.

## 4. Pair the PWA

Mint a one-time, short-lived pairing code from the local console:

```sh
"$DOME" devices pair --vault "$VAULT" --name "Safari on this Mac"
open http://127.0.0.1:3663/
```

Enter the printed code in the PWA's **Pairing code** field and choose **Pair
device**. The code expires and cannot be reused. Each browser receives its own
durable credential, so a lost device can be revoked without disrupting the
others:

```sh
"$DOME" devices list --vault "$VAULT"
"$DOME" devices revoke <device-id> --vault "$VAULT"
```

Do not put pairing codes or credentials in URLs. The supported local product
URL is the root PWA, not `/today`, a query-token cockpit, or a bearer-token HTTP
page.

## 5. First Capture and Today

In the PWA composer:

1. Type a thought and choose the **+** capture control. Dome commits it to the
   vault and the engine digests it asynchronously.
2. Open Today or choose **Refresh Today** to see tasks, follow-ups, meetings,
   decisions, and operational attention that are actually available.
3. If you explicitly configured a model provider, type a question and press
   Enter or the send arrow. Ask answers from adopted vault state and cites its
   sources. Without a provider, Ask remains unavailable while Capture and Today
   continue to work.

You can also edit the vault in Obsidian or with a foreground coding agent.
Make coherent Git commits; Home observes the commit boundary and adopts them.
Use `"$DOME" sync --vault "$VAULT"` when you explicitly want to block until a
commit is compiled, and `"$DOME" status --vault "$VAULT"` for the cheap pulse.

Seed `core.md` with your role, projects, people, and standing preferences so
Ask and the brief have durable owner context. The optional owner interview is:

```sh
"$DOME" recipe core-seed
```

Review its output with your foreground agent, then commit the resulting
`core.md` changes.

## 6. The morning brief

With an explicitly configured provider, Home schedules the brief for 05:30
local time. If the Mac sleeps through the
interval, the operational scheduler collapses the missed interval on wake and
runs at most the due work; it does not fabricate repeated briefs. The brief
updates marker-delimited blocks in `wiki/dailies/<date>.md` from adopted vault
state and any source day-files that really exist.

Without a provider, deterministic Today remains the supported daily surface;
no setup step pretends that a model-backed brief can run.

If the provider or network fails, deterministic Today content stays available
and `dome check` reports the model failure. Fix the credential/runtime cause
with `home setup check`, then retry the brief without waiting for tomorrow or
moving its schedule cursor:

```sh
"$DOME" retry dome.agent.brief --vault "$VAULT"
```

`dome run dome.agent.brief` is intentionally unsupported: `dome run` invokes
read-only command-triggered views, while the brief remains a scheduled garden
processor whose effects pass through the normal capability and Proposal path.

## 7. Update Dome Home

There is no in-app updater or public release channel yet. Obtain a newer
reviewed artifact, or build a newer clean commit with step 1. Invoke upgrade
from that new artifact so Home can verify, rehearse, and atomically select it:

```sh
NEW_DOME="/path/to/new/artifact/bin/dome"
"$NEW_DOME" home upgrade --vault "$VAULT"
"$NEW_DOME" home status --vault "$VAULT"
"$NEW_DOME" home cleanup
```

`home cleanup` is a preview. Run it again with `--apply` only after reviewing
the unreachable managed releases it reports. Do not update a running Home by
pulling a checkout or replacing files inside its managed release directory.

## 8. Back up and recover

Generate an age identity once. Put the private identity on separate recovery
media, not beside the backup archive; the command prints its public recipient:

```sh
"$DOME" backup keygen --output "/Volumes/RecoveryKey/dome-backup.agekey"
```

With the printed `age1...` recipient, create and verify an encrypted backup on
external storage:

```sh
"$DOME" backup create --vault "$VAULT" \
  --output "/Volumes/Backup/dome-vault.age" \
  --recipient "age1..."
"$DOME" backup verify "/Volumes/Backup/dome-vault.age" \
  --identity "/Volumes/RecoveryKey/dome-backup.agekey"
```

Backup requires a clean standalone vault and an installed Home. It fences
writes, snapshots committed Markdown/Git plus the durable operational stores,
then resumes Home. Restore always publishes into an absent absolute path:

```sh
"$DOME" backup restore "/Volumes/Backup/dome-vault.age" \
  --identity "/path/to/offline/backup.agekey" \
  --target "/absolute/absent/path/My Restored Vault"
```

A restore invalidates prior device authority by design. Run `home install`
against the restored path, mint a new pairing code, and pair each browser
again.

For an unhealthy installation, start with:

```sh
"$DOME" home status --vault "$VAULT"
"$DOME" status --vault "$VAULT"
"$DOME" check --vault "$VAULT"
```

If you opted into a model provider, add `"$DOME" home setup check --vault
"$VAULT"` to that diagnostic sequence. Follow the reported next action.
Re-running `home upgrade` safely recovers a
retained upgrade intent. Do not hand-edit `.dome/state` or the managed release
store. The detailed lifecycle, backup, and failure contracts live in
[[wiki/specs/product-host]].

## Contributor and local SDK path

To work on Dome itself, clone the repository, run `bun install`, and invoke
`bin/dome` against a disposable vault. `bin/dome home` can run in the
foreground for PWA development; `dome sync` is the one-shot compiler path and
`dome mcp` is the foreground-harness adapter. The hidden standalone `serve`,
legacy service lifecycle, and `http` commands remain available for focused
compatibility testing. Their contracts are documented in
[[wiki/specs/cli]], [[wiki/specs/http-surface]], and
[[wiki/specs/foreground-compiler-workflow]] rather than duplicated here.
