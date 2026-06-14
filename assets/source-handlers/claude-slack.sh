#!/bin/sh
# claude-slack.sh — dome.sources fetch-command template (slack kind).
#
# This file is SDK-shipped vault-side data, not SDK code (the model-provider
# template precedent: nothing under src/ executes it). Copy it into your
# vault — conventionally `.dome/bin/fetch-slack.sh` — adjust the FETCH
# section, and name it in the subscription:
#
#   extensions:
#     dome.sources:
#       config:
#         subscriptions:
#           slack:
#             enabled: true
#             schedule: "15 5 * * *"
#             output_path: "sources/slack/{date}.md"
#             command: ["sh", ".dome/bin/fetch-slack.sh"]
#
# The default FETCH runs `claude -p` AS the owner against the owner's
# claude.ai Slack connector (the connector is the "Slack MCP" surface in the
# claude.ai session). That connector loads only in an INTERACTIVE login
# session — see the WARNING block below; it does NOT load in the daemon's
# non-interactive `claude -p`, so the default is a foreground/example fetch,
# not a working daemon one. This script is the consent surface either way —
# copying it into the vault, reading the prompt, and flipping `enabled: true`
# is what authorizes the Slack read. Review the prompt before you enable it.
#
# Contract with the dome.sources handler (wiki/specs/sources.md):
#   - Invoked from the VAULT ROOT as: <command...> <date> <output_path>
#     ($1 = YYYY-MM-DD, $2 = vault-relative output path).
#   - Fetch the overnight digest, write $2 in the slack-day shape
#     (wiki/specs/vault-layout.md §"sources/"), and COMMIT it as an
#     ordinary git commit (a non-engine commit the daemon adopts).
#   - If $2 ALREADY EXISTS, skip the fetch and just commit it: a prior
#     attempt wrote the file but its commit failed (hook failure, killed
#     mid-script; signing is disabled per-commit below, so gpg cannot be
#     the cause). The handler verifies completion against HEAD and
#     retries exactly for this case — the retry is commit-only, never a
#     second fetch.
#   - Commit with a PATHSPEC (`git commit -m ... -- "$f"`) so a human's
#     concurrently staged work is never swept into the fetch commit.
#   - Exit non-zero on ANY failure so the outbox records the attempt and
#     retries; never commit a partial or empty-because-broken file.
#   - The attempt is bounded by engine.external_handler_timeout_ms
#     (default 30s). A headless-model fetch like the default below needs
#     that raised in .dome/config.yaml (e.g. 300000). `dome doctor`
#     reminds you while it is unset.
#
# ┌─ WARNING: the default FETCH below is FOREGROUND-ONLY ───────────────────────┐
# │ The default FETCH runs headless `claude -p` against the owner's claude.ai   │
# │ Slack connector. That works in an INTERACTIVE terminal — a full OAuth-      │
# │ subscription login session — and ONLY there. It does NOT work when this     │
# │ script is spawned by the daemon (launchd/systemd → non-interactive          │
# │ `claude -p`): claude.ai connectors are bound to the interactive login       │
# │ session and never load in a daemon-spawned headless run, which returns      │
# │ empty or "not logged in". This was verified — the interactive terminal      │
# │ made it LOOK like a working daemon fetcher; it is not one.                  │
# │                                                                             │
# │ Consequences:                                                               │
# │   - As shipped, this template is a FOREGROUND/example reference: Slack      │
# │     belongs in your morning foreground Claude session, where the connector  │
# │     is loaded. The daemon-composed brief covers vault state and gracefully  │
# │     omits the Slack digest when no slack day-file is present.               │
# │   - For DAEMON / scheduled use, replace the FETCH block with a              │
# │     DETERMINISTIC source that needs no interactive session: a direct Slack  │
# │     Web API call with a file-stored token. Anything that emits the          │
# │     slack-day markdown shape on stdout without depending on a connector     │
# │     login works.                                                            │
# │ The scaffolding below (REPAIR / VALIDATE / LAND) is sound for any fetcher;  │
# │ only the connector-backed FETCH line is foreground-bound.                   │
# └─────────────────────────────────────────────────────────────────────────────┘

set -eu

d="$1"
f="$2"

# Pathspec-scoped landing: stages and commits ONLY the fetched file, so
# anything a human has staged stays out of this commit. `-c
# commit.gpgsign=false` makes the commit signing-immune: a vault inheriting
# global commit.gpgsign=true would otherwise try to sign non-interactively
# and die (vault-data commits are engine-class — unsigned, like the
# engine's own isomorphic-git commits).
land() {
  git add -- "$f"
  git -c commit.gpgsign=false commit -m "slack: overnight digest for $d" -- "$f"
}

