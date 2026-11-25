import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findings, compare, lowered } from './ratchet.mjs';

const root = '/repo';
const eslint = (...files) => files.map(([file, rules]) => ({ filePath: `${root}/${file}`, messages: rules.map(ruleId => ({ ruleId, severity: 2 })) }));

test('ESLint findings are counted per file and rule, relative to the root', () => {
  const report = eslint(['src/a.js', ['no-unused-vars', 'no-unused-vars', 'eqeqeq']], ['src/b.js', []]);
  assert.deepEqual(findings(report, 'eslint-json', root), { 'src/a.js::eqeqeq': 1, 'src/a.js::no-unused-vars': 2 });
});

test('a parse error without a rule id is still a finding', () => {
  const report = [{ filePath: `${root}/x.js`, messages: [{ ruleId: null, severity: 2 }] }];
  assert.deepEqual(findings(report, 'eslint-json', root), { 'x.js::parse-error': 1 });
});

test('SARIF results are counted per file and rule (relative or file:// URIs)', () => {
  const report = { runs: [{ results: [
    { ruleId: 'r1', locations: [{ physicalLocation: { artifactLocation: { uri: 'src/a.rs' } } }] },
    { ruleId: 'r1', locations: [{ physicalLocation: { artifactLocation: { uri: 'file:///repo/src/a.rs' } } }] },
    { ruleId: 'r2', locations: [] },
  ] }] };
  assert.deepEqual(findings(report, 'sarif', root), { 'src/a.rs::r1': 2, 'unknown::r2': 1 });
});

test('an unknown format is an error, not an empty pass', () => {
  assert.throws(() => findings([], 'xml', root), /unknown format/);
});

test('compare: more findings is worse, fewer is better, new files and rules count as new', () => {
  const baseline = { 'a.js::x': 2, 'b.js::y': 1 };
  const current = { 'a.js::x': 3, 'b.js::y': 0, 'c.js::x': 1, 'a.js::z': 1 };
  const { worse, better } = compare(current, baseline);
  assert.deepEqual(worse.map(w => w.key), ['a.js::x', 'a.js::z', 'c.js::x']);
  assert.deepEqual(better, [{ key: 'b.js::y', before: 1, now: 0 }]);
});

test('compare: an empty baseline means every finding is new', () => {
  assert.equal(compare({ 'a.js::x': 1 }).worse.length, 1);
  assert.deepEqual(compare({}, {}), { worse: [], better: [] });
});

test('update lowers the baseline but refuses to raise it without --allow-raise', () => {
  assert.deepEqual(lowered({ 'a.js::x': 1 }, { 'a.js::x': 2 }), { section: { 'a.js::x': 1 } });
  assert.deepEqual(lowered({ 'a.js::x': 3 }, { 'a.js::x': 2 }).refused, [{ key: 'a.js::x', before: 2, now: 3 }]);
  assert.deepEqual(lowered({ 'a.js::x': 3 }, { 'a.js::x': 2 }, true), { section: { 'a.js::x': 3 } });
});

test('CLI: check exits 1 on a new finding and 0 when holding the line; update keeps other tools', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ratchet-'));
  const cli = (...a) => { try { execFileSync('node', [fileURLToPath(new URL('./ratchet.mjs', import.meta.url)), ...a], { cwd: dir, stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
  try {
    const report = (n) => JSON.stringify(eslint(['src/a.js', Array(n).fill('eqeqeq')]).map(f => ({ ...f, filePath: join(dir, f.filePath.slice(root.length + 1)) })));
    writeFileSync(join(dir, '.b.json'), JSON.stringify({ semgrep: { 'k::r': 4 }, eslint: { 'src/a.js::eqeqeq': 2 } }));
    const base = ['--tool', 'eslint', '--format', 'eslint-json', '--input', 'r.json', '--baseline', '.b.json', '--root', dir];
    writeFileSync(join(dir, 'r.json'), report(2)); assert.equal(cli('check', ...base), 0, 'same count holds the line');
    writeFileSync(join(dir, 'r.json'), report(3)); assert.equal(cli('check', ...base), 1, 'one more blocks');
    assert.equal(cli('update', ...base), 1, 'update refuses to raise');
    writeFileSync(join(dir, 'r.json'), report(1)); assert.equal(cli('check', ...base), 0, 'fewer passes');
    assert.equal(cli('update', ...base), 0, 'update lowers');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.b.json'), 'utf8')), { semgrep: { 'k::r': 4 }, eslint: { 'src/a.js::eqeqeq': 1 } });
    assert.equal(cli('check'), 2, 'missing arguments is a usage error');
  } finally { rmSync(dir, { recursive: true }); }
});
