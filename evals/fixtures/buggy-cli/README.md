# buggy-cli

Tiny Node.js todo CLI used as the shared fixture for batonq eval tasks. It
contains several intentional bugs across files. Each eval task prompts the
agent to fix exactly one of them; the `verify_cmd` runs a targeted node test.

Do not use for anything else. Fixture is copied fresh into a tmpdir per run.
