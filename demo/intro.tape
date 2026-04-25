# batonq — anti-cheat walkthrough
#
# 35s walkthrough: add → pick → try to cheat → do the work → gates prove it.
# Regenerate with:  bash demo/build-demo.sh
#
# This tape assumes build-demo.sh has already set up /tmp/batonq-demo and
# pointed HOME / PATH at the isolated sandbox before invoking vhs.

Output intro.gif
Output intro.mp4

Require batonq
Require git

Set Shell "bash"
Set FontSize 16
Set Width 1280
Set Height 720
Set Padding 24
Set TypingSpeed 35ms
Set PlaybackSpeed 1.0
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
Set WindowBarSize 40

# ── setup (hidden) ────────────────────────────────────────────────────────
Hide
Type `export PS1='$ '`
Enter
Type `cd /tmp/batonq-demo/work`
Enter
Type `clear`
Enter
Show

Sleep 800ms

# ── 1. queue a task (verify + judge required) ─────────────────────────────
Type `batonq add --body 'add release notes for v0.1.1' --verify 'grep -q v0.1.1 NOTES.md' --judge 'does the diff add a v0.1.1 release-notes line?'`
Sleep 400ms
Enter
Sleep 1800ms

Type `batonq tasks`
Sleep 200ms
Enter
Sleep 2200ms

# ── 2. agent claims it ────────────────────────────────────────────────────
Type `batonq pick`
Sleep 200ms
Enter
Sleep 2200ms

# ── 3. agent tries to cheat the gate ──────────────────────────────────────
Type `batonq done --skip-verify`
Sleep 300ms
Enter
Sleep 2800ms

# ── 4. agent does the real work ───────────────────────────────────────────
Type `echo '- v0.1.1: release notes' >> NOTES.md`
Sleep 150ms
Enter
Sleep 500ms
Type `git commit -aq -m 'notes'`
Sleep 150ms
Enter
Sleep 800ms

# ── 5. done — gates run, both pass ────────────────────────────────────────
Type `batonq done`
Sleep 300ms
Enter
Sleep 4500ms

# ── 6. TUI shows the ✓V ✓J receipt ────────────────────────────────────────
Type `batonq tui`
Sleep 200ms
Enter
Sleep 5500ms
Type "q"
Sleep 800ms

# ── 7. closing frame ──────────────────────────────────────────────────────
Hide
Type "clear"
Enter
Show
Type@70ms "# anti-cheat that actually holds."
Sleep 2500ms
