#!/usr/bin/env node
/**
 * Fake services: stand-ins for the third parties an app calls (Nylas, Stripe, Twilio…), so Scout can test
 * a flow that depends on one without a real key and without reaching the real service. A fake is one JSON
 * definition: the routes it answers, the environment variables that point the app at it, the real hosts
 * it replaces, and the webhooks it can send to the app. One generic server runs them all, each on its own
 * local port; nothing here knows any particular service.
 *
 * Where definitions come from, per name:
 *   1. Agent HQ (its Fakes page), pulled into `$SCOUT_OUT/fakes/hq/` by `hq.mjs fakes-pull` before the app starts;
 *   2. the repo, `.github/scout/fakes/<name>.json`, which replaces HQ's whole definition of that name, so
 *      a pull request that changes how the app calls a service changes its fake in the same PR.
 *
 *   node fakes.mjs plan            read both, give each fake a port, write $SCOUT_OUT/fakes/plan.json
 *   node fakes.mjs env             the plan's variables for .env.local, as KEY=value lines
 *   node fakes.mjs hosts           the real hosts the plan's fakes replace (to block on CI)
 *   node fakes.mjs urls            each fake's health URL (to wait for)
 *   node fakes.mjs serve           run the plan's fakes until stopped
 *   node fakes.mjs check <file>    is this a valid definition? (exit 1 with what is wrong)
 *
 * Env: SCOUT_OUT (default scout-out), SCOUT_FAKES_PORT (first port, default 4600), SCOUT_APP_URL (the app
 * under test, for webhooks and `${APP_URL}`).
 *
 * The definition (see docs/reference.md, "Fake services"):
 *   {
 *     "name": "nylas", "title": "Nylas", "about": "what the app uses it for",
 *     "hosts": ["api.us.nylas.com"],
 *     "env": { "NYLAS_API_URL": "${URL}", "NYLAS_ACCESS_TOKEN": "fake-nylas-key" },
 *     "state": { "bookings": {} },
 *     "routes": [
 *       { "method": "GET", "path": "/v3/bookings/:id", "status": 200, "body": { "id": "{{params.id}}" } },
 *       { "method": "POST", "path": "/v3/bookings", "handler": "const id = util.id(); state.bookings[id] = req.body; return { status: 201, body: { id } };" }
 *     ],
 *     "webhooks": [{ "name": "booking.created", "path": "/api/webhooks/nylas", "body": { "id": "{{payload.id}}" } }],
 *     "needs": [{ "file": "src/x.ts", "change": "read the base URL from NYLAS_API_URL" }]
 *   }
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FAKE_NAME = /^[a-z][a-z0-9-]{0,39}$/;
export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ANY'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// .env.local is sourced by a shell: a value is plain characters and the placeholders below, nothing a shell expands.
const ENV_VALUE = /^(?:[A-Za-z0-9_@%+=:,./-]|\$\{(?:URL|HOST|PORT|APP_URL)\})*$/;
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const REPO_DIR = '.github/scout/fakes';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** What is wrong with a definition, one sentence each; empty when it can run. */
export function checkFake(def) {
  const problems = [];
  if (!isObject(def)) return ['The definition is not a JSON object'];
  if (!FAKE_NAME.test(String(def.name ?? ''))) problems.push('"name" must be a short slug: lower-case letters, digits and dashes, starting with a letter');
  if (def.hosts !== undefined && (!Array.isArray(def.hosts) || def.hosts.some((h) => typeof h !== 'string' || !HOST.test(h)))) problems.push('"hosts" must be a list of hostnames (no scheme, no path)');
  if (def.env !== undefined) {
    if (!isObject(def.env)) problems.push('"env" must be an object of variable names to values');
    else
      for (const [k, v] of Object.entries(def.env)) {
        if (!ENV_NAME.test(k)) problems.push(`env: "${k}" is not a variable name`);
        else if (typeof v !== 'string' || !ENV_VALUE.test(v)) problems.push(`env.${k}: use plain characters (no spaces or quotes) and \${URL}, \${HOST}, \${PORT}, \${APP_URL}`);
      }
  }
  if (def.state !== undefined && !isObject(def.state)) problems.push('"state" must be an object');
  if (!Array.isArray(def.routes)) problems.push('"routes" must be a list');
  else
    def.routes.forEach((r, i) => {
      const at = `routes[${i}]`;
      if (!isObject(r)) return problems.push(`${at} is not an object`);
      if (!METHODS.includes(String(r.method ?? 'GET').toUpperCase())) problems.push(`${at}.method must be one of ${METHODS.join(', ')}`);
      if (typeof r.path !== 'string' || !r.path.startsWith('/')) problems.push(`${at}.path must start with /`);
      if (r.status !== undefined && !(Number.isInteger(r.status) && r.status >= 100 && r.status <= 599)) problems.push(`${at}.status must be an HTTP status`);
      if (r.headers !== undefined && !isObject(r.headers)) problems.push(`${at}.headers must be an object`);
      if (r.handler !== undefined) {
        const why = handlerProblem(r.handler);
        if (why) problems.push(`${at}.handler: ${why}`);
      }
    });
  if (def.webhooks !== undefined) {
    if (!Array.isArray(def.webhooks)) problems.push('"webhooks" must be a list');
    else
      def.webhooks.forEach((w, i) => {
        const at = `webhooks[${i}]`;
        if (!isObject(w)) return problems.push(`${at} is not an object`);
        if (!FAKE_NAME.test(String(w.name ?? '').replace(/[._]/g, '-'))) problems.push(`${at}.name must be a short name such as booking.created`);
        if (typeof w.path !== 'string' || !(w.path.startsWith('/') || /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(w.path))) problems.push(`${at}.path must be a path on the app (it starts with /)`);
        if (w.handler !== undefined) {
          const why = handlerProblem(w.handler);
          if (why) problems.push(`${at}.handler: ${why}`);
        }
      });
  }
  return problems;
}

