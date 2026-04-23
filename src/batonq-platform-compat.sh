#!/bin/bash
# Shared platform compatibility helpers for batonq bash scripts.
#
# Sourced by agent-coord-loop and agent-coord-loop-watchdog. Functions select
# the right binary / stat flags for the current OS so the bash scripts work
# unchanged on macOS (Darwin) and Linux.
#
# Exports no state; only functions. Safe to source multiple times.

# batonq_timeout_cmd — echo the name of the `timeout` binary to use.
#
# macOS ships without a native `timeout`, so GNU coreutils' `gtimeout` is
# required there (`brew install coreutils`). Linux ships `timeout` as part
# of coreutils by default. We prefer `gtimeout` when it exists on Linux
# too (installable alongside a distro's native `timeout`) so that a user
# with an unusual setup isn't forced into a rename.
batonq_timeout_cmd() {
  case "$(uname 2>/dev/null)" in
    Darwin)
      # gtimeout is the only option on macOS. If it's missing the caller
      # will fail when it tries to exec the returned name; install.sh's
      # check_timeout_cmd is what catches it early.
      echo gtimeout
      ;;
    *)
      # Linux and other Unixes: prefer the native `timeout`, fall back to
      # `gtimeout` if only coreutils-bin-renamed is installed.
      if command -v timeout >/dev/null 2>&1; then
        echo timeout
      else
        echo gtimeout
      fi
      ;;
  esac
}

# batonq_mtime — echo the file mtime in epoch seconds for "$1", or 0 on
# any failure (missing file, unreadable, unknown OS). Zero is the correct
# sentinel for the watchdog's staleness math: a log that doesn't exist
# yet should not trip the stale-kill path.
#
# macOS stat is BSD (-f %m); Linux stat is GNU (-c %Y).
batonq_mtime() {
  f="$1"
  if [ ! -e "$f" ]; then
    echo 0
    return 0
  fi
  case "$(uname 2>/dev/null)" in
    Darwin) stat -f %m "$f" 2>/dev/null || echo 0 ;;
    *)      stat -c %Y "$f" 2>/dev/null || echo 0 ;;
  esac
}
