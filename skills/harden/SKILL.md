---
name: harden
description: Take any app, any stack, up the forge gates (G1 static, G2 unit, G3 integration + authorisation, G4 external API contracts, G5 security, G6 end-to-end, G8 resilience) and the commit chain PR → gates → staging → e2e → merge → production. Detects which gates the repo has, implements the next one with the right tools for its ecosystem, holds the line on existing findings, writes adversarial tests (wrong user, limits, races, failure halfway), and proves each gate runs in CI. Use when asked to harden, fortify, make production-ready, add tests or security checks, set up CI / PR checks, or "make every PR good" in any project.
---

# Harden

Paths are relative to this SKILL.md: the plugin root is `../..`. The specification is `../../README.md` (gates
G0–G10, manifest, policy, maturity levels); details and tools per ecosystem are in `../../METHODOLOGY.md`.
Read both first.

## Rules that never bend

- **Never change a test, a rule, a threshold or a gate to get green**, and never add `nosemgrep` / skip / ignore
  yourself. Fix the code. If a test or a rule looks wrong, stop and say so (in a repo with agent issues: open an
  `agent:blocked` issue).
- **Protected zones are diagnosis only**: auth, row-level security, migrations, secrets, `.github/**`,
  `harness.toml`, `tests/critical/**`, CODEOWNERS and the harness itself. Explain and propose the fix; do not edit.
- Merging is a human's job. Creating repos, pushing, adding secrets, rulesets or visibility changes are
  outward-facing: ask first.

## 0. Where is the project?

```sh
node ../../stages/check.mjs <repo> --json
```

It reports G1–G6, G8 and the chain as done / partial / missing, with the failing items and `next`. It is a static
heuristic: confirm by reading the CI and running the suite once (know the baseline before changing anything).
Work on the gates of the maturity level the user targets (README section 4), one gate at a time, and report after
each.

## 1. Implement the next gate

Start from `../../templates/.github/workflows/pipeline.yml` (the chain; fill the TODO(harden) lines) and use the
project's own language, package manager and style. Least configuration that meets the gate.

- **G1 static**: formatter, linter, strict types in the G1 job. On an existing repo, hold the line: only new
  findings block; inventory the existing ones (`.harness/baseline.json`) instead of disabling rules.
- **G2 unit**: pure logic with branches (money, units, parsing, permissions, scoring); table-driven tests with
  edge cases, named after the rule they check.
- **G3 integration**: real dependencies in tests and CI (containers / vendor local stack). Map the trust
  boundaries first (every entry point: who may call it, what it touches, its limits) as a "Threat model" section,
  then the adversarial cases below, database policies tested in the database (pgTAP for Postgres RLS), and for
  HTTP apps a `<app>.probe.json` run with `../../probe/probe.mjs`.
- **G4 contracts**: record real responses of each external API (test account), replay them in tests;
  `../../templates/.github/workflows/nightly.yml` contract job checks the live API. Skip without external APIs.
- **G5 security**: the `security`, `sast`, `review` jobs of the template (review on trusted PRs only),
  `../../templates/.github/dependabot.yml`, `../../templates/.gitleaks.toml`, `../../templates/review-rules.md`
  made concrete in CLAUDE.md; DAST in the nightly once a staging URL exists. Run audits and Semgrep locally first;
  high/critical findings are fixed before the gate is enabled; everything else holds the line.
- **G6 end-to-end**: Playwright on the few journeys that matter, against the URL output by the deploy-staging job.
- **G8 resilience**: k6 (`../../templates/load/smoke.k6.js`) and Toxiproxy (latency, cut connections, truncated
  responses) around the declared steady state, in the nightly.

### Adversarial cases (G3 and G5)

- signed out · expired · forged · another user's credentials → refused, **and the victim's data is unchanged**
- IDs/paths escaping the user's scope (encoded `../`, absolute, someone else's nested ID)
- hostile strings stored as data (SQL, HTML/script, unicode, very long), cleaned/capped where the code says so
- each limit at −1 / exact / +1 through **every** write path
- 10+ parallel requests against each invariant (unique, once, under a cap)
- failure halfway: force an error between two writes, assert no orphan
- CSRF-style requests on state-changing routes; forged auth callbacks create no session

Real dependencies for your own systems; mocks only for third-party APIs. Seed state directly (insert a session
row) instead of driving third-party logins.

## 2. When a test goes red

It is a bug, not a test to loosen. Fix the root cause in the shared function every caller routes through, keep
the test, say what it was. If a test passes where you expected a bug (e.g. a race on a single-process local
emulator), say so and whether production differs. Prove the key tests can fail: break the guard, see red.

## 3. Prove the gate in CI

1. Before a first commit: extend `.gitignore` (secrets, `.env*`, local tool logs like `.playwright-mcp/`, build
   output, raw captures) and scan what would be committed for secrets.
2. CI builds from scratch; never rely on prebuilt artefacts.
3. Ruleset: every gate is a required status check, never only the last one (a skipped job counts as passing).
4. Tell the user which secrets/variables to add (`CLAUDE_CODE_OAUTH_TOKEN`, `STAGING_URL`, test-account
   credentials for contract tests).
5. After the CI run, read failures and fix the code. A false positive is reported to the user, who decides.
6. Re-run `node ../../stages/check.mjs <repo>`: the gate must now be `done`.

## 4. Report

- Gates reached, with the checker's before/after.
- Tests added (by class), bugs found and fixed, results with numbers.
- What is not covered and why; what the user must do.
- New lessons → "Lessons" in `../../METHODOLOGY.md`; a missed signal in `stages/check.mjs` → fix the checker and
  its test (in a harness PR, which a human reviews).
