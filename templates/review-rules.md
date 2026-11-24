## Review rules (read by the Claude PR review)

<!-- Paste into CLAUDE.md or AGENTS.md and make each rule concrete for this project:
     name the real files, helpers and test files. Add a rule every time review misses a bug. -->

- Every entry point that touches user data is scoped to the authenticated user; a new one needs signed-out
  and wrong-user tests in <test file>.
- Limits (size, count, rate, money) hold on every write path and under parallel requests; prefer one atomic
  statement or a database constraint over "check, then write".
- A failure halfway leaves no orphans or half-saved state.
- User-supplied URLs and paths go through <validation helper>; never fetched or opened directly.
- Every bug fix comes with a test that failed before the fix.
- Never commit <secret files>, local logs or raw third-party captures.
