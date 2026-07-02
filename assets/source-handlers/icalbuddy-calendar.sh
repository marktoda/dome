#!/bin/sh
# icalbuddy-calendar.sh — dome.sources fetch-command template (calendar kind).
#
# This file is SDK-shipped vault-side data, not SDK code (the model-provider
# template precedent: nothing under src/ executes it). This is the
# DETERMINISTIC daemon-safe default: unlike claude-calendar.sh (which drives
# a headless `claude -p` against the owner's claude.ai Google Calendar
# connector — foreground-only, see that file's header), this template reads
# Calendar.app directly via `icalBuddy` (EventKit) and needs no interactive
# login session, so a launchd/systemd-spawned daemon can run it unattended.
#
# Copy it into your vault — conventionally `.dome/bin/fetch-calendar.sh` —
# and name it in the subscription:
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
#     (default 30s) — plenty for a local EventKit read.
#
# ┌─ macOS Calendar access (TCC) ────────────────────────────────────────────┐
# │ icalBuddy reads Calendar.app through EventKit, which is gated by macOS   │
# │ TCC privacy consent. The FIRST run under a given process identity        │
# │ (Terminal, the daemon's launchd job, ...) prompts for access; a          │
# │ headless daemon context often can't show that prompt and icalBuddy      │
# │ simply exits non-zero instead. That failure rides the EXISTING outbox    │
# │ machinery with no new signal needed: icalBuddy fails -> this script      │
# │ exits non-zero -> the outbox retries and eventually surfaces a health    │
# │ recovery question. Grant access via System Settings -> Privacy &        │
# │ Security -> Calendars (add Terminal/the daemon's host process), then     │
# │ let the next retry clear it.                                             │
# └───────────────────────────────────────────────────────────────────────────┘
#
# There is no REPAIR stage here (unlike claude-calendar.sh): REPAIR exists
# there to strip a headless model's code-fence/preamble wrapping around
# otherwise-correct content. icalBuddy is deterministic — it either emits
# parseable agenda lines or fails outright — so there is nothing to unwrap.

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
tmp_ical="$(mktemp)"
trap 'rm -f "$tmp" "$tmp_ical"' EXIT

# ----- FETCH (deterministic; requires macOS Calendar access) ------------------
# icalBuddy reads Calendar.app (EventKit) — recurring events expand
# correctly. ICAL_CALENDARS: optional comma-separated include list
# (icalBuddy -ic) to scope to specific calendars (e.g. your work account)
# and keep Birthdays/US Holidays noise out. Empty = all calendars.
ICAL_CALENDARS="${ICAL_CALENDARS:-}"
ical_args=""
[ -n "$ICAL_CALENDARS" ] && ical_args="-ic $ICAL_CALENDARS"

# The property separator is a TAB (embedded literally via printf — a real
# tab char is version-proof, no reliance on icalBuddy's escape processing),
# NOT " — ": event titles can legitimately contain " — " (e.g.
# "Q3 — Planning") and an em-dash separator would split INSIDE the title —
# truncating it and fabricating an attendee from its tail, silently.
# Titles and attendee names cannot contain tabs, so the tab split below is
# collision-proof. The RENDERED output still uses " — " (that is the
# parseMeetingLine contract, and it is safe on the way out: the parser
# takes the leading time match and the LAST trailing "(attendees: ...)",
# so em-dashes inside a rendered title never mis-parse — the collision
# hazard was only in this intermediate property split).
ps_tab="$(printf '|\t|')"

# icalBuddy's own exit status is captured HERE, separately from the
# transform pipe below: under plain `set -eu` (no `pipefail`, and this is
# `sh` — not guaranteed to have it), the exit status of `icalbuddy | awk`
# would be awk's, silently masking an icalBuddy failure (e.g. TCC denial)
# as an empty-but-successful agenda. Capture to a file and check `$?`
# explicitly instead.
if ! LC_ALL=C icalbuddy $ical_args \
  -npn -nc -nrd -b '- ' \
  -iep "datetime,title,attendees" -po "datetime,title,attendees" \
  -ps "$ps_tab" -tf '%H:%M' -df '' \
  eventsFrom:"$d 00:00:00" to:"$d 23:59:59" \
  >"$tmp_ical" 2>&1
then
  cat "$tmp_ical" >&2
  echo "fetch-calendar: icalbuddy exited non-zero (Calendar access denied? System Settings > Privacy & Security > Calendars)" >&2
  exit 1
fi

{
  # Single trailing newline after the heading when the agenda is empty
  # (matches the calendar-day shape's "known: no meetings" file exactly);
  # the awk below prints ONE leading blank line only if there is at least
  # one bullet, so a populated agenda still gets the heading/bullets gap.
  printf -- '---\ntype: calendar-day\ndate: %s\n---\n\n# Calendar %s\n' "$d" "$d"
  awk '
      # icalBuddy emits: "- HH:MM - HH:MM<TAB>Title<TAB>attendee1, attendee2"
      # (tab separator from -ps — collision-proof, see above). Normalize
      # into the parseMeetingLine shape:
      #   "- HH:MM–HH:MM — Title (attendees: a, b)"
      # All-day events arrive with no datetime property at all; pass them
      # through as "- Title" (parser yields time: null).
      BEGIN { first = 1 }
      /^- / {
        if (first) { print ""; first = 0 }
        line = substr($0, 3)
        n = split(line, parts, /\t/)
        time = ""; title = ""; att = ""
        if (parts[1] ~ /^[0-9]{1,2}:[0-9]{2}/) {
          time = parts[1]; title = parts[2]; att = parts[3]
        } else {
          title = parts[1]; att = parts[2]
        }
        gsub(/ - /, "\xe2\x80\x93", time)   # "09:00 - 09:30" -> "09:00–09:30"
        gsub(/^ +| +$/, "", title)
        out = "- "
        if (time != "") out = out time " \xe2\x80\x94 "   # " — "
        out = out title
        if (att != "") out = out " (attendees: " att ")"
        print out
        next
      }
    ' "$tmp_ical"
} > "$tmp"

# ----- VALIDATE (defense-in-depth, NOT the primary gate) -----------------------
# Refuse to commit something that is not a calendar-day file. The heading
# and frontmatter are printf'd deterministically above, so this stage can
# only trip on a broken `awk`/shell on some host — never on bad calendar
# data. The primary gate is the icalbuddy exit check above; keep it that
# way if you edit this template (contract tests exercise the exit gate;
# this stage is pinned by template-text assertions only).
head -n 1 "$tmp" | grep -q '^---$' || {
  echo "fetch-calendar: output is not a calendar-day file (no frontmatter)" >&2
  exit 1
}
grep -q "^date: $d$" "$tmp" || {
  echo "fetch-calendar: output frontmatter does not carry date: $d" >&2
  exit 1
}
grep -q "^# Calendar $d$" "$tmp" || {
  echo "fetch-calendar: output is missing the '# Calendar $d' heading" >&2
  exit 1
}

# ----- LAND (ordinary non-engine commit; the daemon adopts it) ----------------
mv "$tmp" "$f"
rm -f "$tmp_ical"  # $tmp was consumed by the mv; without this the raw
                   # icalBuddy capture would leak once the trap is dropped.
trap - EXIT
land
