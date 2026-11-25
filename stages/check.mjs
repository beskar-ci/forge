#!/usr/bin/env node
// Which gates of the chain does this repo have (METHODOLOGY.md)? Static inspection only: files, dependencies, CI.
//   node stages/check.mjs [repo] [--json]
// An item is "ok" when the tool is configured AND (where it matters) runs in CI.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const SKIP = new Set(['node_modules', '.git', 'target', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__',
  '.wrangler', 'vendor', 'coverage', '.turbo', '.vercel', 'pkg']);

// ponytail: walks at most 20k files and reads files under 512 KB; enough for app repos, not monorepo giants.
function walk(root) {
  const out = [], stack = [root];
  while (stack.length && out.length < 20000) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p); else out.push(relative(root, p));
    }
  }
  return out;
}

export function inspect(root) {
  const files = walk(root);
  const read = (f) => { try { return statSync(join(root, f)).size < 512 * 1024 ? readFileSync(join(root, f), 'utf8') : ''; } catch { return ''; } };
  const find = (re) => files.filter(f => re.test(f));
  const has = (re) => files.some(f => re.test(f));
  const grep = (list, re) => list.some(f => re.test(read(f)));

  const ciFiles = find(/^\.github\/workflows\/[^/]+\.ya?ml$|^\.gitlab-ci\.yml$|^\.circleci\/config\.yml$/);
  // Comments and template placeholders are dropped: an unfilled template must not count as a gate.
  const ci = ciFiles.map(read).join('\n').replace(/(^|\s)#.*$/gm, '$1').replace(/^.*echo "replace with.*$/gm, '');
  const inCI = (re) => re.test(ci);
  const pkgs = find(/(^|\/)package\.json$/).map(f => { try { return JSON.parse(read(f)); } catch { return {}; } });
  const deps = new Set(pkgs.flatMap(p => Object.keys({ ...p.dependencies, ...p.devDependencies })));
  const scripts = pkgs.map(p => JSON.stringify(p.scripts ?? {})).join(' ');
  const py = find(/(^|\/)(pyproject\.toml|requirements[^/]*\.txt|setup\.cfg)$/).map(read).join('\n');
  const cargo = find(/(^|\/)Cargo\.toml$/).map(read).join('\n');
  const gomod = find(/(^|\/)go\.mod$/).map(read).join('\n');
  const dep = (re) => [...deps].some(d => re.test(d)) || re.test(py) || re.test(cargo) || re.test(gomod);

  const lang = {
    ts: has(/(^|\/)tsconfig[^/]*\.json$/), js: pkgs.length > 0,
    py: py.length > 0 || has(/\.py$/), rust: cargo.length > 0, go: gomod.length > 0,
  };
  const tests = find(/\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$|(^|\/)tests?\/.*\.(rs|[cm]?[jt]s|py)$/)
    .concat(lang.rust ? find(/\.rs$/).filter(f => /#\[(tokio::)?test\]/.test(read(f))) : []);
  const tsStrict = find(/(^|\/)tsconfig[^/]*\.json$/).some(f => /"strict"\s*:\s*true/.test(read(f)));
  const scheduled = /\bschedule:\s*\n\s*-\s*cron:/.test(ci);

  const item = (name, ok, hint) => ({ name, ok: Boolean(ok), hint });
  // Gates of README section 2 (G0, G7, G9, G10 come with harness.toml and doctor). "chain" checks the pipeline itself:
  // PR → G1 → G2 → G3 → G5 → staging → G6 → merge → production.
  const prodJob = ci.match(/\n(\s+)[\w-]*prod[\w-]*:\n[\s\S]*?(?=\n\1[\w-]+:\n|$)/i)?.[0] ?? '';
  const stages = [
    { n: 'G1', name: 'Static: format, lint, strict types', items: [
      item('formatter configured', has(/(^|\/)(\.prettierrc[^/]*|prettier\.config\.[cm]?[jt]s|biome\.jsonc?|\.?rustfmt\.toml|\.editorconfig)$/)
        || dep(/^(prettier|@biomejs\/biome)$/) || /\[tool\.(black|ruff)/.test(py) || lang.rust || lang.go,
        'Prettier/Biome (JS), Ruff format (Python); rustfmt and gofmt are built in'),
      item('linter configured', has(/(^|\/)(\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s|biome\.jsonc?|\.golangci\.ya?ml|ruff\.toml|\.flake8)$/)
        || dep(/^(eslint|@biomejs\/biome|next)$/) || /\[tool\.(ruff|pylint)/.test(py) || lang.rust,
        'ESLint/Biome, Ruff, clippy, golangci-lint'),
      item('strict type checking', lang.ts ? tsStrict : lang.js ? false : lang.py ? /mypy|pyright/.test(py + ci) || has(/(^|\/)(mypy\.ini|pyrightconfig\.json)$/) : true,
        lang.js && !lang.ts ? 'add TypeScript ("strict": true) or // @ts-check with checkJs' : 'tsconfig "strict": true / mypy or pyright'),
      item('run in CI', inCI(/eslint|biome|\btsc\b|npm run (lint|typecheck|check)|pnpm (run )?(lint|typecheck)|clippy|cargo fmt|prettier|ruff|black|mypy|pyright|golangci|go vet|gofmt/),
        'G1 job of templates/.github/workflows/pipeline.yml'),
    ] },
    { n: 'G2', name: 'Unit tests', items: [
      item('tests exist', tests.length > 0, 'Vitest/Jest, pytest, cargo test, go test'),
      item('run in CI', inCI(/vitest|jest|mocha|node --test|(npm|pnpm|yarn|bun)( run)? test|cargo (test|nextest)|pytest|go test/), 'G2 job of pipeline.yml'),
    ] },
    { n: 'G3', name: 'Integration on real dependencies + authorisation', items: [
      item('CI starts real services', inCI(/\n\s+services:|docker compose|docker-compose|supabase (start|db start|test db)|testcontainers|wrangler dev|localstack|firebase emulators/i)
        || dep(/testcontainers/) || grep(tests, /wrangler',?\s*\[?'?dev|testcontainers|supabase start/),
        'Testcontainers, `supabase start`, docker compose, emulators, `wrangler dev` in the test run'),
      item('authorisation tested', has(/(^|\/)supabase\/tests\/.*\.sql$|\.probe\.json$/)
        || grep(tests, /\b(401|403)\b|forbidden|unauthori[sz]ed|other user|another user|wrong user|row level|\brls\b/i),
        'wrong-user / signed-out tests (pgTAP for RLS, probe/ for HTTP)'),
    ] },
    { n: 'G4', name: 'External API contracts', items: [
      item('external APIs mocked + contract-checked', (dep(/^(msw|nock|@pollyjs\/core)$|vcrpy|respx|responses|wiremock|httpmock|mockito|gock/)
        || has(/(^|\/)(cassettes|recordings|__recordings__)\//)) && scheduled && /run:[^\n]*contract/i.test(ci),
        'recorded responses in tests + nightly contract job (templates/.github/workflows/nightly.yml); n/a without external APIs'),
    ] },
    { n: 'G5', name: 'Security', items: [
      item('secret scan', inCI(/gitleaks|trufflehog|[\w.-]+\/\.github\/workflows\/security\.yml/), 'security.yml (gitleaks)'),
      item('dependency updates', has(/^\.github\/dependabot\.ya?ml$|(^|\/)(renovate\.json5?|\.renovaterc(\.json)?)$/), 'templates/.github/dependabot.yml'),
      item('dependency audit', inCI(/npm audit|pnpm audit|cargo audit|pip-audit|govulncheck|osv-scanner|[\w.-]+\/\.github\/workflows\/security\.yml/), 'security.yml'),
      item('SAST', inCI(/codeql|semgrep|[\w.-]+\/\.github\/workflows\/sast\.yml/), 'sast.yml (Semgrep) or CodeQL'),
      item('AI review', inCI(/claude-code-action|claude-review\.yml/), 'claude-review.yml (trusted PRs only)'),
      item('DAST against staging', scheduled && /zap-baseline|zaproxy|dast\.yml/.test(ci), 'nightly dast job (OWASP ZAP)'),
    ] },
    { n: 'G6', name: 'Staging deploy + end-to-end', items: [
      item('staging deploy in CI', inCI(/environment:\s*['"]?(staging|preview)|deploy[\w-]*staging|--env staging|vercel deploy(?! --prod)/i), 'deploy-staging job of pipeline.yml, outputs the URL'),
      item('browser tests exist', has(/(^|\/)(playwright|cypress)\.config\.[cm]?[jt]s$/) || dep(/^(@playwright\/test|cypress|playwright)$/), 'Playwright'),
      item('e2e runs against the deployment', inCI(/playwright|cypress/) && inCI(/deployment_status|environment_url|BASE_URL|PREVIEW_URL|outputs\.url/), 'G6 job of pipeline.yml (BASE_URL = staging URL)'),
    ] },
    { n: 'G8', name: 'Resilience and load (nightly, staging)', items: [
      item('fault injection + load', scheduled && /toxiproxy|chaos|turmoil/i.test(ci + [...deps].join(' ')) && /k6|locust|artillery/i.test(ci), 'nightly Toxiproxy + k6'),
    ] },
    // Heuristics only (no YAML parser here): at best this gate is "manual", never "done". Verify the real job graph
    // by hand, or with the doctor once it exists.
    { n: 'chain', name: 'Chain + production gate (merge → production)', manual: true, items: [
      item('gates chained', (ci.match(/\n\s+needs:/g) ?? []).length >= 4, 'each job `needs:` the previous one, so a red gate stops the chain'),
      item('production only after e2e on main', /environment:\s*['"]?production/.test(prodJob) && /needs:[^\n]*e2e/.test(prodJob)
        && /refs\/heads\/main/.test(prodJob) && /event_name\s*==\s*'push'/.test(prodJob),
        'deploy-production job: needs the G6 job, runs on push to main, environment production'),
    ] },
  ];
  for (const s of stages) s.status = s.items.every(i => i.ok) ? (s.manual ? 'manual' : 'done') : s.items.some(i => i.ok) ? 'partial' : 'missing';
  const next = stages.find(s => !['done', 'manual'].includes(s.status))?.n ?? null;
  return { repo: basename(root), languages: Object.keys(lang).filter(k => lang[k]), stages, next };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const report = inspect(args.find(a => !a.startsWith('--')) ?? '.');
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.repo} (${report.languages.join(', ') || 'unknown stack'})\n`);
    for (const s of report.stages) {
      console.log(`${{ done: '✔', manual: '?', partial: '◐', missing: '✘' }[s.status]} ${s.n} ${s.name}${s.status === 'manual' ? ' — looks right, verify the job graph by hand' : ''}`);
      for (const i of s.items) console.log(`    ${i.ok ? '✔' : '✘'} ${i.name}${i.ok ? '' : ` — ${i.hint}`}`);
    }
    console.log(`\nNext: ${report.next ?? 'all done'}`);
  }
}
