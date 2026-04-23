#!/bin/sh
# shellcheck shell=bash
# batonq installer — curl-pipeable one-shot installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Salberg87/batonq/main/install.sh | sh
#
# What it does:
#   1. Verifies bun is on PATH.
#   2. Clones the repo to /tmp/batonq-install/.
#   3. Installs the three CLI entry points to ~/.local/bin/ or ~/bin/
#      (whichever is already on PATH, prefer ~/.local/bin).
#   4. Merges Claude Code hooks into ~/.claude/settings.json (requires jq).
#   5. Creates ~/.claude/ (for state.db) and ~/.claude/batonq-measurement/.
#   6. Prints next steps.

set -euo pipefail

NAME="batonq"
REPO_URL="https://github.com/Salberg87/${NAME}.git"
BRANCH="main"
TMP_DIR="/tmp/${NAME}-install"
CLAUDE_DIR="${HOME}/.claude"
SETTINGS="${CLAUDE_DIR}/settings.json"
MEASUREMENT_DIR="${CLAUDE_DIR}/batonq-measurement"
STATE_DIR="${CLAUDE_DIR}/batonq"
STATE_DB="${STATE_DIR}/state.db"
LEGACY_DBS="${CLAUDE_DIR}/agent-coord-state.db ${CLAUDE_DIR}/batonq-state.db"

# ── Pretty output ─────────────────────────────────────────────────────────────

info()  { printf '\033[0;34m==>\033[0m %s\n' "$*"; }
ok()    { printf '\033[0;32m✔\033[0m %s\n'  "$*"; }
warn()  { printf '\033[0;33m⚠\033[0m %s\n'  "$*" >&2; }
fail()  { printf '\033[0;31m✖ %s\033[0m\n'  "$*" >&2; exit 1; }

# ── Step 1: bun ───────────────────────────────────────────────────────────────

check_bun() {
  if command -v bun >/dev/null 2>&1; then
    ok "bun $(bun --version) found"
    return 0
  fi
  cat >&2 <<'EOF'
✖ bun is required but not installed.

Install bun, then re-run this script:

  curl -fsSL https://bun.sh/install | bash

After installing, restart your shell (or `source ~/.zshrc` / `~/.bashrc`) so
bun is on PATH, then re-run the batonq installer.
EOF
  exit 1
}

# ── Step 1b: gtimeout (required by batonq-loop) ───────────────────────────────

check_gtimeout() {
  if command -v gtimeout >/dev/null 2>&1; then
    ok "gtimeout found ($(command -v gtimeout))"
    return 0
  fi
  cat >&2 <<'EOF'
✖ gtimeout is required by batonq-loop but not installed.

batonq-loop wraps each `claude -p` invocation in `gtimeout` so a stuck task
can't wedge the loop indefinitely. macOS ships without a `timeout` binary,
so the loop uses `gtimeout` from GNU coreutils on both macOS and Linux for
a single code path.

On macOS:

  brew install coreutils

On Debian/Ubuntu:

  sudo apt-get install -y coreutils

Then re-run this installer.
EOF
  exit 1
}

# ── Step 2: detect bin dir ────────────────────────────────────────────────────

detect_bindir() {
  # Prefer ~/.local/bin, fall back to ~/bin. Must already be on PATH.
  case ":${PATH}:" in
    *":${HOME}/.local/bin:"*) echo "${HOME}/.local/bin"; return 0 ;;
  esac
  case ":${PATH}:" in
    *":${HOME}/bin:"*) echo "${HOME}/bin"; return 0 ;;
  esac
  return 1
}

# ── Step 3: clone ─────────────────────────────────────────────────────────────

clone_repo() {
  if [ -d "${TMP_DIR}" ]; then
    info "Removing previous ${TMP_DIR}"
    rm -rf "${TMP_DIR}"
  fi
  info "Cloning ${REPO_URL} → ${TMP_DIR}"
  git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${TMP_DIR}" >/dev/null 2>&1 \
    || fail "git clone failed. Check network and that the repo exists."
  ok "Clone complete"
}

