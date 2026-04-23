#!/bin/sh
# shellcheck shell=bash
# batonq uninstaller — mirror of install.sh that removes what install.sh added.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Salberg87/batonq/main/uninstall.sh | sh
#   batonq uninstall                                   # via subcommand
#   ./uninstall.sh [--remove-state|--keep-state]       # from a checkout
#
# What it does:
#   1. Removes binaries in ~/.local/bin/batonq* and ~/bin/batonq* (whichever exist).
#   2. Strips the three batonq-hook / agent-coord-hook entries from
#      ~/.claude/settings.json (jq-merge, leaves unrelated hooks untouched).
#   3. Asks interactively whether to remove state (~/.claude/batonq-state.db,
#      ~/.claude/batonq-measurement/, ~/.claude/batonq-fingerprint.json).
#      Default is NO — data is preserved for a future reinstall.
#
# Flags:
#   --remove-state   delete state without prompting
#   --keep-state     keep state without prompting
#   --yes, -y        alias for --remove-state
#
# Env:
#   BATONQ_UNINSTALL_REMOVE_STATE=1   same as --remove-state
#   BATONQ_UNINSTALL_KEEP_STATE=1     same as --keep-state

set -eu

NAME="batonq"
CLAUDE_DIR="${HOME}/.claude"
SETTINGS="${CLAUDE_DIR}/settings.json"
STATE_DB="${CLAUDE_DIR}/${NAME}-state.db"
MEASUREMENT_DIR="${CLAUDE_DIR}/${NAME}-measurement"
FINGERPRINT="${CLAUDE_DIR}/${NAME}-fingerprint.json"

# ── Pretty output ─────────────────────────────────────────────────────────────

info()  { printf '\033[0;34m==>\033[0m %s\n' "$*"; }
ok()    { printf '\033[0;32m✔\033[0m %s\n'  "$*"; }
warn()  { printf '\033[0;33m⚠\033[0m %s\n'  "$*" >&2; }
fail()  { printf '\033[0;31m✖ %s\033[0m\n'  "$*" >&2; exit 1; }

# ── Flag parsing ──────────────────────────────────────────────────────────────

STATE_ACTION=""   # "" = ask, "remove" = delete, "keep" = preserve
for arg in "$@"; do
  case "$arg" in
    --remove-state|-y|--yes) STATE_ACTION="remove" ;;
    --keep-state)            STATE_ACTION="keep" ;;
    -h|--help)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) warn "unknown flag: $arg (ignored)" ;;
  esac
done

if [ -z "${STATE_ACTION}" ]; then
  if [ "${BATONQ_UNINSTALL_REMOVE_STATE:-}" = "1" ]; then
    STATE_ACTION="remove"
  elif [ "${BATONQ_UNINSTALL_KEEP_STATE:-}" = "1" ]; then
    STATE_ACTION="keep"
  fi
fi

# ── Step 1: remove binaries ───────────────────────────────────────────────────

remove_bins() {
  removed_any=0
  for bindir in "${HOME}/.local/bin" "${HOME}/bin"; do
    [ -d "${bindir}" ] || continue
    # Match batonq, batonq-hook, batonq-loop, batonq-loop-watchdog, batonq-tui.
    for f in "${bindir}/${NAME}" "${bindir}/${NAME}-hook" "${bindir}/${NAME}-loop" "${bindir}/${NAME}-loop-watchdog" "${bindir}/${NAME}-tui"; do
      if [ -e "${f}" ] || [ -L "${f}" ]; then
        rm -f "${f}"
        ok "removed ${f}"
        removed_any=1
      fi
    done
  done
  if [ "${removed_any}" -eq 0 ]; then
    info "no batonq binaries found in ~/.local/bin or ~/bin"
  fi
}

# ── Step 2: strip hooks from settings.json ────────────────────────────────────

