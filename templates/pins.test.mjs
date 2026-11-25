// Every reference from the templates to forge must point at ONE commit: a template that pins G0 to an older commit
// than its other workflows silently ships an older policy (found by an external audit). Bump them together, to a
// commit that contains the current policy/ and actions/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('./.github/workflows/', import.meta.url);

test('all forge references in the templates share one pinned commit', () => {
  const refs = readdirSync(dir).filter(f => f.endsWith('.yml'))
    .flatMap(f => [...readFileSync(new URL(f, dir), 'utf8').matchAll(/beskar-ci\/forge\/[^@\s]+@([^\s#]+)/g)].map(m => ({ file: f, sha: m[1] })));
  assert.ok(refs.length >= 5, `expected the G0, security, SAST, review and DAST references, found ${refs.length}`);
  for (const r of refs) assert.match(r.sha, /^[0-9a-f]{40}$/, `${r.file} pins forge to "${r.sha}", not a full commit SHA`);
  assert.deepEqual([...new Set(refs.map(r => r.sha))].length, 1, `forge is pinned to several commits: ${JSON.stringify(refs)}`);
});
