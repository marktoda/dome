#!/bin/sh
# claude-calendar.sh — dome.sources fetch-command template (calendar kind).
#
# This file is SDK-shipped vault-side data, not SDK code (the model-provider
# template precedent: nothing under src/ executes it). Copy it into your
# vault — conventionally `.dome/bin/fetch-calendar.sh` — adjust the FETCH
# section, and name it in the subscription:
#
#   extensions:
#     dome.sources:
#       config:
#         subscriptions:
#           calendar:
#             enabled: true
#             schedule: "10 5 * * *"
#             output_path: "sources/calendar/{date}.md"
#             command: ["sh", ".dome/bin/fetch-calendar.sh"]
#
# Contract with the dome.sources handler (wiki/specs/sources.md):
#   - Invoked from the VAULT ROOT as: <command...> <date> <output_path>
#     ($1 = YYYY-MM-DD, $2 = vault-relative output path).
#   - Fetch the agenda, write $2 in the calendar-day shape
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
  git -c commit.gpgsign=false commit -m "calendar: agenda for $d" -- "$f"
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
# Default: headless Claude with calendar access (MCP or gcalcli underneath).
# Swap this block for a direct `gcalcli agenda ... | awk ...` pipeline or an
# EventKit script if you prefer a deterministic fetcher — anything that
# emits the calendar-day markdown shape on stdout works.
claude -p --output-format text "Print today's ($d) calendar agenda as a Dome \
calendar-day markdown file and NOTHING else. Exact shape: a YAML frontmatter \
block with 'type: calendar-day' and 'date: $d', then '# Calendar $d', then \
one '- ' list item per meeting: optional HH:MM–HH:MM time, ' — ', the title, \
and optional ' (attendees: a, b)'. If there are no meetings, emit the \
frontmatter and heading only. Do not wrap the output in code fences." > "$tmp"

# ----- REPAIR -----------------------------------------------------------------
# Deterministic normalization before the validation gate. Headless models
# reliably return the CORRECT document but sometimes wrap it in a ``` (or
# ```markdown) fence and/or prefix a chatty "Here's your calendar:" line, so a
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
      # First and last non-blank lines.
      first = 0; last = 0
      for (i = 1; i <= NR; i++)
        if (lines[i] ~ /[^ \t]/) { if (first == 0) first = i; last = i }
      if (first == 0) exit            # all blank: leave the empty file to fail VALIDATE
      # 1. Find a leading ``` (or ```markdown) fence OPENER: the fence line at
      #    or just after any chatty preamble, but before the frontmatter fence.
      opener = 0
      for (i = first; i <= end; i++) {
        if (lines[i] !~ /[^ \t]/) continue
        if (lines[i] ~ /^---$/) break
        if (lines[i] ~ /^[ \t]*```([Mm]arkdown)?[ \t]*$/) { opener = i; break }
      }
      # 2. If a fence opened, drop the opener and a matching trailing ``` closer.
      if (opener > 0) {
        start = opener + 1
        if (lines[last] ~ /^[ \t]*```[ \t]*$/) end = last - 1
      }
      # 3. Drop any remaining preamble before the first frontmatter fence.
      for (i = start; i <= end; i++) if (lines[i] ~ /^---$/) { start = i; break }
      for (i = start; i <= end; i++) print lines[i]
    }
  ' "$tmp" > "$tmp.repaired"
  mv "$tmp.repaired" "$tmp"
}
repair

# ----- VALIDATE ---------------------------------------------------------------
# Refuse to commit something that is not a calendar-day file (a model
# refusal, an error page, an empty fetch).
head -n 1 "$tmp" | grep -q '^---$' || {
  echo "fetch-calendar: output is not a calendar-day file (no frontmatter)" >&2
  exit 1
}
grep -q "^date: $d$" "$tmp" || {
  echo "fetch-calendar: output frontmatter does not carry date: $d" >&2
  exit 1
}

# ----- LAND (ordinary non-engine commit; the daemon adopts it) ----------------
mv "$tmp" "$f"
trap - EXIT
land