# ── Step 4: install binaries ──────────────────────────────────────────────────

install_bins() {
  bindir="$1"
  mkdir -p "${bindir}"

  src="${TMP_DIR}/src"
  [ -d "${src}" ] || fail "Expected ${src} after clone, but it does not exist."

  # Map src file → installed name (matches README install instructions).
  # We install the src/* scripts directly (they are self-contained bun scripts).
  # ALWAYS overwrite — on upgrades users routinely end up with stale binaries
  # at the legacy `agent-coord` name pointing at old DB paths. Refusing to
  # overwrite would re-create the three-DBs-in-one-dir bug the rename fixed.
  install_one() {
    from="$1"; to="$2"
    [ -f "${from}" ] || fail "Missing source file: ${from}"
    cp -f "${from}" "${to}"
    chmod +x "${to}"
    ok "Installed ${to}"
  }

  install_one "${src}/agent-coord"               "${bindir}/${NAME}"
  install_one "${src}/agent-coord-hook"          "${bindir}/${NAME}-hook"
  install_one "${src}/agent-coord-loop"          "${bindir}/${NAME}-loop"
  install_one "${src}/agent-coord-loop-watchdog" "${bindir}/${NAME}-loop-watchdog"

  # Legacy-name aliases so existing scripts, docs, and muscle memory keep
  # working AND so any stale `agent-coord` binary from a pre-rename install
  # is overwritten to point at the new canonical DB path.
  install_one "${src}/agent-coord"               "${bindir}/agent-coord"
  install_one "${src}/agent-coord-hook"          "${bindir}/agent-coord-hook"
  install_one "${src}/agent-coord-loop"          "${bindir}/agent-coord-loop"
}

# ── Step 5: merge hooks into ~/.claude/settings.json ──────────────────────────

