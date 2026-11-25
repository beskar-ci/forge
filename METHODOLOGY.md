# Methodology: gate details, tools, lessons

The specification is [`README.md`](README.md) (gates G0–G10, manifest, policy, report, maturity levels). This file
holds the details per gate, the tools per ecosystem and the lessons learned applying it. One rule above all:
**a gate blocks or does not exist** — every enabled gate is a required status check on `main`.

The chain every change goes through (`templates/.github/workflows/pipeline.yml`):

```
commit → PR → [G1 static] → [G2 unit] → [G3 integration] → [G5 security] → staging deploy → [G6 e2e]
       → merge → (same chain on main) → production deploy
nightly, outside the chain: G4 live contract checks · G5 DAST · G7 full mutation · G8 resilience and load
continuously: G10 production (external uptime monitor, heartbeats)
```

`node stages/check.mjs <repo>` reports which of G1–G6, G8 and the chain a repo has (static inspection; G0, G7, G9
and G10 come with `harness.toml` and `harness doctor`).

## Gate by gate

### G0 Repository hygiene (planned)
Ruleset on `main`, CODEOWNERS covering the protected zones, dependencies pinned (actions by SHA, images by
digest), no secret anywhere in the history (gitleaks on the full history, no baseline). OpenSSF Scorecard, Conftest.

### G1 Static
Format, lint, strict types: your "compiler". Holds the line on existing repos: only new findings block, the
existing ones are inventoried in `.harness/baseline.json`, a ratchet that can only go down.

### G2 Unit
Pure logic with many branches: money, units and conversions, parsing, permissions, scoring. Table-driven tests
with edge cases (zero, negative, empty, huge, unicode). Property-based tests for critical rules.

### G3 Integration + authorisation
Run the real database, storage and queues in containers or the vendor's local stack, in CI too. Test every entry
point: happy path + each way it fails. **Prove authorisation at the lowest layer**: row-level policies tested
inside the database (pgTAP), plus HTTP-level checks with `probe/`. Characterisation tests before any refactor.

### G4 External API contracts
Recorded responses replayed in PR tests (deterministic, no network); a **nightly live check** with a test account
opens an `alert:digest` issue when an API changes. Not applicable without external APIs.

### G5 Security
gitleaks · Dependabot (7-day cooldown) · dependency audit · Semgrep holding the line (new findings block;
high/critical block everywhere and are fixed before the gate is enabled; SARIF as an artifact on private repos) ·
Claude review on **trusted PRs only** (not hardened against prompt injection) · OWASP ZAP against staging, nightly ·
`probe` against the preview. Reusable: `security.yml`, `sast.yml`, `dast.yml`, `claude-review.yml`.

### G6 End-to-end
Playwright on the few journeys that matter, against the staging or preview URL produced by the deploy job.

### G7 Mutation (planned)
Stryker · cargo-mutants · mutmut; incremental on PRs, full at night; score as a ratchet on protected zones.

### G8 Resilience and load
Toxiproxy between the app and its database / external APIs (latency, cut connections, truncated responses): the
app degrades cleanly around a declared steady state. k6 thresholds from `[steady_state]`. Nightly, on staging.

### G9 Hidden acceptance (planned)
Tests an agent never sees, run on agent PRs only, from a protected repository.

### G10 Production (planned)
External uptime monitor, alerts on the steady state, a Healthchecks.io heartbeat for every scheduled job.

## Tools by ecosystem

