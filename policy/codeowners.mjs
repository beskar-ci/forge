#!/usr/bin/env node
// G0: every protected zone of harness.toml (and CODEOWNERS itself) must have an owner in CODEOWNERS, so a change
// to what judges the code always needs a human reviewer.   node policy/codeowners.mjs [repo]
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'smol-toml';

const LOCATIONS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']; // GitHub's lookup order

// Lines of a CODEOWNERS file as { pattern, owners }; comments and blank lines dropped.
export function rules(text) {
  return text.split('\n')
    .map(l => l.replace(/(^|\s)#.*$/, '').trim())
    .filter(Boolean)
    .map(l => { const [pattern, ...owners] = l.split(/\s+/); return { pattern, owners }; });
}

const strip = (p) => p.replace(/^\//, '').replace(/\/\*\*$/, '/');

// Does a CODEOWNERS pattern own everything a protected-zone glob can match?
// ponytail: covers the shapes manifests use (dir/**, a file, **/*.ext, *); full gitignore semantics, including a
// later ownerless line un-owning a path, would need a real matcher.
export function covers(pattern, zone) {
  const p = strip(pattern), z = strip(zone);
  if (p === '*' || p === '**') return true;
  if (p.endsWith('/')) return z.startsWith(p);                      // "/.github/" owns ".github/**"
  if (!p.includes('/') && p.startsWith('*')) return z.endsWith(p.slice(1)); // "*.test.mjs" owns "**/*.test.mjs"
  return p === z;                                                    // "/harness.toml" owns "harness.toml"
}

export function uncovered(zones, owners) {
  return zones.filter(z => !owners.some(r => r.owners.length > 0 && covers(r.pattern, z)));
}

export function check(root) {
  const manifestPath = join(root, 'harness.toml');
  if (!existsSync(manifestPath)) return ['harness.toml not found'];
  const zones = parse(readFileSync(manifestPath, 'utf8'))?.zones?.protected?.paths ?? [];
  const location = LOCATIONS.find(l => existsSync(join(root, l)));
  if (!location) return ['CODEOWNERS not found (.github/CODEOWNERS, CODEOWNERS or docs/CODEOWNERS)'];
  const missing = uncovered([...zones, location], rules(readFileSync(join(root, location), 'utf8')));
  return missing.map(z => `${location}: no owner for protected zone ${JSON.stringify(z)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = check(process.argv[2] ?? '.');
  for (const e of errors) console.log(`✘ ${e}`);
  if (!errors.length) console.log('✔ CODEOWNERS covers every protected zone and itself');
  process.exitCode = errors.length ? 1 : 0;
}
