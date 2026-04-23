#!/bin/sh
# test-install.sh — end-to-end installer smoke tests.
#
# What this guards against: the original install.sh `cp`'d src/agent-coord as
# a single file to ${HOME}/.local/bin/batonq. agent-coord imports siblings via
# `require("./loop-status")` and `require("./logs-core")`, which crash with
# "Cannot find module" the moment the installed binary is invoked. The fix
# uses `bun build --compile` to bundle every transitive dep into a self-
# contained executable. This script exercises the install end-to-end against
# a fake $HOME and asserts:
#
#   1. compile path: `batonq status` exits without "Cannot find module"
#   2. compile path: `batonq --version` prints "batonq v<semver>" — i.e. the
#      version is embedded in the binary, not "vunknown"
#   3. fallback path: same assertions hold when bun build --compile fails
#      and install_source_fallback writes thin wrappers
#
# Run from repo root: sh tests/test-install.sh

set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_SH="${REPO_ROOT}/install.sh"
PASS=0
FAIL=0

red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }

assert_no_module_err() {
  label="$1"; output="$2"
  case "${output}" in
    *"Cannot find module"*)
      red   "  ✗ ${label}: 'Cannot find module' present in output"
      printf '    %s\n' "${output}" | head -5
      FAIL=$((FAIL + 1))
      ;;
    *)
      green "  ✔ ${label}: no 'Cannot find module' in output"
      PASS=$((PASS + 1))
      ;;
  esac
}

assert_version_format() {
  label="$1"; output="$2"
  # Accept "batonq vX.Y.Z" or "batonq vX.Y.Z (commit ...)". Reject "vunknown".
  case "${output}" in
    *"vunknown"*)
      red   "  ✗ ${label}: version printed as 'vunknown' — package.json wasn't embedded"
      FAIL=$((FAIL + 1))
      ;;
    "batonq v"[0-9]*)
      green "  ✔ ${label}: version output looks right (${output})"
      PASS=$((PASS + 1))
      ;;
    *)
      red   "  ✗ ${label}: unexpected version output: '${output}'"
      FAIL=$((FAIL + 1))
      ;;
  esac
}

# Build a runnable patched install.sh that:
#   - sources the real install.sh up to (but not including) `main "$@"`
#   - overrides clone_repo / check_bun / check_gtimeout / detect_bindir /
#     merge_settings so the test doesn't depend on network or host tools
#   - optionally overrides compile_bins (set FORCE_FALLBACK=1) to exercise
#     the source-fallback path
#   - then calls main
build_patched_installer() {
  bindir="$1"; out="$2"; force_fallback="${3:-0}"
  body=$(awk '/^main "\$@"$/{exit}{print}' "${INSTALL_SH}")
  cat > "${out}" <<EOF
#!/bin/sh
set -eu
${body}
clone_repo() { TMP_DIR="${REPO_ROOT}"; ok "Using local repo \$TMP_DIR"; }
check_bun() { :; }
check_gtimeout() { :; }
detect_bindir() { echo "${bindir}"; }
merge_settings() { :; }
EOF
  if [ "${force_fallback}" = "1" ]; then
    echo 'compile_bins() { warn "Forced compile failure for test"; return 1; }' \
      >> "${out}"
  fi
  echo 'main' >> "${out}"
  chmod +x "${out}"
}

run_scenario() {
  scenario="$1"; force_fallback="$2"
  yellow "── scenario: ${scenario} ─────────────────────────────────"

  fake_home=$(mktemp -d -t batonq-test-install.XXXXXX)
  bindir="${fake_home}/bin"
  mkdir -p "${bindir}" "${fake_home}/.claude"
  patched="${fake_home}/install-patched.sh"

  build_patched_installer "${bindir}" "${patched}" "${force_fallback}"

  # Run the installer. Discard install output unless it fails (debug).
  install_log="${fake_home}/install.log"
  if ! HOME="${fake_home}" PATH="${bindir}:${PATH}" \
       sh "${patched}" > "${install_log}" 2>&1; then
    red "  ✗ installer exited non-zero — log:"
    sed 's/^/    /' "${install_log}" | head -30
    FAIL=$((FAIL + 1))
    rm -rf "${fake_home}"
    return
  fi

  # `batonq` and `batonq-hook` must exist and be executable.
  for bin in batonq batonq-hook agent-coord agent-coord-hook \
             batonq-loop batonq-loop-watchdog; do
    if [ ! -x "${bindir}/${bin}" ]; then
      red "  ✗ ${bin} not installed at ${bindir}/${bin}"
      FAIL=$((FAIL + 1))
      rm -rf "${fake_home}"
      return
    fi
  done
  green "  ✔ all expected binaries installed"
  PASS=$((PASS + 1))

  # Test 1: status must run cleanly. Capture combined stdout+stderr.
  status_out=$(HOME="${fake_home}" "${bindir}/batonq" status 2>&1 || true)
  assert_no_module_err "batonq status" "${status_out}"

  # Test 2: --version must print a real semver, not "vunknown".
  version_out=$(HOME="${fake_home}" "${bindir}/batonq" --version 2>&1 || true)
  # collapse to first line only
  version_first=$(printf '%s\n' "${version_out}" | head -1)
  assert_version_format "batonq --version" "${version_first}"
  assert_no_module_err "batonq --version" "${version_out}"

  # Bonus: the legacy `agent-coord` alias must also work.
  alias_out=$(HOME="${fake_home}" "${bindir}/agent-coord" status 2>&1 || true)
  assert_no_module_err "agent-coord status (legacy alias)" "${alias_out}"

  rm -rf "${fake_home}"
}

run_scenario "compile path (bun build --compile)" 0
run_scenario "source-fallback path"               1

echo
if [ "${FAIL}" -eq 0 ]; then
  green "All ${PASS} assertions passed."
  exit 0
fi
red "${FAIL} assertions failed (${PASS} passed)."
exit 1