merge_settings() {
  bindir="$1"

  if ! command -v jq >/dev/null 2>&1; then
    cat >&2 <<EOF
✖ jq is required to merge hooks into ${SETTINGS} safely.

Install jq, then re-run this script. On macOS:

  brew install jq

On Debian/Ubuntu:

  sudo apt-get install -y jq

Alternatively, manually add these hook entries to the \`hooks\` block in
${SETTINGS} (under PreToolUse and PostToolUse):

  PreToolUse:
    { "matcher": "Read|Edit|Write|MultiEdit",
      "hooks": [{ "type": "command", "command": "${bindir}/${NAME}-hook pre",  "timeout": 2 }] }
    { "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "${bindir}/${NAME}-hook bash", "timeout": 2 }] }
  PostToolUse:
    { "matcher": "Edit|Write|MultiEdit",
      "hooks": [{ "type": "command", "command": "${bindir}/${NAME}-hook post", "timeout": 2 }] }
EOF
    exit 1
  fi

  mkdir -p "${CLAUDE_DIR}"

  new_config=$(jq -n --arg cmd "${bindir}/${NAME}-hook" '{
    PreToolUse: [
      { matcher: "Read|Edit|Write|MultiEdit",
        hooks: [{ type: "command", command: ($cmd + " pre"),  timeout: 2 }] },
      { matcher: "Bash",
        hooks: [{ type: "command", command: ($cmd + " bash"), timeout: 2 }] }
    ],
    PostToolUse: [
      { matcher: "Edit|Write|MultiEdit",
        hooks: [{ type: "command", command: ($cmd + " post"), timeout: 2 }] }
    ]
  }')

  if [ -f "${SETTINGS}" ]; then
    info "Merging hooks into existing ${SETTINGS}"
    # Strip any prior batonq-hook / agent-coord-hook entries so re-running is idempotent,
    # then append the fresh config.
    tmp="${SETTINGS}.tmp.$$"
    jq --argjson new "${new_config}" '
      def is_baton: (.hooks // []) | any(
        (.command // "") | test("batonq-hook|agent-coord-hook")
      );
      .hooks = (.hooks // {})
      | .hooks.PreToolUse  = (((.hooks.PreToolUse  // []) | map(select(is_baton | not))) + $new.PreToolUse)
      | .hooks.PostToolUse = (((.hooks.PostToolUse // []) | map(select(is_baton | not))) + $new.PostToolUse)
    ' "${SETTINGS}" > "${tmp}" \
      || { rm -f "${tmp}"; fail "Failed to merge settings.json — original left untouched."; }
    mv "${tmp}" "${SETTINGS}"
  else
    info "Creating ${SETTINGS}"
    jq -n --argjson new "${new_config}" '{ hooks: $new }' > "${SETTINGS}"
  fi
  ok "Hooks merged into ${SETTINGS}"
}

# ── Step 6: state dirs ────────────────────────────────────────────────────────

create_state_dirs() {
  # state.db itself is created lazily by the hook on first in-scope tool call,
  # but its parent dir and the append-only measurement dir must exist.
  mkdir -p "${CLAUDE_DIR}"
  chmod 0700 "${CLAUDE_DIR}" 2>/dev/null || :
  mkdir -p "${MEASUREMENT_DIR}"
  chmod 0700 "${MEASUREMENT_DIR}" 2>/dev/null || :
  # Canonical state dir (dir-based so future files live alongside state.db).
  mkdir -p "${STATE_DIR}"
  chmod 0700 "${STATE_DIR}" 2>/dev/null || :
  ok "State directories ready (${CLAUDE_DIR}, ${STATE_DIR}, ${MEASUREMENT_DIR})"
}

# ── Step 6b: post-install DB path consistency ─────────────────────────────────
#
# After binaries are in place, warn loudly if legacy DB files still sit at the
# old flat paths. The binary auto-migrates on next invocation (migrate-path),
# but surfacing it here means the user knows to expect a migration line instead
# of thinking their state got lost.

verify_db_paths() {
  any_legacy=0
  for legacy in ${LEGACY_DBS}; do
    if [ -f "${legacy}" ]; then
      any_legacy=1
      warn "Legacy DB present: ${legacy}"
    fi
  done
  if [ "${any_legacy}" = "1" ]; then
    warn "Canonical target is ${STATE_DB}. Run '${NAME} doctor' after the next tool call — migrate-path will have moved data and backed up originals as *.legacy.bak."
  else
    ok "DB path consistency: no legacy DBs found (canonical: ${STATE_DB})"
  fi
}

# ── Step 7: done ──────────────────────────────────────────────────────────────

print_success() {
  bindir="$1"
  cat <<EOF

\033[0;32m✔ ${NAME} installed.\033[0m

Binaries:
  ${bindir}/${NAME}
  ${bindir}/${NAME}-hook
  ${bindir}/${NAME}-loop

Next steps:

  1. Verify the install:
       ${NAME} doctor

  2. Write your first task to ~/DEV/TASKS.md:
       ## Pending
       - [ ] **any:infra** — describe the task

  3. In any repo under ~/DEV/, start a worker loop:
       cd ~/DEV/YourRepo && ${NAME}-loop

  4. Watch the queue:
       ${NAME} tasks

Claude Code hooks are now wired. Restart Claude Code once for the new hooks
to be picked up. Temporary clone left at ${TMP_DIR} — safe to delete.

EOF
}

# ── Main ──────────────────────────────────────────────────────────────────────

main() {
  info "Installing ${NAME}"

  check_bun
  check_gtimeout

  if ! bindir=$(detect_bindir); then
    fail "Neither ~/.local/bin nor ~/bin is on PATH. Add one to your shell rc and re-run:
    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
  fi
  ok "Install target: ${bindir}"

  command -v git >/dev/null 2>&1 || fail "git is required but not installed."

  clone_repo
  install_bins    "${bindir}"
  merge_settings  "${bindir}"
  create_state_dirs
  verify_db_paths
  print_success   "${bindir}"
}

main "$@"
