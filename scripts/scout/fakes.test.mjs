// node --test scripts/scout/fakes.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkFake, createFake, matchRoute, planFakes, render, serveFake, timeValue } from './fakes.mjs';

const nylas = {
  name: 'nylas',
  hosts: ['api.us.nylas.com'],
  env: { NYLAS_API_URL: '${URL}', NYLAS_ACCESS_TOKEN: 'fake-key', APP_BACK: '${APP_URL}/done' },
  state: { bookings: {} },
  routes: [
    { method: 'GET', path: '/v3/hello/:name', body: { hi: '{{params.name}}', n: '{{query.n}}', when: '{{unix+1d}}' } },
    { method: 'POST', path: '/v3/bookings', handler: 'const id = "b1"; state.bookings[id] = req.body; util.webhook("booking.created", { id }); return { status: 201, body: { id } };' },
    { method: 'GET', path: '/v3/bookings/:id', handler: 'const b = state.bookings[req.params.id]; return b ? { body: { id: req.params.id, ...b } } : { status: 404, body: { error: "not found" } };' },
    { method: 'GET', path: '/oauth/authorize', status: 302, headers: { location: '{{query.redirect_uri}}?code=fake&state={{query.state}}' } },
    { method: 'ANY', path: '/files/*', body: '{{params.*}}' },
  ],
  webhooks: [{ name: 'booking.created', path: '/api/webhooks/nylas', headers: { 'x-sig': 'abc' }, body: { type: 'booking.created', id: '{{payload.id}}' } }],
};

test('a definition is checked before it runs', () => {
  assert.deepEqual(checkFake(nylas), []);
  assert.match(checkFake({ name: 'Bad Name', routes: [] })[0], /name/);
  assert.match(checkFake({ name: 'x', routes: [{ path: 'no-slash' }] })[0], /path/);
  assert.match(checkFake({ name: 'x', routes: [{ path: '/a', handler: 'return {' }] })[0], /does not parse/);
  // .env.local is sourced by a shell: nothing a shell would run gets in.
  assert.match(checkFake({ name: 'x', routes: [], env: { A: '$(curl evil)' } })[0], /env\.A/);
  assert.match(checkFake({ name: 'x', routes: [], env: { A: 'a b' } })[0], /env\.A/);
  assert.match(checkFake({ name: 'x', routes: [], hosts: ['https://api.x.com'] })[0], /hosts/);
});

test('templates fill in the request and the clock', () => {
  const at = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(timeValue('now+1d', at), '2026-01-02T00:00:00.000Z');
  assert.equal(timeValue('unix+1h-30m', at), at / 1000 + 1800);
  assert.equal(timeValue('date-1d', at), '2025-12-31');
  assert.equal(timeValue('params.now'), undefined);
  assert.deepEqual(render({ a: '{{body.n}}', b: 'x-{{body.n}}', c: ['{{missing.k}}'] }, { body: { n: 7 } }), { a: 7, b: 'x-7', c: [null] });
});

test('routes match by method and path', () => {
  const routes = nylas.routes;
  assert.deepEqual(matchRoute(routes, 'GET', '/v3/bookings/b%201').params, { id: 'b 1' });
  assert.equal(matchRoute(routes, 'DELETE', '/v3/bookings/b1'), null);
  assert.equal(matchRoute(routes, 'GET', '/v3/bookings'), null);
  assert.deepEqual(matchRoute(routes, 'PUT', '/files/a/b.txt').params, { '*': 'a/b.txt' });
});

test('a fake answers, remembers, and says what it has no route for', async () => {
  const sent = [];
  const log = [];
  const fake = createFake(nylas, { url: 'http://localhost:4600', appUrl: 'http://localhost:3000', log: (e) => log.push(e), fetch: async (url, init) => (sent.push({ url, init }), { status: 200 }) });
  const hello = await fake.answer({ method: 'GET', path: '/v3/hello/sam', query: { n: '2' } });
  assert.equal(hello.status, 200);
  assert.equal(hello.body.hi, 'sam');
  assert.equal(typeof hello.body.when, 'number');

  const made = await fake.answer({ method: 'POST', path: '/v3/bookings', headers: { 'content-type': 'application/json' }, rawBody: '{"title":"Smog check"}' });
  assert.deepEqual([made.status, made.body], [201, { id: 'b1' }]);
  assert.deepEqual((await fake.answer({ method: 'GET', path: '/v3/bookings/b1' })).body, { id: 'b1', title: 'Smog check' });
  assert.equal((await fake.answer({ method: 'GET', path: '/v3/bookings/nope' })).status, 404);

  const redirect = await fake.answer({ method: 'GET', path: '/oauth/authorize', query: { redirect_uri: 'http://localhost:3000/cb', state: 's1' } });
  assert.deepEqual([redirect.status, redirect.headers.location], [302, 'http://localhost:3000/cb?code=fake&state=s1']);

  const missing = await fake.answer({ method: 'GET', path: '/v3/unknown' });
  assert.equal(missing.status, 501);
  assert.equal(log.at(-1).route, null);

  // The handler's webhook reaches the app after the response.
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'http://localhost:3000/api/webhooks/nylas');
  assert.equal(sent[0].init.headers['x-sig'], 'abc');
  assert.deepEqual(JSON.parse(sent[0].init.body), { type: 'booking.created', id: 'b1' });

  // A test can fire one itself, read what was asked, and start over.
  const fired = await fake.answer({ method: 'POST', path: '/__fake/webhooks/booking.created', headers: { 'content-type': 'application/json' }, rawBody: '{"id":"b9"}' });
  assert.deepEqual(fired.body, { sent: 'booking.created', status: 200 });
  assert.ok((await fake.answer({ method: 'GET', path: '/__fake/requests' })).body.length >= 6);
  await fake.answer({ method: 'POST', path: '/__fake/reset' });
  assert.equal((await fake.answer({ method: 'GET', path: '/v3/bookings/b1' })).status, 404);
});