function handlerProblem(code) {
  if (typeof code !== 'string' || !code.trim()) return 'must be JavaScript: the body of a function';
  try {
    new AsyncFunction('req', 'state', 'util', code);
    return '';
  } catch (error) {
    return `does not parse (${error.message})`;
  }
}

// ---- Templates: "{{params.id}}", "{{now+1d}}", "{{uuid}}" inside any string of a body or header.

const TIME = /^(now|unix|unixms|date)((?:[+-]\d+[smhd])*)$/;
const UNIT = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `now`, `unix`, `unixms` or `date`, moved by offsets such as `+1d-2h`; undefined when `expr` is none of those. */
export function timeValue(expr, at = Date.now()) {
  const m = TIME.exec(expr);
  if (!m) return undefined;
  let t = at;
  for (const [, sign, n, unit] of m[2].matchAll(/([+-])(\d+)([smhd])/g)) t += (sign === '-' ? -1 : 1) * Number(n) * UNIT[unit];
  if (m[1] === 'unix') return Math.floor(t / 1000);
  if (m[1] === 'unixms') return t;
  if (m[1] === 'date') return new Date(t).toISOString().slice(0, 10);
  return new Date(t).toISOString();
}

function valueOf(expr, ctx) {
  const e = expr.trim();
  if (e === 'uuid') return randomUUID();
  if (e === 'id') return randomBytes(6).toString('hex');
  const time = timeValue(e);
  if (time !== undefined) return time;
  let v = ctx;
  for (const key of e.split('.')) {
    if (v == null || typeof v !== 'object') return undefined;
    v = v[key];
  }
  return v;
}

/** A template with its `{{…}}` filled in. A string that is one whole expression keeps the value's type. */
export function render(template, ctx) {
  if (typeof template === 'string') {
    const whole = /^\{\{([^{}]+)\}\}$/.exec(template);
    if (whole) return valueOf(whole[1], ctx) ?? null;
    return template.replace(/\{\{([^{}]+)\}\}/g, (_, e) => {
      const v = valueOf(e, ctx);
      return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(template)) return template.map((t) => render(t, ctx));
  if (isObject(template)) return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, render(v, ctx)]));
  return template;
}

// ---- Routes

