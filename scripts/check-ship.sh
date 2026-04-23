#!/bin/sh
# check-ship.sh — parse docs/ship-criteria.md and run each SHIP-<id> assert.
#
# Report mode: always exits 0 even when criteria fail. Ship-gating is a
# human decision, not an automated block. The output is designed for a
# human reviewer (or `batonq ship-status`) to scan: one PASS/FAIL line per
# criterion plus a trailing summary with blocker IDs.
#
# Format of each non-comment, non-empty line in the criteria file:
#
#   SHIP-<id> | <name> | <shell-check>
#
# Lines starting with `#` (optionally indented) and blank lines are
# ignored. Lines that don't start with `SHIP-` are also ignored, so the
# markdown prose around the criteria block is safe.

set -u

# ── locate repo root ──────────────────────────────────────────────────────────
# The script lives at scripts/check-ship.sh; repo root is one level up. We
# cd there so every assert runs with a predictable cwd regardless of where
# the caller invoked us from.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || { echo "check-ship: cannot cd to repo root" >&2; exit 0; }

CRITERIA_FILE="${SHIP_CRITERIA_FILE:-$REPO_ROOT/docs/ship-criteria.md}"
PER_CHECK_TIMEOUT="${SHIP_CHECK_TIMEOUT:-60}"

if [ ! -f "$CRITERIA_FILE" ]; then
  echo "check-ship: criteria file not found at $CRITERIA_FILE" >&2
  exit 0
fi

# ── pick a timeout binary ─────────────────────────────────────────────────────
# macOS ships without native `timeout`; GNU coreutils' `gtimeout` covers
# both. Fall back to running the check without a timeout if neither is
# available — we'd rather report a long-running check than refuse to run.
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout"
else
  TIMEOUT_CMD=""
fi

TOTAL=0
PASSED=0
BLOCKERS=""

# ── main loop ─────────────────────────────────────────────────────────────────
# We parse the criteria file line by line. `IFS=` + `-r` preserves leading
# whitespace and backslashes exactly, so the <shell-check> field lands in
# the subshell verbatim.
while IFS= read -r line || [ -n "$line" ]; do
  # strip leading whitespace for the comment/empty check only; the line
  # itself is preserved for field parsing below
  trimmed="$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//')"
  case "$trimmed" in
    ''|'#'*) continue ;;
    SHIP-*) : ;;
    *) continue ;;
  esac

  # Split `SHIP-<id> | <name> | <shell-check>` on the first two ` | `
  # separators. `awk -F' \\| '` is almost right but would split a check
  # that legitimately contains ` | `; we instead find the first two
  # separators by hand via cut-like surgery so the check can contain any
  # pipes it needs. The id must be at least one alphanumeric/`_`/`-`
  # character after `SHIP-`; this guards against the literal
  # `SHIP-<id>` placeholder that appears in the "How to read a row"
  # example block of ship-criteria.md.
  id="$(printf '%s' "$trimmed" | sed -n 's/^\(SHIP-[A-Za-z0-9_-]\{1,\}\)[[:space:]]*|.*$/\1/p')"
  rest="$(printf '%s' "$trimmed" | sed -n 's/^SHIP-[A-Za-z0-9_-]\{1,\}[[:space:]]*|[[:space:]]*\(.*\)$/\1/p')"
  name="$(printf '%s' "$rest" | sed -n 's/^\([^|]*\)[[:space:]]*|.*$/\1/p' | sed -e 's/[[:space:]]*$//')"
  check="$(printf '%s' "$rest" | sed -n 's/^[^|]*|[[:space:]]*\(.*\)$/\1/p')"

  # Not a real criterion (prose, placeholder, or malformed): skip silently.
  # Real criteria use concrete IDs like SHIP-001; anything else is noise.
  if [ -z "$id" ] || [ -z "$check" ]; then
    continue
  fi

  TOTAL=$((TOTAL + 1))

  # Run the check. stdout/stderr of the check itself are suppressed so
  # the report stays one-line-per-criterion; a failing check that wants
  # to surface detail should write to a tmp file the operator can tail.
  if [ -n "$TIMEOUT_CMD" ]; then
    "$TIMEOUT_CMD" "$PER_CHECK_TIMEOUT" sh -c "$check" >/dev/null 2>&1
  else
    sh -c "$check" >/dev/null 2>&1
  fi
  rc=$?

  if [ "$rc" -eq 0 ]; then
    echo "PASS  $id  $name"
    PASSED=$((PASSED + 1))
  else
    echo "FAIL  $id  $name"
    BLOCKERS="$BLOCKERS $id"
  fi
done < "$CRITERIA_FILE"

# ── summary ───────────────────────────────────────────────────────────────────
echo ""
if [ -z "$BLOCKERS" ]; then
  echo "$PASSED/$TOTAL criteria passing. Blockers: none"
else
  # trim leading space from BLOCKERS for a tidy comma-separated list
  blockers_fmt="$(printf '%s' "$BLOCKERS" | sed -e 's/^[[:space:]]*//' -e 's/  */, /g')"
  echo "$PASSED/$TOTAL criteria passing. Blockers: $blockers_fmt"
fi

exit 0
