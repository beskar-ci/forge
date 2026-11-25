#!/usr/bin/env node
// probe: black-box adversarial checks for any HTTP API, whatever language it is written in.
// Zero dependencies, Node >= 18.   node probe.mjs probe.config.json
//
// Checks (METHODOLOGY.md §2): no / forged credentials, another user's resource (read + unchanged),
// path escapes, hostile input, size limit, parallel requests vs an invariant, security headers,
// cookie flags, and no 5xx anywhere. See example.config.json.
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const DENIED = [401, 403, 404];
// fetch normalises plain "../", so the encoded forms are the ones that reach the server.
const ESCAPES = ['..%2F..%2F..%2Fetc%2Fpasswd', '%2e%2e%2f%2e%2e%2fetc%2fpasswd', '..%5C..%5Cwindows%5Cwin.ini',
  '....%2F%2F....%2F%2Fetc%2Fpasswd', '%2Fetc%2Fpasswd', 'x%00.json', 'a'.repeat(4096)];
const HOSTILE = ["' OR '1'='1", '"; DROP TABLE users; --', '<script>alert(1)</script>', '{{7*7}}${7*7}',
  '\u0000\u202e', '😀'.repeat(500), 'A'.repeat(200000), -1, 1e308, null, true, [], {}];
const IDS = { hex32: () => randomBytes(16).toString('hex'), uuid: randomUUID, int: () => String(1e6 + Math.floor(Math.random() * 1e9)) };
const hex = () => randomBytes(16).toString('hex');

// "{fuzz}" as a whole value is replaced by the raw payload (any JSON type); "{x}" inside strings by vars.x.
function fill(value, vars) {
  if (value === '{fuzz}' && 'fuzz' in vars) return vars.fuzz;
  if (typeof value === 'string') return value.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  if (Array.isArray(value)) return value.map(v => fill(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  return value;
}

// Same header names, random secrets: keeps cookie names and the "Bearer" scheme.
function forge(headers) {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k,
    /^cookie$/i.test(k) ? v.replace(/=([^;]+)/g, () => '=' + hex()) : /^authorization$/i.test(k) ? v.replace(/\S+$/, hex()) : hex()]));
}

// $NAME or ${NAME} anywhere in a header value comes from the environment (tokens in CI). A missing variable is an
// error: sending the placeholder would make every authenticated check meaningless.
function expand(value) {
  return value.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, name) => {
    if (process.env[name] === undefined) throw new Error(`probe: environment variable ${name} is not set`);
    return process.env[name];
  });
}
const creds = (user) => Object.fromEntries(Object.entries(user?.headers ?? {}).map(([k, v]) => [k, expand(v)]));