/** The first route that answers `method path`, with the path's `:params`; null when none does. */
export function matchRoute(routes, method, path) {
  const parts = path.split('/').filter(Boolean);
  for (const route of routes) {
    const m = String(route.method ?? 'GET').toUpperCase();
    if (m !== 'ANY' && m !== method) continue;
    const want = String(route.path).split('/').filter(Boolean);
    const params = {};
    let ok = true;
    for (let i = 0; i < want.length; i++) {
      if (want[i] === '*') {
        params['*'] = parts.slice(i).map(decodeURIComponent).join('/');
        break;
      }
      if (i >= parts.length) {
        ok = false;
        break;
      }
      if (want[i].startsWith(':')) params[want[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (want[i] !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok && (want[want.length - 1] === '*' || want.length === parts.length)) return { route, params };
  }
  return null;
}

function parseBody(raw, type) {
  if (!raw) return undefined;
  if (/json/i.test(type)) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (/x-www-form-urlencoded/i.test(type)) return Object.fromEntries(new URLSearchParams(raw));
  return raw;
}

// ---- One fake

/**
 * A running fake: `answer(request)` gives the response for one request, and keeps the fake's state between
 * them. `opts.url` is the fake's own address, `opts.appUrl` the app under test, `opts.log(entry)` receives
 * every request and webhook, `opts.fetch` sends webhooks (replaceable in tests).
 */
export function createFake(def, opts = {}) {
  const log = opts.log ?? (() => {});
  const send = opts.fetch ?? fetch;
  const appUrl = (opts.appUrl ?? '').replace(/\/$/, '');
  const compiled = new Map();
  const compile = (code) => {
    if (!compiled.has(code)) compiled.set(code, new AsyncFunction('req', 'state', 'util', code));
    return compiled.get(code);
  };
  const initial = () => structuredClone(def.state ?? {});
  let state = initial();
  const requests = [];
  const record = (entry) => {
    const line = { at: new Date().toISOString(), fake: def.name, ...entry };
    requests.push(line);
    if (requests.length > 500) requests.shift();
    log(line);
  };
  const env = { URL: opts.url ?? '', APP_URL: appUrl };

  const util = {
    uuid: () => randomUUID(),
    id: () => randomBytes(6).toString('hex'),
    /** The same words templates use: `util.time('unix+1d')`. */
    time: (expr = 'now') => timeValue(expr),
    hmac: (algorithm, secret, text, encoding = 'hex') => createHmac(algorithm, secret).update(text).digest(encoding),
    url: env.URL,
    appUrl,
    /** Sends one of the fake's webhooks to the app, a moment after the current response. */
    webhook: (name, payload) => void fire(name, payload).catch(() => {}),
    /** Any other call back into the app, after the current response (`path` starts with /). */
    callApp: (path, init = {}) => void later(() => deliver('callApp', path, init)).catch(() => {}),
  };

  const later = (fn, ms = 250) => new Promise((resolve, reject) => setTimeout(() => fn().then(resolve, reject), ms));
  async function deliver(name, path, init) {
    const url = path.startsWith('/') ? `${appUrl}${path}` : path;
    try {
      const res = await send(url, init);
      record({ webhook: name, url, status: res.status });
      return res.status;
    } catch (error) {
      record({ webhook: name, url, status: 0, error: String(error?.message ?? error).slice(0, 200) });
      return 0;
    }
  }
  /** Sends the named webhook now; resolves with the app's status (0 when it couldn't be reached). */
  async function fire(name, payload, wait = 250) {
    const hook = (def.webhooks ?? []).find((w) => w.name === name);
    if (!hook) throw new Error(`The ${def.name} fake has no webhook named ${name}`);
    const ctx = { payload: payload ?? {}, state, env };
    let headers = render(hook.headers ?? {}, ctx);
    let body = hook.body === undefined ? payload ?? {} : render(hook.body, ctx);
    if (hook.handler) {
      const out = (await compile(hook.handler)({ payload: payload ?? {} }, state, util)) ?? {};
      headers = { ...headers, ...(out.headers ?? {}) };
      if (out.body !== undefined) body = out.body;
    }
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const init = { method: hook.method ?? 'POST', headers: { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers }, body: text };
    return later(() => deliver(name, render(hook.path, ctx), init), wait);
  }

  /** The fake's own controls, for a test: what it was asked, its state, a webhook to send. */
  async function control(method, path, body) {
    if (path === '/__fake/health') return { status: 200, body: { fake: def.name, routes: (def.routes ?? []).length, webhooks: (def.webhooks ?? []).map((w) => w.name) } };
    if (path === '/__fake/requests') return { status: 200, body: requests };
    if (path === '/__fake/state' && method === 'GET') return { status: 200, body: state };
    if (path === '/__fake/state' && method === 'PUT' && isObject(body)) {
      state = body;
      return { status: 200, body: state };
    }
    if (path === '/__fake/reset' && method === 'POST') {
      state = initial();
      requests.length = 0;
      return { status: 200, body: { ok: true } };
    }
    const hook = /^\/__fake\/webhooks\/([^/]+)$/.exec(path);
    if (hook && method === 'POST') {
      try {
        return { status: 200, body: { sent: decodeURIComponent(hook[1]), status: await fire(decodeURIComponent(hook[1]), body, 0) } };
      } catch (error) {
        return { status: 404, body: { error: error.message } };
      }
    }
    return { status: 404, body: { error: `No such control: ${method} ${path}` } };
  }

  async function answer({ method, path, query = {}, headers = {}, rawBody = '' }) {
    const body = parseBody(rawBody, headers['content-type'] ?? '');
    if (path.startsWith('/__fake/')) return control(method, path, body);
    const started = Date.now();
    const hit = matchRoute(def.routes ?? [], method, path);
    const seen = { method, path, ...(Object.keys(query).length ? { query } : {}), ...(rawBody ? { body: rawBody.slice(0, 2000) } : {}) };
    if (!hit) {
      // Loud on purpose: a call nobody described is how you learn what the fake still needs.
      record({ ...seen, status: 501, route: null });
      return { status: 501, body: { error: `The ${def.name} fake has no route for ${method} ${path}`, fake: def.name } };
    }
    const { route, params } = hit;
    const req = { method, path, params, query, headers, body };
    let out;
    try {
      if (route.handler) out = (await compile(route.handler)(req, state, util)) ?? {};
      else {
        const ctx = { ...req, state, env };
        out = { status: route.status, headers: render(route.headers ?? {}, ctx), body: render(route.body, ctx) };
      }
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 300);
      record({ ...seen, status: 500, route: route.path, error: message });
      return { status: 500, body: { error: `The ${def.name} fake's handler for ${method} ${route.path} threw: ${message}`, fake: def.name } };
    }
    const status = Number.isInteger(out.status) ? out.status : (route.status ?? 200);
    record({ ...seen, status, route: route.path, ms: Date.now() - started });
    return { status, headers: { ...(route.handler ? render(route.headers ?? {}, { ...req, state, env }) : {}), ...(out.headers ?? {}) }, body: out.body };
  }

  return { name: def.name, answer, fire, requests, getState: () => state };
}

// ---- The plan: which fakes run, where, and what the app is told

function readDefinitions(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const file = join(dir, f);
      try {
        return { file, def: JSON.parse(readFileSync(file, 'utf8')) };
      } catch (error) {
        return { file, def: null, problems: [`not JSON (${error.message})`] };
      }
    });
}

