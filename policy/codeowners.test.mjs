import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { covers, rules, check } from './codeowners.mjs';

function inRepo(files, fn) {
  const root = mkdtempSync(join(tmpdir(), 'codeowners-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return fn(check(root));
  } finally { rmSync(root, { recursive: true }); }
}

const manifest = '[zones.protected]\npaths = [".github/**", "harness.toml", "tests/critical/**", "**/*.test.mjs"]\n';

test('covers: directory, file, extension and catch-all patterns', () => {
  assert.equal(covers('/.github/', '.github/**'), true);
  assert.equal(covers('.github/**', '.github/**'), true);
  assert.equal(covers('/tests/', 'tests/critical/**'), true);
  assert.equal(covers('/harness.toml', 'harness.toml'), true);
  assert.equal(covers('*.test.mjs', '**/*.test.mjs'), true);
  assert.equal(covers('*', 'anything/**'), true);
  assert.equal(covers('/.github/workflows/', '.github/**'), false, 'a subfolder does not own the whole folder');
  assert.equal(covers('/harness.toml', 'harness.toml.bak'), false);
  assert.equal(covers('/src/', '.github/**'), false);
});

test('rules: comments, blank lines and owners', () => {
  assert.deepEqual(rules('# header\n\n/.github/  @org/team  # trailing\n/docs/\n'), [
    { pattern: '/.github/', owners: ['@org/team'] },
    { pattern: '/docs/', owners: [] },
  ]);
});

test('a CODEOWNERS covering every protected zone and itself passes', () => inRepo({
  'harness.toml': manifest,
  '.github/CODEOWNERS': '/.github/ @org/gatekeepers\n/harness.toml @org/gatekeepers\n/tests/critical/ @org/gatekeepers\n*.test.mjs @org/gatekeepers\n',
}, (errors) => assert.deepEqual(errors, [])));

test('each uncovered protected zone is reported', () => inRepo({
  'harness.toml': manifest,
  '.github/CODEOWNERS': '/.github/ @org/gatekeepers\n',
}, (errors) => assert.deepEqual(errors, [
  '.github/CODEOWNERS: no owner for protected zone "harness.toml"',
  '.github/CODEOWNERS: no owner for protected zone "tests/critical/**"',
  '.github/CODEOWNERS: no owner for protected zone "**/*.test.mjs"',
])));

test('a line without owners does not count, and CODEOWNERS must own itself', () => inRepo({
  'harness.toml': '[zones.protected]\npaths = ["harness.toml"]\n',
  'CODEOWNERS': '/harness.toml\n',
}, (errors) => assert.deepEqual(errors, [
  'CODEOWNERS: no owner for protected zone "harness.toml"',
  'CODEOWNERS: no owner for protected zone "CODEOWNERS"',
])));

test('missing manifest or CODEOWNERS is an error, not a pass', () => {
  inRepo({ '.github/CODEOWNERS': '* @org/team\n' }, (errors) => assert.deepEqual(errors, ['harness.toml not found']));
  inRepo({ 'harness.toml': manifest }, (errors) => assert.match(errors[0], /CODEOWNERS not found/));
});