| Gate | JS / TS (Next.js, Node) | Python | Rust | Go |
|---|---|---|---|---|
| G1 static | Prettier or Biome · ESLint · `tsc --noEmit` with `"strict": true` | Ruff (lint + format) · mypy or pyright | rustfmt · clippy `-D warnings` · (compiler) | gofmt · `go vet` · golangci-lint |
| G2 unit | Vitest (or Jest, `node --test`) | pytest (+ Hypothesis) | `cargo test` (+ proptest) | `go test` (+ fuzzing) |
| G3 integration | Testcontainers, vendor CLI (`supabase start`, `wrangler dev`), pgTAP via `supabase test db` | Testcontainers, pytest fixtures | Testcontainers, sqlx test DBs | Testcontainers, `httptest` |
| G4 contracts | MSW, nock | respx, responses, VCR.py | wiremock, httpmock | `httptest`, gock |
| G5 security | npm audit · gitleaks · Semgrep/CodeQL · Dependabot · Claude review · ZAP | pip-audit · same | cargo audit · same | govulncheck · same |
| G6 e2e | Playwright | Playwright (Python) | Playwright (JS) against the app | Playwright (JS) against the app |
| G8 resilience | Toxiproxy · k6 | Toxiproxy · k6/Locust | Toxiproxy · k6 · turmoil | Toxiproxy · k6 |

## Where real bugs come from (what G3, G5 and `probe` must target)

Public AI-review showcases (greptile.com/examples, 37 bugs in large open-source repos, Nov 2026) are dominated
by bugs whose happy path works. By label: security / auth bypass 15, logic / stale state 7, concurrency 5,
data loss / integrity 4, resource leaks 3, limit bypass 2. Write tests for the adversarial case:

| Bug class | Test that catches it |
|---|---|
| Auth bypass, cross-tenant access | every entry point with no / expired / forged / other user's credentials → refused, victim's data unchanged |
| Injection, path traversal, SSRF | hostile strings stored as data; encoded `../` refused; URL allow-lists checked after DNS resolution |
| Limit bypass | limit−1 / limit / limit+1 through **every** write path |
| Concurrency | 10–50 parallel requests against each invariant; fix with constraints or one atomic statement |
| Data loss on failure | force step 2 of 3 to fail; nothing half-written remains |
| Stale state / caches | change, then read back through the cache |
| Resource leaks | repeat many times; watch memory, handles, connections |

## PR rules

- Ruleset on main with every gate required (private repos need GitHub Pro; free with the Student Pack).
- Small PRs (under ~400 lines). Every bug fix ships with a test that failed before the fix.
- Review rules live in CLAUDE.md / AGENTS.md and grow every time review misses a bug.
- Flaky tests are fixed or deleted within a week.

## Lessons from applying this (keep adding)

- A local emulator often runs one process: a race test can pass locally and fail across production instances.
  Make the operation atomic instead of trusting the green test.
- Build scripts that fall back to prebuilt artefacts hide uncompiled changes; CI must build from scratch.
- Scan for secrets **before** the first commit: raw captures, local tool logs (`.playwright-mcp/`), `.env*`.
- High-entropy file names (hashed bundles) trip gitleaks; allowlist the single file, never the rule.
- `cargo update -p x` can read a stale index; `--precise <version>` forces the patched release.
- A repo created and pushed in one command may miss its first workflow run; add `workflow_dispatch`.
- Security headers are easy to forget: probe's first run on a real app found no clickjacking protection.
- GitHub counts a required job that was **skipped** (because an earlier gate failed) as passing: require every
  gate, never only the last one of the chain.
- gitleaks-action needs `pull-requests: read` on PR events, and a licence key as soon as the repo belongs to an
  organisation; the gitleaks CLI (pinned image) needs neither and scans the whole history. A reusable workflow
  only gets the permissions its caller grants.
- Silencing a scanner (`nosemgrep`) to get green is weakening a gate. On this repo the comments were not even
  needed: removed, Semgrep still reported 0 findings. Run the scanner before assuming a suppression is required.
- An editor can turn a `\u202e` escape into the literal invisible character (Trojan Source); Semgrep's bidi rule
  caught it.
- CODEOWNERS rejects a **secret** team ("Unknown owner"): the team must be visible, which in an organisation means
  visible to its members only, not to the public. Check `GET /repos/{owner}/{repo}/codeowners/errors` after every
  change, and only relax approvals once it reports zero errors.
- With 0 general approvals and code-owner review required, "require approval of the most recent push" would still
  demand an approval on every PR; "dismiss stale reviews on push" already covers code pushed after an approval.
- A bot that creates a repository becomes its admin and could edit the ruleset that controls it: downgrade it to
  write. An agent must never test its own controls by trying to disable them.