/**
 * The fakes to run: HQ's, with the repo's laid over them by name. A repo file with `"enabled": false`
 * switches that fake off on this branch. A definition that can't run is left out and named in `skipped`.
 */
export function planFakes({ hqDir, repoDir = REPO_DIR, basePort = 4600, appUrl = '' }) {
  const byName = new Map();
  const skipped = [];
  for (const [source, dir] of [['hq', hqDir], ['repo', repoDir]]) {
    for (const { file, def, problems = def ? checkFake(def) : [] } of readDefinitions(dir)) {
      if (problems.length) skipped.push({ file, problems });
      else byName.set(def.name, { source, file, def });
    }
  }
  const fakes = [...byName.values()]
    .filter((f) => f.def.enabled !== false)
    .sort((a, b) => a.def.name.localeCompare(b.def.name))
    .map((f, i) => {
      const port = basePort + i;
      const host = `localhost:${port}`;
      const url = `http://${host}`;
      const fill = (v) => v.replace(/\$\{URL\}/g, url).replace(/\$\{HOST\}/g, host).replace(/\$\{PORT\}/g, String(port)).replace(/\$\{APP_URL\}/g, appUrl);
      return { name: f.def.name, source: f.source, file: f.file, port, url, hosts: f.def.hosts ?? [], env: Object.fromEntries(Object.entries(f.def.env ?? {}).map(([k, v]) => [k, fill(v)])) };
    });
  return { appUrl, fakes, skipped };
}