test('a handler that throws is a 500 that names the route', async () => {
  const fake = createFake({ name: 'x', routes: [{ method: 'GET', path: '/boom', handler: 'throw new Error("nope")' }] });
  const out = await fake.answer({ method: 'GET', path: '/boom' });
  assert.equal(out.status, 500);
  assert.match(out.body.error, /nope/);
});

test('the repo’s definition replaces HQ’s, and the plan fills in the addresses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fakes-'));
  const hqDir = join(dir, 'hq');
  const repoDir = join(dir, 'repo');
  mkdirSync(hqDir);
  mkdirSync(repoDir);
  writeFileSync(join(hqDir, 'nylas.json'), JSON.stringify(nylas));
  writeFileSync(join(hqDir, 'stripe.json'), JSON.stringify({ name: 'stripe', routes: [], env: { STRIPE_HOST: '${HOST}' } }));
  writeFileSync(join(hqDir, 'twilio.json'), JSON.stringify({ name: 'twilio', routes: [] }));
  writeFileSync(join(hqDir, 'broken.json'), '{ "name": "broken" }');
  writeFileSync(join(repoDir, 'nylas.json'), JSON.stringify({ ...nylas, env: { NYLAS_API_URL: '${URL}/v3' } }));
  writeFileSync(join(repoDir, 'twilio.json'), JSON.stringify({ name: 'twilio', enabled: false, routes: [] }));
  const plan = planFakes({ hqDir, repoDir, basePort: 4700, appUrl: 'http://localhost:3000' });
  assert.deepEqual(plan.fakes.map((f) => [f.name, f.source, f.port]), [['nylas', 'repo', 4700], ['stripe', 'hq', 4701]]);
  assert.deepEqual(plan.fakes[0].env, { NYLAS_API_URL: 'http://localhost:4700/v3' });
  assert.deepEqual(plan.fakes[1].env, { STRIPE_HOST: 'localhost:4701' });
  assert.equal(plan.skipped.length, 1);
});

test('served over HTTP, with CORS for the app’s browser code', async () => {
  const fake = createFake(nylas, {});
  const server = await serveFake(fake, 0);
  const base = `http://localhost:${server.address().port}`;
  try {
    const pre = await fetch(`${base}/v3/bookings`, { method: 'OPTIONS', headers: { origin: 'http://localhost:3000', 'access-control-request-headers': 'authorization' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    const res = await fetch(`${base}/v3/hello/sam?n=3`);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal((await res.json()).n, '3');
    const form = await fetch(`${base}/v3/bookings`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'title=Hi' });
    assert.equal(form.status, 201);
    assert.equal((await (await fetch(`${base}/v3/bookings/b1`)).json()).title, 'Hi');
  } finally {
    server.close();
  }
});

test('summarize says what the app asked of each fake, and which fake it never called', async () => {
  const { summarize } = await import('./fakes.mjs');
  const plan = { fakes: [{ name: 'nylas', url: 'http://localhost:4600', env: { NYLAS_API_URL: 'x' } }, { name: 'stripe', url: 'http://localhost:4601', env: {} }] };
  const entries = [
    { fake: 'stripe', method: 'GET', path: '/v1/a/1', route: '/v1/a/:id', status: 200 },
    { fake: 'stripe', method: 'GET', path: '/v1/a/2', route: '/v1/a/:id', status: 404 },
    { fake: 'stripe', method: 'POST', path: '/v1/zzz', route: null, status: 501 },
    { fake: 'stripe', webhook: 'paid', url: 'http://app/hook', status: 200 },
  ];
  const lines = summarize(plan, entries);
  assert.match(lines[0], /^::warning::\[Fakes\] nylas: the app never called it .*NYLAS_API_URL/);
  assert.equal(lines[1], '[Fakes] stripe: 3 calls from the app');
  assert.ok(lines.includes('[Fakes]   GET /v1/a/:id ×2 → 200, 404'));
  assert.ok(lines.includes('[Fakes]   POST /v1/zzz (no route) ×1 → 501'));
  assert.ok(lines.some((l) => /1 call had no route/.test(l)));
  assert.ok(lines.includes('[Fakes]   webhooks sent: paid → 200'));
});
