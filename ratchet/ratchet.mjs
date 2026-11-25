#!/usr/bin/env node
// Hold the line on existing findings: only new ones block, and the inventory (.harness/baseline.json) can only go down.
// Zero dependencies, Node >= 18.
//
//   node ratchet.mjs check  --tool eslint --format eslint-json --input eslint.json [--baseline .harness/baseline.json] [--root .]
//   node ratchet.mjs update --tool eslint --format eslint-json --input eslint.json [--allow-raise]
//
// Findings are counted per "file::rule". check fails when any count is above the baseline (a finding in a new file
// or a new rule counts as new). update rewrites the tool's section from the current findings and refuses to raise
// any count unless --allow-raise is given (a human decision: .harness/ is a protected zone).
// ponytail: counts per file and rule, so moving or renaming a file makes its findings look new; matching by
// fingerprint would survive renames.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { relative, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const posix = (p) => p.split('\\').join('/');

// ESLint `-f json`: [{ filePath, messages: [{ ruleId, severity }] }]. Parse errors have no ruleId.
function fromEslint(report, root) {
  if (!Array.isArray(report)) throw new Error('not an ESLint JSON report (expected an array of files)');
  return report.flatMap(f => f.messages.map(m => `${posix(relative(root, f.filePath))}::${m.ruleId ?? 'parse-error'}`));
}

// SARIF 2.1.0: runs[].results[] with ruleId and the first location's URI.
// A report without runs, or a run whose scanner says it failed, is an error: counting it as zero findings would
// let a broken scan pass CI, and let update erase recorded debt.
function fromSarif(report, root) {
  if (!report || !Array.isArray(report.runs)) throw new Error('not a SARIF report (no runs array)');
  if (report.runs.some(run => (run.invocations ?? []).some(i => i.executionSuccessful === false))) {
    throw new Error('scanner reported a failed run (executionSuccessful: false)');
  }
  return report.runs.flatMap(run => (run.results ?? []).map(r => {
    let uri = r.locations?.[0]?.physicalLocation?.artifactLocation?.uri ?? 'unknown';
    if (uri.startsWith('file://')) uri = relative(root, fileURLToPath(uri));
    return `${posix(uri)}::${r.ruleId ?? r.rule?.id ?? 'unknown'}`;
  }));
}

const FORMATS = { 'eslint-json': fromEslint, sarif: fromSarif };

export function count(keys) {
  const counts = {};
  for (const k of keys) counts[k] = (counts[k] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function findings(report, format, root = '.') {
  const parse = FORMATS[format];
  if (!parse) throw new Error(`unknown format "${format}" (use: ${Object.keys(FORMATS).join(', ')})`);
  return count(parse(report, resolve(root)));
}

// What got worse (blocks) and what got better (can be locked in with update).
export function compare(current, baseline = {}) {
  const keys = [...new Set([...Object.keys(current), ...Object.keys(baseline)])].sort();
  const worse = [], better = [];
  for (const k of keys) {
    const now = current[k] ?? 0, before = baseline[k] ?? 0;
    if (now > before) worse.push({ key: k, before, now });
    if (now < before) better.push({ key: k, before, now });
  }
  return { worse, better };
}

// The new baseline section, or the list of raises it refuses to write.
export function lowered(current, baseline = {}, allowRaise = false) {
  const { worse } = compare(current, baseline);
  if (worse.length && !allowRaise) return { refused: worse };
  return { section: current };
}

function args(argv) {
  const [command, ...rest] = argv;
  const opts = { command, baseline: '.harness/baseline.json', root: '.' };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--allow-raise') opts.allowRaise = true;
    else if (rest[i].startsWith('--')) opts[rest[i].slice(2)] = rest[++i];
  }
  return opts;
}

const label = ({ key, before, now }) => `${key.replace('::', '  ')}  ${before} → ${now}`;

function main(argv) {
  const o = args(argv);
  if (!['check', 'update'].includes(o.command) || !o.tool || !o.format || !o.input) {
    console.error('usage: ratchet.mjs check|update --tool <name> --format eslint-json|sarif --input <report> [--baseline <file>] [--root <dir>] [--allow-raise]');
    return 2;
  }
  const current = findings(JSON.parse(readFileSync(o.input, 'utf8')), o.format, o.root);
  const all = existsSync(o.baseline) ? JSON.parse(readFileSync(o.baseline, 'utf8')) : {};
  const baseline = all[o.tool] ?? {};
  const total = (c) => Object.values(c).reduce((a, b) => a + b, 0);

  if (o.command === 'check') {
    const { worse, better } = compare(current, baseline);
    for (const w of worse) console.log(`✘ new  ${label(w)}`);
    for (const b of better) console.log(`✔ fixed  ${label(b)}`);
    console.log(`${o.tool}: ${total(current)} findings, baseline ${total(baseline)}; ${worse.length} worse, ${better.length} better`);
    if (better.length && !worse.length) console.log(`Lock the improvement in: ratchet.mjs update --tool ${o.tool} … (the baseline only goes down)`);
    return worse.length ? 1 : 0;
  }

  const { section, refused } = lowered(current, baseline, o.allowRaise);
  if (refused) {
    for (const w of refused) console.log(`✘ would raise  ${label(w)}`);
    console.log('Refused: the baseline only goes down. Fix these, or have a human re-run with --allow-raise.');
    return 1;
  }
  mkdirSync(dirname(o.baseline), { recursive: true });
  writeFileSync(o.baseline, JSON.stringify({ ...all, [o.tool]: section }, null, 2) + '\n');
  console.log(`${o.baseline}: ${o.tool} baseline ${total(baseline)} → ${total(section)}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (e) { console.error(`✘ ratchet: ${e.message}`); process.exitCode = 2; }
}