// ---- The server

function corsHeaders(req) {
  return {
    'access-control-allow-origin': req.headers.origin ?? '*',
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*',
    'access-control-expose-headers': '*',
    vary: 'origin',
  };
}

/** Serves one fake on `port`. Browser code calls it straight from the app's pages, so every answer allows any origin. */
export function serveFake(fake, port) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const cors = corsHeaders(req);
      if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
      const url = new URL(req.url ?? '/', 'http://fake');
      let out;
      try {
        out = await fake.answer({ method: req.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, rawBody: Buffer.concat(chunks).toString('utf8') });
      } catch (error) {
        out = { status: 500, body: { error: String(error?.message ?? error) } };
      }
      const body = out.body == null ? '' : typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
      const type = out.body == null ? {} : { 'content-type': typeof out.body === 'string' ? 'text/plain; charset=utf-8' : 'application/json' };
      res.writeHead(out.status ?? 200, { ...cors, ...type, ...Object.fromEntries(Object.entries(out.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])) }).end(body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}

// ---- Command line

async function main() {
  const out = join(process.env.SCOUT_OUT || 'scout-out', 'fakes');
  const planFile = join(out, 'plan.json');
  const [command, arg] = process.argv.slice(2);
  const readPlan = () => (existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : { fakes: [], skipped: [] });

  if (command === 'check') {
    let def;
    try {
      def = JSON.parse(readFileSync(arg, 'utf8'));
    } catch (error) {
      console.error(`[Fakes] ${arg} is not JSON: ${error.message}`);
      process.exit(1);
    }
    const problems = checkFake(def);
    for (const p of problems) console.error(`[Fakes] ${p}`);
    if (!problems.length) console.error(`[Fakes] ${def.name}: ${def.routes.length} route(s), ${(def.webhooks ?? []).length} webhook(s), ${Object.keys(def.env ?? {}).length} variable(s)`);
    process.exit(problems.length ? 1 : 0);
  }
  if (command === 'plan') {
    mkdirSync(out, { recursive: true });
    const plan = planFakes({ hqDir: join(out, 'hq'), basePort: Number(process.env.SCOUT_FAKES_PORT) || 4600, appUrl: process.env.SCOUT_APP_URL || '' });
    writeFileSync(planFile, JSON.stringify(plan, null, 2));
    for (const s of plan.skipped) console.error(`::warning::[Fakes] Leaving out ${s.file}: ${s.problems.join('; ')}`);
    for (const f of plan.fakes) console.error(`[Fakes] ${f.name} at ${f.url} (from ${f.source === 'repo' ? f.file : 'Agent HQ'})`);
    return;
  }
  if (command === 'env') return void process.stdout.write(readPlan().fakes.flatMap((f) => Object.entries(f.env).map(([k, v]) => `${k}=${v}\n`)).join(''));
  if (command === 'hosts') return void process.stdout.write([...new Set(readPlan().fakes.flatMap((f) => f.hosts))].join(' '));
  if (command === 'urls') return void process.stdout.write(readPlan().fakes.map((f) => `${f.url}/__fake/health`).join(' '));
  if (command === 'serve') {
    const plan = readPlan();
    const logFile = join(out, 'requests.ndjson');
    writeFileSync(logFile, '');
    for (const f of plan.fakes) {
      const def = JSON.parse(readFileSync(f.file, 'utf8'));
      const fake = createFake(def, {
        url: f.url,
        appUrl: plan.appUrl,
        log: (entry) => {
          appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
          console.log(`[Fakes] ${entry.fake} ${entry.webhook ? `→ ${entry.webhook} ${entry.url}` : `${entry.method} ${entry.path}`} ${entry.status}${entry.route === null ? ' (no route)' : ''}${entry.error ? ` ${entry.error}` : ''}`);
        },
      });
      await serveFake(fake, f.port);
      console.log(`[Fakes] ${f.name} is listening at ${f.url}`);
    }
    return;
  }
  console.error('Usage: fakes.mjs plan | env | hosts | urls | serve | check <file>');
  process.exit(1);
}

// `.crew/` may be a link to the crew's checkout: compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
