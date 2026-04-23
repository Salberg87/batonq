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

# ── Step 4a: compile self-contained binaries with `bun build --compile` ──────
#
# Why this exists: agent-coord and agent-coord-hook are bun scripts that
# `import { ... } from "./logs-core"`, `./loop-status`, `./tasks-core`, etc.
# The pre-fix installer simply `cp`'d src/agent-coord to bindir/batonq, so the
# moment the binary tried to resolve a sibling import it crashed with
# "Cannot find module './loop-status'". `bun build --compile` bundles every
# transitive import into a single self-contained executable, so the installed
# binary has zero filesystem deps.
#
# Subtlety the bundler doesn't tell you about: files without a .ts/.js/.tsx
# extension are treated as opaque ASSETS — copied verbatim and represented in
# the bundle as a 125-byte stub that just exports the asset path. The result
# is a "compiled" binary that produces zero output. We rename the
# extensionless entry-point files to .ts in a build dir before invoking the
# bundler so they are treated as TypeScript modules.
#
# Returns 0 on success, 1 if any compile step fails (caller falls back to
# install_source_fallback).

compile_bins() {
  build_dir="${TMP_DIR}/build"
  dist_dir="${TMP_DIR}/dist"
  rm -rf "${build_dir}" "${dist_dir}"
  mkdir -p "${build_dir}" "${dist_dir}"

  cp "${TMP_DIR}/src/"*.ts "${build_dir}/" 2>/dev/null || :
  cp "${TMP_DIR}/src/"*.tsx "${build_dir}/" 2>/dev/null || :
  cp "${TMP_DIR}/src/agent-coord"      "${build_dir}/agent-coord.ts" \
    || { warn "src/agent-coord missing"; return 1; }
  cp "${TMP_DIR}/src/agent-coord-hook" "${build_dir}/agent-coord-hook.ts" \
    || { warn "src/agent-coord-hook missing"; return 1; }

  info "Installing build deps (bun install)"
  ( cd "${TMP_DIR}" && bun install --silent ) >/dev/null 2>&1 \
    || { warn "bun install failed"; return 1; }

  for entry in agent-coord agent-coord-hook; do
    info "Compiling ${entry} → dist/${entry}"
    if ! ( cd "${TMP_DIR}" && bun build --compile --target=bun \
             "build/${entry}.ts" \
             --outfile "${dist_dir}/${entry}" ) >/dev/null 2>&1; then
      warn "bun build --compile failed for ${entry}"
      return 1
    fi
  done
  ok "Compiled self-contained binaries in ${dist_dir}"
  return 0
}

# ── Step 4b: install binaries ────────────────────────────────────────────────

install_bins() {
  bindir="$1"
  mkdir -p "${bindir}"

  src="${TMP_DIR}/src"
  [ -d "${src}" ] || fail "Expected ${src} after clone, but it does not exist."

  install_one() {
    from="$1"; to="$2"
    [ -f "${from}" ] || fail "Missing source file: ${from}"
    cp -f "${from}" "${to}"
    chmod +x "${to}"
    ok "Installed ${to}"
  }

  # Try the compile path first; on any failure, fall back to a source install
  # with thin wrappers so users still get a working install on hosts where
  # `bun build --compile` is broken (e.g. ancient bun, exotic arch).
  # ALWAYS overwrite — on upgrades users routinely end up with stale binaries
  # at the legacy `agent-coord` name pointing at old DB paths. Refusing to
  # overwrite would re-create the three-DBs-in-one-dir bug the rename fixed.
  if compile_bins; then
    dist="${TMP_DIR}/dist"
    install_one "${dist}/agent-coord"      "${bindir}/${NAME}"
    install_one "${dist}/agent-coord-hook" "${bindir}/${NAME}-hook"
    # Legacy-name aliases (see install_source_fallback for the same set).
    install_one "${dist}/agent-coord"      "${bindir}/agent-coord"
    install_one "${dist}/agent-coord-hook" "${bindir}/agent-coord-hook"
  else
    install_source_fallback "${bindir}"
  fi

  # Bash scripts are loaders, not bun scripts — copy as-is regardless of which
  # path was taken above. They have no JS deps to bundle.
  install_one "${src}/agent-coord-loop"          "${bindir}/${NAME}-loop"
  install_one "${src}/agent-coord-loop-watchdog" "${bindir}/${NAME}-loop-watchdog"
  install_one "${src}/agent-coord-loop"          "${bindir}/agent-coord-loop"
}

# Fallback: copy the entire src/ tree into ~/.local/share/batonq/src/ and
# write thin shell wrappers in bindir that exec `bun` against the source file.
# Slower at startup (bun re-parses on every invocation) but functionally
# identical — and it dodges every "asset bundling" trap of the compile path.
install_source_fallback() {
  bindir="$1"
  share_dir="${HOME}/.local/share/${NAME}"
  warn "Using source-fallback install (compile failed). Slower but equivalent."
  rm -rf "${share_dir}"
  mkdir -p "${share_dir}"
  cp -R "${TMP_DIR}/src" "${share_dir}/src"
  [ -f "${TMP_DIR}/package.json" ] && cp "${TMP_DIR}/package.json" "${share_dir}/"
  [ -d "${TMP_DIR}/node_modules" ] && cp -R "${TMP_DIR}/node_modules" "${share_dir}/" 2>/dev/null || :

  write_wrapper() {
    target="$1"; src_name="$2"
    cat > "${target}" <<EOF
#!/bin/sh
# batonq thin wrapper (source-fallback install). The compiled binary path
# failed during install; this wrapper execs bun against the source file.
exec bun "${share_dir}/src/${src_name}" "\$@"
EOF
    chmod +x "${target}"
    ok "Wrote wrapper ${target}"
  }

  write_wrapper "${bindir}/${NAME}"           "agent-coord"
  write_wrapper "${bindir}/${NAME}-hook"      "agent-coord-hook"
  write_wrapper "${bindir}/agent-coord"       "agent-coord"
  write_wrapper "${bindir}/agent-coord-hook"  "agent-coord-hook"
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

# ── Step 6b: migrate legacy TASKS.md to DB ────────────────────────────────────
#
# TASKS.md used to be the authoritative task queue. Since arch-2 the DB is
# the truth, and pick / done / tasks / enrich no longer auto-sync from the
# file. Without an explicit migration step, any pending entries that only
# live in TASKS.md would be silently invisible after the upgrade. `batonq
# import` is idempotent (insert-new semantics; duplicates skipped), so
# re-running it on every install is safe.

migrate_legacy_tasks_md() {
  bindir="$1"
  tasks_md="${HOME}/DEV/TASKS.md"
  if [ ! -f "${tasks_md}" ]; then
    return 0
  fi
  if ! grep -qE '^- \[ \]' "${tasks_md}"; then
    ok "TASKS.md has no pending entries — nothing to migrate."
    return 0
  fi
  info "Migrating pending entries from ${tasks_md} into the DB (idempotent)…"
  if "${bindir}/${NAME}" import "${tasks_md}" 2>&1 | sed 's/^/    /'; then
    ok "Legacy TASKS.md migrated. The file is now deprecated — use 'batonq add' / 'batonq import' going forward."
  else
    warn "Migration of ${tasks_md} failed. Run it manually: ${NAME} import ${tasks_md}"
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
  migrate_legacy_tasks_md "${bindir}"
  print_success   "${bindir}"
}

main "$@"
