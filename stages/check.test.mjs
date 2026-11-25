import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { inspect } from './check.mjs';

const template = (name) => readFileSync(new URL(`../templates/.github/workflows/${name}`, import.meta.url), 'utf8');

function inRepo(files, fn) {
  const root = mkdtempSync(join(tmpdir(), 'stages-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return fn(inspect(root));
  } finally { rmSync(root, { recursive: true }); }
}
const status = (r) => Object.fromEntries(r.stages.map(s => [s.n, s.status]));

// A Next.js + Supabase app with every gate filled in, built from the real templates.
const app = {
  'package.json': JSON.stringify({ devDependencies: { eslint: '9', prettier: '3', typescript: '5', vitest: '3', msw: '2', '@playwright/test': '1' } }),
  'tsconfig.json': '{ "compilerOptions": { "strict": true } }',
  'src/cart.test.ts': 'test("price", () => {})',
  'supabase/tests/rls.test.sql': "select is_empty('select * from carts where user_id <> auth.uid()');",
  'playwright.config.ts': '',
  'load/smoke.k6.js': '',
  '.github/dependabot.yml': '',
};
const filled = template('pipeline.yml')
  .replace('echo "replace with format, lint and type checks" && exit 1', 'npx prettier --check . && npx eslint . && npx tsc --noEmit')
  .replace('echo "replace with unit tests" && exit 1', 'npx vitest run')
  .replace('echo "replace with integration tests on real dependencies" && exit 1', 'supabase start && supabase test db')
  .replace('echo "replace with the staging deploy" && exit 1', 'echo "url=$(npx vercel deploy --token "$T")" >> "$GITHUB_OUTPUT"')
  .replace('echo "replace with the production deploy" && exit 1', 'npx vercel deploy --prod --token "$T"');
const nightly = template('nightly.yml')
  .replace('echo "replace with the contract test command" && exit 1', 'npm run test:contract && docker run -d ghcr.io/shopify/toxiproxy');

test('an empty repo starts at G1', () => inRepo({ 'README.md': '# app' }, (r) => {
  assert.equal(r.next, 'G1');
  assert.ok(r.stages.filter(s => s.n !== 'G1').every(s => s.status === 'missing'));
}));

test('lint, strict TS and unit tests in CI: next gate is G3', () => inRepo({
  ...app,
  '.github/workflows/ci.yml': 'on: pull_request\njobs:\n  t:\n    steps:\n      - run: npx eslint . && npx tsc --noEmit\n      - run: npx vitest run\n',
}, (r) => {
  assert.equal(status(r).G1, 'done');
  assert.equal(status(r).G2, 'done');
  assert.equal(r.next, 'G3');
}));

test('loose TypeScript and tests that never run in CI do not pass', () => inRepo({
  'package.json': JSON.stringify({ devDependencies: { eslint: '9', vitest: '3' } }),
  'tsconfig.json': '{ "compilerOptions": { "strict": false } }',
  'src/a.test.ts': '',
}, (r) => {
  assert.equal(status(r).G1, 'partial');
  assert.equal(status(r).G2, 'partial');
}));

test('an unfilled pipeline template does not count as gates', () => inRepo({
  ...app, '.github/workflows/pipeline.yml': template('pipeline.yml'), '.github/workflows/nightly.yml': template('nightly.yml'),
}, (r) => {
  assert.equal(r.stages[0].items.find(i => i.name === 'run in CI').ok, false, 'commented examples are not a lint step');
  assert.equal(status(r).G3, 'partial', 'authorisation tests exist but no services start in CI');
  assert.equal(status(r).G4, 'missing', 'no real contract command');
  assert.equal(r.next, 'G1');
}));

test('the filled pipeline + nightly templates pass every gate', () => inRepo({
  ...app, '.github/workflows/pipeline.yml': filled, '.github/workflows/nightly.yml': nightly,
}, (r) => {
  assert.deepEqual(status(r), { G1: 'done', G2: 'done', G3: 'done', G4: 'done', G5: 'done', G6: 'done', G8: 'done', chain: 'manual' });
  assert.equal(r.next, null, 'a gate that needs manual verification is not the next one to build');
}));

test('parallel jobs, or production without e2e, fail the chain gate', () => inRepo({
  ...app,
  '.github/workflows/ci.yml': 'on: push\njobs:\n  lint:\n    steps:\n      - run: npx eslint .\n  test:\n    steps:\n      - run: npx vitest run\n  deploy-production:\n    environment: production\n    steps:\n      - run: npx vercel deploy --prod\n',
}, (r) => {
  const prod = r.stages.find(s => s.n === 'chain');
  assert.equal(prod.status, 'missing');
  assert.deepEqual(prod.items.map(i => i.ok), [false, false]);
}));

test('a disconnected lint job and production deployed from pull requests never look like a safe chain', () => inRepo({
  ...app,
  '.github/workflows/ci.yml': [
    'on: [push, pull_request]', 'jobs:',
    '  lint:', '    steps:', '      - run: npx eslint .',
    '  a:', '    needs: x', '  b:', '    needs: a', '  c:', '    needs: b', '  e2e:', '    needs: c',
    '  deploy-production:', '    needs: e2e', '    if: github.event_name == \'pull_request\'', '    environment: production', '    steps:', '      - run: npx vercel deploy --prod',
  ].join('\n') + '\n',
}, (r) => {
  const chain = r.stages.find(s => s.n === 'chain');
  assert.notEqual(chain.status, 'done');
  assert.notEqual(chain.status, 'manual');
  assert.equal(chain.items.find(i => i.name.startsWith('production only')).ok, false);
}));