# ----- COMMIT-ONLY RETRY -------------------------------------------------------
# The file exists but the handler still dispatched us: a prior attempt's
# commit failed. Don't fetch again — commit what's there and exit.
if [ -e "$f" ]; then
  land
  exit 0
fi

mkdir -p "$(dirname "$f")"
tmp="$(mktemp)"
trap 'rm -f "$tmp" "$tmp.repaired"' EXIT

# ----- FETCH (adjust to taste) ----------------------------------------------
# Default: headless Claude against the owner's claude.ai Slack connector.
# FOREGROUND-ONLY — see the WARNING header: this works in an interactive
# `claude` session but NOT when the daemon spawns it (connectors are bound to
# the interactive login). For daemon/scheduled use SWAP this block for a
# deterministic exporter — a direct Slack Web API call with a file-stored
# token — anything that emits the slack-day markdown shape on stdout without a
# connector login works.
claude -p --output-format text "Summarize my Slack activity since the \
previous local evening — messages that mention me, my direct messages, and \
the high-traffic channels I am in — as a Dome slack-day markdown file for \
$d, and output ONLY that document, NOTHING else. Exact shape: a YAML \
frontmatter block with 'type: slack-day' and 'date: $d', then '# Slack $d', \
then up to three sections — '## Mentions', '## Direct messages', \
'## Channels' — each holding one '- ' list item per line shaped like \
'- [#channel] HH:MM author: \"message\"' (use '[DM]' instead of '[#channel]' \
for direct messages; under '## Channels' a one-line activity summary per \
channel is fine). OMIT empty sections entirely, keep every item to one line, \
and cap the whole digest at roughly 30 items. If there is nothing to report, \
emit the frontmatter and heading only. Do not wrap the output in code \
fences." > "$tmp"

# ----- REPAIR -----------------------------------------------------------------
# Deterministic normalization before the validation gate. Headless models
# reliably return the CORRECT document but sometimes wrap it in a ``` (or
# ```markdown) fence and/or prefix a chatty "Here's your digest:" line, so a
# fence or preamble — not broken content — sinks `head -n 1 | grep '^---$'`
# every run. We do NOT trust prompt obedience; we strip the wrapping here:
#   1. If the first non-blank line opens a fence (``` or ```markdown), drop it
#      and a matching trailing ``` fence line.
#   2. Then drop everything before the first '^---$' line (tolerates preamble).
# The validation below is still the safety gate — genuinely broken output
# (no frontmatter even after repair) keeps failing it.
repair() {
  awk '
    { lines[NR] = $0 }
    END {
      start = 1
      end = NR
      first = 0; last = 0
      for (i = 1; i <= NR; i++)
        if (lines[i] ~ /[^ \t]/) { if (first == 0) first = i; last = i }
      if (first == 0) exit            # all blank: leave the empty file to fail VALIDATE
      opener = 0
      for (i = first; i <= end; i++) {
        if (lines[i] !~ /[^ \t]/) continue
        if (lines[i] ~ /^---$/) break
        if (lines[i] ~ /^[ \t]*```([Mm]arkdown)?[ \t]*$/) { opener = i; break }
      }
      if (opener > 0) {
        start = opener + 1
        if (lines[last] ~ /^[ \t]*```[ \t]*$/) end = last - 1
      }
      for (i = start; i <= end; i++) if (lines[i] ~ /^---$/) { start = i; break }
      for (i = start; i <= end; i++) print lines[i]
    }
  ' "$tmp" > "$tmp.repaired"
  mv "$tmp.repaired" "$tmp"
}
repair

# ----- VALIDATE ---------------------------------------------------------------
# Refuse to commit something that is not a slack-day file (a model refusal,
# an error page, an empty fetch).
head -n 1 "$tmp" | grep -q '^---$' || {
  echo "fetch-slack: output is not a slack-day file (no frontmatter)" >&2
  exit 1
}
grep -q "^date: $d$" "$tmp" || {
  echo "fetch-slack: output frontmatter does not carry date: $d" >&2
  exit 1
}
grep -q "^# Slack $d$" "$tmp" || {
  echo "fetch-slack: output does not carry the '# Slack $d' heading" >&2
  exit 1
}

# ----- LAND (ordinary non-engine commit; the daemon adopts it) ----------------
mv "$tmp" "$f"
trap - EXIT
land
