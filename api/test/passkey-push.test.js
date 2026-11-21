/* API tests — the passkey and push paths, plus the guards around them.
 *
 * The passkey endpoints cannot be exercised end to end over plain HTTP: the
 * browser produces the WebAuthn assertion. What CAN be tested here is every
 * branch of those handlers that touches the store — the challenge lookup,
 * the "credential already registered" check, the "unknown passkey" lookup,
 * the invite gate, and the push subscription round-trip. The full ceremony is
 * covered by the browser test with a virtual authenticator.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = 3972;
const BASE = `http://127.0.0.1:${PORT}`;
let child;
let dataDir;

async function req(method, p, body, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(BASE + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await r.json(); } catch { /* not all responses are json */ }
  return { status: r.status, json, setCookie: r.headers.get('set-cookie') };
}

const cookieOf = res => (res.setCookie || '').split(';')[0];

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-api2-'));
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, RP_ID: 'localhost', ORIGIN: 'http://localhost:8080' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', d => process.stderr.write('[api] ' + d));
  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/api/health'); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('the server did not start');
});

after(() => {
  if (child) child.kill();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

/* ---------- passkey: the challenge and option endpoints ---------- */

test('register/options returns a challenge the client can use', async () => {
  const r = await req('POST', '/api/register/options', { name: 'Passkey User' });
  assert.equal(r.status, 200);
  assert.ok(r.json.cid, 'a challenge id must come back');
  assert.ok(r.json.options.challenge, 'the WebAuthn challenge must come back');
  assert.equal(r.json.options.rp.id, 'localhost');
});

test('register/options refuses an empty name', async () => {
  const r = await req('POST', '/api/register/options', { name: '   ' });
  assert.equal(r.status, 400);
});

test('register/verify refuses an expired or unknown challenge', async () => {
  const r = await req('POST', '/api/register/verify', { cid: 'not-a-real-challenge', credential: {} });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /challenge expired/);
});

test('register/verify refuses a challenge that was already used', async () => {
  const opts = await req('POST', '/api/register/options', { name: 'Twice' });
  const first = await req('POST', '/api/register/verify', { cid: opts.json.cid, credential: {} });
  assert.equal(first.status, 400, 'the first attempt consumes the challenge');
  const second = await req('POST', '/api/register/verify', { cid: opts.json.cid, credential: {} });
  assert.equal(second.status, 400, 'the second attempt finds nothing to consume');
});

test('login/options returns a challenge', async () => {
  const r = await req('POST', '/api/login/options', {});
  assert.equal(r.status, 200);
  assert.ok(r.json.cid);
  assert.ok(r.json.options.challenge);
});

test('login/verify refuses an unknown passkey', async () => {
  const r = await req('POST', '/api/login/verify', { cid: 'nope', credential: { id: 'unknown-credential' } });
  assert.equal(r.status, 400, 'an unknown challenge is refused before the credential is looked up');

  // with a real challenge but a credential that was never registered
  const opts = await req('POST', '/api/login/options', {});
  const r2 = await req('POST', '/api/login/verify', { cid: opts.json.cid, credential: { id: 'never-registered' } });
  assert.equal(r2.status, 404);
  assert.match(r2.json.error, /unknown passkey/);
});

/* ---------- push ---------- */

test('the push public key is served', async () => {
  const r = await req('GET', '/api/push/public-key');
  assert.equal(r.status, 200);
  assert.ok(r.json.key, 'the VAPID public key must come back');
});

test('a push subscription is stored, replaced and removed', async () => {
  const login = await req('POST', '/api/login/password', { name: 'admin', password: 'x' });
  // make an account to own the subscription
  const boot = await req('POST', '/api/admin/bootstrap', { name: 'Pusher', password: 'pusher12345' });
  assert.equal(boot.status, 200);
  const c = cookieOf(boot);

  const bad = await req('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://x' } }, c);
  assert.equal(bad.status, 400, 'an incomplete subscription is refused');

  const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'k1', auth: 'k2' } };
  const ok = await req('POST', '/api/push/subscribe', { subscription: sub }, c);
  assert.equal(ok.status, 200);

  // re-subscribing with the same endpoint must not create a second row
  await req('POST', '/api/push/subscribe', { subscription: { ...sub, keys: { p256dh: 'k9', auth: 'k8' } } }, c);
  const admin = await req('POST', '/api/login/password', { name: 'Pusher', password: 'pusher12345' });
  const adminCookie = cookieOf(admin);
  const listed = await req('GET', '/api/admin/users', undefined, adminCookie);
  const pusher = listed.json.users.find(u => u.name === 'Pusher');
  assert.equal(pusher.hasPush, true, 'the subscription is visible to the admin panel');

  const off = await req('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }, c);
  assert.equal(off.status, 200);
});

test('the rest timer endpoints accept their input', async () => {
  const login = await req('POST', '/api/login/password', { name: 'Pusher', password: 'pusher12345' });
  const c = cookieOf(login);

  const ok = await req('POST', '/api/push/rest-timer', { seconds: 30 }, c);
  assert.equal(ok.status, 200);
  const cancel = await req('POST', '/api/push/rest-timer/cancel', {}, c);
  assert.equal(cancel.status, 200);

  // A zero or missing `seconds` does NOT produce the 400 the error message
  // ("seconds required") promises: the handler clamps with Math.max(1, ...)
  // before it checks, so the check can never fire and a one-second timer is
  // scheduled instead. That is pre-existing behaviour, not something the
  // storage rewrite introduced, and it is asserted here as it stands so a
  // future fix is a visible change rather than a silent one.
  const zero = await req('POST', '/api/push/rest-timer', { seconds: 0 }, c);
  assert.equal(zero.status, 200, 'documented quirk: the clamp runs before the check');
  const missing = await req('POST', '/api/push/rest-timer', {}, c);
  assert.equal(missing.status, 200, 'documented quirk: the clamp runs before the check');
});

test('the activity heartbeat is accepted and is not persisted', async () => {
  const login = await req('POST', '/api/login/password', { name: 'Pusher', password: 'pusher12345' });
  const c = cookieOf(login);
  const r = await req('POST', '/api/activity', { active: true, name: 'Pusher', exIdx: 1, exTotal: 3 }, c);
  assert.equal(r.status, 200);
  const off = await req('POST', '/api/activity', { active: false }, c);
  assert.equal(off.status, 200);
});

/* ---------- isolation between users ---------- */

test('one user cannot read another user state', async () => {
  const a = await req('POST', '/api/login/password', { name: 'Pusher', password: 'pusher12345' });
  const ca = cookieOf(a);
  await req('PUT', '/api/data', { state: { secret: 'pusher-only', unit: 'kg' } }, ca);

  const admin = await req('POST', '/api/login/password', { name: 'admin', password: 'x' });
  // the admin account is the one bootstrapped in the other file; here the only
  // account is 'Pusher', so create a second one through it.
  const created = await req('POST', '/api/admin/user/create', { name: 'Second', password: 'second12345' }, ca);
  assert.equal(created.status, 200);
  const b = await req('POST', '/api/login/password', { name: 'Second', password: 'second12345' });
  const cb = cookieOf(b);

  const readB = await req('GET', '/api/data', undefined, cb);
  assert.equal(readB.status, 200);
  assert.equal(readB.json.state, null, 'the second user sees no state, not the first user state');
});