strip_hooks() {
  if [ ! -f "${SETTINGS}" ]; then
    info "no settings.json at ${SETTINGS} — nothing to strip"
    return 0
  fi

  if ! command -v jq >/dev/null 2>&1; then
    cat >&2 <<EOF
⚠ jq not found — cannot safely strip hooks from ${SETTINGS}.

Install jq (brew install jq / sudo apt-get install -y jq) and re-run, or
manually remove any PreToolUse/PostToolUse entries whose .command contains
"batonq-hook" or "agent-coord-hook".
EOF
    return 0
  fi

  tmp="${SETTINGS}.tmp.$$"
  # Mirror install.sh's "is_baton" predicate exactly — same tokens, so we strip
  # every entry install.sh would replace. Keep unrelated hooks intact.
  jq '
    def is_baton: (.hooks // []) | any(
      (.command // "") | test("batonq-hook|agent-coord-hook")
    );
    if .hooks then
      .hooks.PreToolUse  = ((.hooks.PreToolUse  // []) | map(select(is_baton | not)))
      | .hooks.PostToolUse = ((.hooks.PostToolUse // []) | map(select(is_baton | not)))
      | if ((.hooks.PreToolUse  // []) | length) == 0 then del(.hooks.PreToolUse)  else . end
      | if ((.hooks.PostToolUse // []) | length) == 0 then del(.hooks.PostToolUse) else . end
      | if (.hooks | length) == 0 then del(.hooks) else . end
    else . end
  ' "${SETTINGS}" > "${tmp}" \
    || { rm -f "${tmp}"; fail "failed to rewrite settings.json — original left untouched."; }

  if cmp -s "${SETTINGS}" "${tmp}"; then
    rm -f "${tmp}"
    info "no batonq hook entries in ${SETTINGS}"
  else
    mv "${tmp}" "${SETTINGS}"
    ok "stripped batonq hooks from ${SETTINGS}"
  fi
}

# ── Step 3: optionally remove state ───────────────────────────────────────────

any_state_exists() {
  [ -e "${STATE_DB}" ] || [ -e "${MEASUREMENT_DIR}" ] || [ -e "${FINGERPRINT}" ]
}

prompt_state() {
  # Default is NO — data stays put so a reinstall picks up where the user left
  # off. Only explicit 'y'/'yes' deletes.
  if ! any_state_exists; then
    info "no state files to remove"
    STATE_ACTION="keep"
    return
  fi

  if [ ! -t 0 ]; then
    # Non-interactive (piped, test, CI) → safest default is keep.
    info "non-interactive stdin — keeping state (re-run with --remove-state to delete)"
    STATE_ACTION="keep"
    return
  fi

  printf '\n'
  printf 'Remove state data? This deletes:\n'
  [ -e "${STATE_DB}" ]        && printf '  - %s\n' "${STATE_DB}"
  [ -e "${MEASUREMENT_DIR}" ] && printf '  - %s\n' "${MEASUREMENT_DIR}"
  [ -e "${FINGERPRINT}" ]     && printf '  - %s\n' "${FINGERPRINT}"
  printf 'Remove? [y/N] '
  REPLY=""
  read -r REPLY || REPLY=""
  case "${REPLY}" in
    [Yy]|[Yy][Ee][Ss]) STATE_ACTION="remove" ;;
    *) STATE_ACTION="keep" ;;
  esac
}

remove_state() {
  [ -e "${STATE_DB}" ]        && rm -f  "${STATE_DB}"        && ok "removed ${STATE_DB}"
  [ -e "${MEASUREMENT_DIR}" ] && rm -rf "${MEASUREMENT_DIR}" && ok "removed ${MEASUREMENT_DIR}"
  [ -e "${FINGERPRINT}" ]     && rm -f  "${FINGERPRINT}"     && ok "removed ${FINGERPRINT}"
  return 0
}

# ── Main ──────────────────────────────────────────────────────────────────────

main() {
  info "Uninstalling ${NAME}"
  remove_bins
  strip_hooks

  if [ -z "${STATE_ACTION}" ]; then
    prompt_state
  fi

  case "${STATE_ACTION}" in
    remove) remove_state ;;
    keep)   info "state preserved at ${CLAUDE_DIR}/${NAME}-*" ;;
  esac

  printf '\n'
  ok "${NAME} uninstalled."
  cat <<EOF

If you kept state, reinstalling picks up where you left off:
  curl -fsSL https://raw.githubusercontent.com/Salberg87/batonq/main/install.sh | sh

To remove state later:
  rm -f  ${STATE_DB} ${FINGERPRINT}
  rm -rf ${MEASUREMENT_DIR}

Restart Claude Code so it re-reads ${SETTINGS}.
EOF
}

main "$@"