export async function run(cfg) {
  const results = [];
  const cookies = new Set();
  const base = cfg.baseUrl.replace(/\/$/, '');
  const newId = IDS[cfg.idFormat ?? 'uuid'];
  const [ownerName, otherName] = Object.keys(cfg.users ?? {});
  const owner = creds(cfg.users?.[ownerName]), other = creds(cfg.users?.[otherName]);
  const record = (check, route, ok, detail = '') => results.push({ check, route, ok, detail });

  async function send(req, vars, auth, rawBody) {
    const headers = { ...auth, ...req.headers };
    let body = rawBody ?? (req.body === undefined ? undefined : fill(req.body, vars));
    if (body !== undefined && typeof body !== 'string') body = JSON.stringify(body);
    if (body !== undefined) headers['Content-Type'] ??= 'application/json';
    const method = req.method ?? 'GET';
    const res = await fetch(base + fill(req.path, vars), { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() ?? []) cookies.add(c);
    const text = await res.text();
    if (res.status >= 500) record('no server errors', `${method} ${req.path}`, false, `${res.status} ${text.slice(0, 100)}`);
    return { status: res.status, headers: res.headers, text };
  }

  const page = await send({ path: cfg.headersPath ?? '/' }, {}, {});
  const h = (n) => page.headers.get(n) ?? '';
  const missing = [
    h('x-content-type-options') !== 'nosniff' && 'X-Content-Type-Options: nosniff',
    !h('referrer-policy') && 'Referrer-Policy',
    !h('x-frame-options') && !/frame-ancestors/.test(h('content-security-policy')) && 'X-Frame-Options or CSP frame-ancestors (clickjacking)',
    base.startsWith('https:') && !h('strict-transport-security') && 'Strict-Transport-Security',
  ].filter(Boolean);
  record('security headers', cfg.headersPath ?? '/', !missing.length, missing.length ? 'missing ' + missing.join(', ') : '');

  for (const r of cfg.routes ?? []) {
    const name = r.name ?? `${r.method ?? 'GET'} ${r.path}`;
    const vars = { id: newId(), fuzz: 'probe' };

    // Control: a valid request with valid credentials must work (on its own resource for owned routes), otherwise
    // every "refused" below proves nothing (a server refusing everything would pass them). Race routes prove it
    // themselves (at least one success); `control: false` opts out explicitly, e.g. for a route that must 404.
    if (!r.race && r.control !== false) {
      const cv = { id: newId(), fuzz: 'probe' };
      if (r.owned) {
        const made = await send(r.owned.create, cv, owner);
        if (made.status >= 300) { record('ownership: setup', name, false, `create answered ${made.status}`); continue; }
      }
      const c = await send(r, cv, owner);
      record('control: a valid request works', name, c.status < 400, `answered ${c.status}`);
      if (c.status >= 400) continue;
    }

    let before = null;
    if (r.owned) {
      const made = await send(r.owned.create, vars, owner);
      if (made.status >= 300) { record('ownership: setup', name, false, `create answered ${made.status}`); continue; }
      if (r.owned.read) before = await send(r.owned.read, vars, owner);
    }

    if (r.auth) {
      for (const [label, auth] of [['no credentials', {}], ['forged credentials', forge(owner)]]) {
        const res = await send(r, vars, auth);
        record(`auth: ${label}`, name, DENIED.includes(res.status), `answered ${res.status}`);
      }
    }

    if (r.owned && otherName) {
      const res = await send(r, vars, other);
      const reads = ['GET', 'HEAD'].includes(r.method ?? 'GET');
      const leaked = res.status < 300 && before && before.text && res.text.includes(before.text);
      const after = r.owned.read ? await send(r.owned.read, vars, owner) : null;
      const changed = before && after && after.text !== before.text;
      const ok = !leaked && !changed && (!reads || DENIED.includes(res.status));
      record('ownership: other user', name, ok, `other user got ${res.status}${leaked ? ', saw the data' : ''}${changed ? ", owner's data changed" : ''}`);
    }

    if (r.path.includes('{id}')) {
      const bad = [];
      for (const p of ESCAPES) {
        const res = await send(r, { ...vars, id: p }, owner);
        if (res.status < 400 || res.status >= 500) bad.push(`${p.slice(0, 30)} → ${res.status}`);
      }
      record('path escape', name, !bad.length, bad.join('; '));
    }

    if (JSON.stringify(r.body ?? '').includes('"{fuzz}"')) {
      const bad = [];
      for (const p of HOSTILE) {
        const res = await send(r, { id: newId(), fuzz: p }, owner);
        const reflected = /html/.test(res.headers.get('content-type') ?? '') && res.text.includes('<script>alert(1)</script>');
        if (res.status >= 500 || reflected) bad.push(`${JSON.stringify(p).slice(0, 30)} → ${res.status}${reflected ? ' (reflected)' : ''}`);
      }
      record('hostile input', name, !bad.length, bad.join('; '));
    }

    if (r.maxBytes) {
      const res = await send(r, { id: newId() }, owner, JSON.stringify({ pad: 'x'.repeat(r.maxBytes) }));
      record('size limit', name, res.status >= 400 && res.status < 500, `${r.maxBytes + 1}+ bytes answered ${res.status}`);
    }

    if (r.race) {
      const { parallel = 20, maxSuccess = 1, freshIds = false } = r.race;
      const all = await Promise.all(Array.from({ length: parallel }, () => send(r, { ...vars, id: freshIds ? newId() : vars.id }, owner)));
      const ok = all.filter(x => x.status < 300).length;
      record('race', name, ok >= 1 && ok <= maxSuccess, `${ok} of ${parallel} parallel requests succeeded (expected 1 to ${maxSuccess})`);
    }
  }

  const weak = [...cookies].filter(c => !/;\s*HttpOnly/i.test(c) || !/;\s*Secure/i.test(c) || !/;\s*SameSite=/i.test(c));
  record('cookie flags', '', !weak.length, cookies.size ? weak.map(c => c.split(';')[0].split('=')[0] + ' lacks HttpOnly/Secure/SameSite').join('; ') : 'no cookies seen');
  if (!results.some(r => r.check === 'no server errors')) record('no server errors', '', true);
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = JSON.parse(readFileSync(process.argv[2] ?? 'probe.config.json', 'utf8'));
  const results = await run(cfg);
  for (const r of results) console.log(`${r.ok ? '✔' : '✘'} ${r.check}${r.route ? ` — ${r.route}` : ''}${r.detail ? `: ${r.detail}` : ''}`);
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
