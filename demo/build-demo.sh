#!/usr/bin/env bash
# Regenerate demo/intro.gif and demo/intro.mp4 from demo/intro.tape.
#
# Isolates state under /tmp/batonq-demo so the recording is hermetic:
#   /tmp/batonq-demo/home  →  HOME for the recorded shell (fresh ~/.claude/batonq)
#   /tmp/batonq-demo/work  →  git repo the agent "works in"
#
# Mocks `claude` with a stub that always returns PASS, so the judge gate is
# reproducible offline (no API key, no network).
#
# Requires: vhs (charmbracelet), bun, git.
# Run from anywhere — resolves paths relative to this script.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEMO_ROOT="/tmp/batonq-demo"
DEMO_HOME="$DEMO_ROOT/home"
DEMO_WORK="$DEMO_ROOT/work"

if ! command -v vhs >/dev/null 2>&1; then
  echo "vhs not found. Install: brew install vhs   (or see https://github.com/charmbracelet/vhs)" >&2
  exit 127
fi

rm -rf "$DEMO_ROOT"
mkdir -p "$DEMO_HOME/.claude/batonq" "$DEMO_HOME/.local/bin" "$DEMO_HOME/DEV" "$DEMO_WORK"

# batonq's TASKS.md mirror lives at $HOME/DEV/TASKS.md; rewriteMdTaskStatus
# acquires a .lock in the same dir before each status flip, so the parent
# must exist even when we never intend to sync the file.
printf '## Pending\n\n' > "$DEMO_HOME/DEV/TASKS.md"

# Stub `claude` for the judge gate — prints PASS, exit 0. Keeps the demo
# hermetic (no API key, no network, identical output every run).
cat > "$DEMO_HOME/.local/bin/claude" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
echo "PASS"
echo "Diff adds the release-notes line the task asked for. Looks good."
exit 0
EOF
chmod +x "$DEMO_HOME/.local/bin/claude"

# Seed a git repo so batonq's judge gate has a diff to inspect.
(
  cd "$DEMO_WORK"
  git init -q -b main
  git config user.email "demo@batonq.dev"
  git config user.name  "batonq demo"
  printf '# project NOTES\n\n' > NOTES.md
  git add NOTES.md
  git commit -q -m "init"
)

export HOME="$DEMO_HOME"
export PATH="$DEMO_HOME/.local/bin:$REPO_ROOT/bin:$PATH"
export TERM=xterm-256color

# batonq's TUI tails /tmp/agent-coord-loop-*.log via a hardcoded glob
# (live-feed.ts), so an unrelated batonq-loop on the same host would bleed
# into the recording. Stash any matches into a scratch dir while vhs runs
# and restore them afterwards — the rename doesn't disturb open fds, so the
# upstream loop keeps appending to its inode uninterrupted.
STASH="$DEMO_ROOT/stash"
mkdir -p "$STASH"
shopt -s nullglob
stashed=()
for f in /tmp/agent-coord-loop-*.log /tmp/batonq-loop.log; do
  [[ -e "$f" ]] || continue
  mv "$f" "$STASH/"
  stashed+=("$(basename "$f")")
done
shopt -u nullglob

restore_logs() {
  for name in "${stashed[@]:-}"; do
    if [[ -n "$name" && -e "$STASH/$name" ]]; then
      mv "$STASH/$name" /tmp/ || true
    fi
  done
}
trap restore_logs EXIT

cd "$SCRIPT_DIR"
vhs intro.tape

echo
echo "Generated: $SCRIPT_DIR/intro.gif"
echo "Generated: $SCRIPT_DIR/intro.mp4"
