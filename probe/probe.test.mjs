// probe must catch every bug class in a deliberately vulnerable server and pass the fixed one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { run } from './probe.mjs';

function demo(secure) {
  const items = new Map(), claims = new Set();
  const users = { 'Bearer tok-a': 'a', 'Bearer tok-b': 'b' };
  return http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const send = (status, body, extra = {}) => {
      const safe = secure ? { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' } : {};
      res.writeHead(status, { 'Content-Type': 'application/json', ...safe, ...extra });
      res.end(JSON.stringify(body));
    };
    const user = users[req.headers.authorization] ?? (secure ? null : 'anonymous');
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/') return send(200, {}, { 'Set-Cookie': secure ? 'sid=1; Path=/; HttpOnly; Secure; SameSite=Lax' : 'sid=1; Path=/' });
    if (!user) return send(401, {});
    if (path === '/claim' && req.method === 'POST') {
      if (claims.has(user)) return send(409, {});
      if (!secure) await new Promise(r => setTimeout(r, 10)); // check, await, then write: the race
      claims.add(user);
      return send(200, {});
    }
    const id = path.match(/^\/items\/(.+)$/)?.[1];
    if (id === undefined) return send(404, {});
    if (!secure && decodeURIComponent(id).includes('..')) return send(200, { file: 'root:x:0:0' });
    if (secure && !/^[0-9a-f]{32}$/.test(id)) return send(404, {});
    const key = secure ? `${user}/${id}` : id;
    if (req.method === 'PUT') {
      if (secure && raw.length > 1000) return send(413, {});
      let doc;
      try { doc = JSON.parse(raw); } catch { return send(secure ? 422 : 500, {}); }
      if (typeof doc?.title !== 'string') return send(secure ? 422 : 500, { error: 'title.trim is not a function' });
      items.set(key, doc.title);
      return send(200, {});
    }
    if (req.method === 'GET') return items.has(key) ? send(200, { title: items.get(key) }) : send(404, {});
    return send(405, {});
  });
}

async function probe(secure) {
  const server = demo(secure).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  try {
    return await run({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      idFormat: 'hex32',
      users: { a: { headers: { Authorization: 'Bearer tok-a' } }, b: { headers: { Authorization: 'Bearer tok-b' } } },
      routes: [
        { name: 'save item', method: 'PUT', path: '/items/{id}', body: { title: '{fuzz}' }, auth: true, maxBytes: 1000 },
        { name: 'read item', method: 'GET', path: '/items/{id}', auth: true,
          owned: { create: { method: 'PUT', path: '/items/{id}', body: { title: 'secret' } }, read: { method: 'GET', path: '/items/{id}' } } },
        { name: 'claim once', method: 'POST', path: '/claim', race: { parallel: 10, maxSuccess: 1 } },
      ],
    });
  } finally {
    server.close();
  }
}

const failing = (results) => [...new Set(results.filter(r => !r.ok).map(r => r.check))].sort();

test('catches every bug class in the vulnerable server', async () => {
  assert.deepEqual(failing(await probe(false)), [
    'auth: forged credentials', 'auth: no credentials', 'cookie flags', 'hostile input', 'no server errors',
    'ownership: other user', 'path escape', 'race', 'security headers', 'size limit',
  ]);
});

test('passes the fixed server', async () => {
  const results = await probe(true);
  assert.deepEqual(failing(results), [], JSON.stringify(results.filter(r => !r.ok), null, 2));
  assert.ok(results.length >= 12);
});

test('an endpoint that refuses every request is not a green report', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(401, { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' }); res.end('{}'); });
  }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  try {
    const results = await run({
      baseUrl: `http://127.0.0.1:${server.address().port}`, idFormat: 'hex32',
      users: { a: { headers: { Authorization: 'Bearer broken' } } },
      routes: [
        { name: 'save', method: 'PUT', path: '/items/{id}', auth: true, maxBytes: 100, body: { title: '{fuzz}' } },
        { name: 'claim', method: 'POST', path: '/claim', race: { parallel: 5, maxSuccess: 1 } },
      ],
    });
    assert.deepEqual(failing(results), ['control: a valid request works', 'race']);
    assert.ok(!results.some(r => r.route === 'save' && r.check !== 'control: a valid request works'), 'no rejection is credited without a working control request');
  } finally { server.close(); }
});

test('credentials: $VAR is expanded anywhere in a header value, and a missing variable is an error', async () => {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push(req.headers.cookie); req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}'); }); }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    process.env.PROBE_TEST_TOKEN = 'abc123';
    await run({ baseUrl: base, users: { a: { headers: { Cookie: 'session=$PROBE_TEST_TOKEN; theme=${PROBE_TEST_TOKEN}' } } }, routes: [{ path: '/ok' }] });
    assert.ok(seen.includes('session=abc123; theme=abc123'), `cookie sent: ${seen.join(' | ')}`);
    delete process.env.PROBE_TEST_TOKEN;
    await assert.rejects(run({ baseUrl: base, users: { a: { headers: { Cookie: 'session=$PROBE_TEST_TOKEN' } } }, routes: [] }), /PROBE_TEST_TOKEN is not set/);
  } finally { server.close(); }
});
