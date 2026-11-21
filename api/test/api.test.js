/* API tests — node:test, no dependencies.
 *
 * These start the real server against a throwaway data directory and drive it
 * over HTTP. The point is that the storage rewrite did not change a single
 * response: same status codes, same body shapes, same guards.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resetStore, pgSchemaUrl, isPostgres } from './helpers.js';

const PORT = 3971;
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-api-'));
  // On Postgres each test file gets its own schema, so the files can run in
  // parallel without truncating each other's tables.
  if (isPostgres()) process.env.DATABASE_URL = await pgSchemaUrl('api');
  await resetStore();
  // If something is already listening on the port, the requests would go to
  // that process and the assertions would be about someone else's state.
  // Fail loudly instead of testing the wrong server.
  try {
    const probe = await fetch(BASE + '/api/health');
    if (probe.ok) throw new Error('port ' + PORT + ' is already in use by another server');
  } catch (e) {
    if (e.message && e.message.includes('already in use')) throw e;
  }
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, RP_ID: 'localhost', ORIGIN: 'http://localhost:8080' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', d => { if (/Error|error:/.test(String(d))) process.stderr.write('[api] ' + d); });
  await resetStore(dataDir);
  // wait for the port to answer
  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/api/health'); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('the server did not start');
});

after(() => {
  if (child) child.kill();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('health and config report an empty instance', async () => {
  const h = await req('GET', '/api/health');
  assert.equal(h.status, 200);
  assert.deepEqual(h.json, { ok: true, users: 0 });
  const c = await req('GET', '/api/config');
  assert.equal(c.json.needs_bootstrap, true);
  assert.equal(c.json.invite_only, false);
});

test('bootstrap creates the first account and it is an admin', async () => {
  const r = await req('POST', '/api/admin/bootstrap', { name: 'Owner', password: 'owner12345' });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.admin, true);
  assert.ok(cookieOf(r));
  assert.deepEqual((await req('GET', '/api/config')).json, { invite_only: false, needs_bootstrap: false });
});

test('bootstrap refuses to run twice', async () => {
  const r = await req('POST', '/api/admin/bootstrap', { name: 'Second', password: 'second123' });
  assert.equal(r.status, 409);
});

test('signing in with the right password works, the wrong one does not', async () => {
  const ok = await req('POST', '/api/login/password', { name: 'Owner', password: 'owner12345' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.name, 'Owner');
  assert.equal(ok.json.user.admin, true);

  const bad = await req('POST', '/api/login/password', { name: 'Owner', password: 'nope' });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error, 'invalid name or password');

  const ghost = await req('POST', '/api/login/password', { name: 'Ghost', password: 'nope' });
  assert.equal(ghost.status, 401);
  assert.equal(ghost.json.error, bad.json.error, 'the message must not reveal whether the account exists');
});

test('the password rules are enforced', async () => {
  const short = await req('POST', '/api/register/password', { name: 'X', password: 'short' });
  assert.equal(short.status, 400);
  const long = await req('POST', '/api/register/password', { name: 'X', password: 'x'.repeat(201) });
  assert.equal(long.status, 400);
  const noName = await req('POST', '/api/register/password', { password: 'longenough1' });
  assert.equal(noName.status, 400);
});

test('the admin can create a user and that user can sign in', async () => {
  const login = await req('POST', '/api/login/password', { name: 'Owner', password: 'owner12345' });
  const c = cookieOf(login);

  const created = await req('POST', '/api/admin/user/create', { name: 'Ana', password: 'ana12345' }, c);
  assert.equal(created.status, 200);
  assert.equal(created.json.user.admin, false);

  const ana = await req('POST', '/api/login/password', { name: 'Ana', password: 'ana12345' });
  assert.equal(ana.status, 200);
  assert.equal(ana.json.user.name, 'Ana');
});

test('a duplicate name is refused', async () => {
  const login = await req('POST', '/api/login/password', { name: 'Owner', password: 'owner12345' });
  const c = cookieOf(login);
  const dup = await req('POST', '/api/admin/user/create', { name: 'ana', password: 'another12345' }, c);
  assert.equal(dup.status, 409);
});

test('creating a user without being an admin is refused', async () => {
  const r = await req('POST', '/api/admin/user/create', { name: 'Nope', password: 'nope12345' });
  assert.equal(r.status, 401);
});

test('the admin can reset a password and the old one stops working', async () => {
  const login = await req('POST', '/api/login/password', { name: 'Owner', password: 'owner12345' });
  const c = cookieOf(login);
  const list = await req('GET', '/api/admin/users', undefined, c);
  const ana = list.json.users.find(u => u.name === 'Ana');

  assert.equal(ana.hasPassword, true);
  assert.equal(ana.admin, false);

  const reset = await req('POST', '/api/admin/user/password', { id: ana.id, password: 'newpass12345' }, c);
  assert.equal(reset.status, 200);

  const withNew = await req('POST', '/api/login/password', { name: 'Ana', password: 'newpass12345' });
  assert.equal(withNew.status, 200);
  const withOld = await req('POST', '/api/login/password', { name: 'Ana', password: 'ana12345' });
  assert.equal(withOld.status, 401);
});

test('state round-trips through the store', async () => {
  const ana = await req('POST', '/api/login/password', { name: 'Ana', password: 'newpass12345' });
  const c = cookieOf(ana);
  const state = { unit: 'kg', workouts: [{ d: '2026-01-01', e: [] }], _ts: 42 };
  const put = await req('PUT', '/api/data', { state }, c);
  assert.equal(put.status, 200);
  const got = await req('GET', '/api/data', undefined, c);
  assert.deepEqual(got.json.state, state);
});

test('an in-progress workout is never stored', async () => {
  const ana = await req('POST', '/api/login/password', { name: 'Ana', password: 'newpass12345' });
  const c = cookieOf(ana);
  await req('PUT', '/api/data', { state: { unit: 'kg', active: { exIdx: 2 }, workouts: [] } }, c);
  const got = await req('GET', '/api/data', undefined, c);
  assert.equal(got.json.state.active, undefined);
  assert.equal(got.json.state.unit, 'kg');
});

test('the admin user list reports what the panel needs', async () => {
  const login = await req('POST', '/api/login/password', { name: 'Owner', password: 'owner12345' });
  const c = cookieOf(login);
  const r = await req('GET', '/api/admin/users', undefined, c);
  assert.equal(r.status, 200);
  assert.equal(r.json.users.length, 2);
  const owner = r.json.users.find(u => u.name === 'Owner');
  assert.equal(owner.admin, true);
  assert.equal(owner.hasPassword, true);
  assert.equal(owner.workouts, 0);
  assert.equal(owner.hasPush, false);
  assert.ok('lastSync' in owner);
});

test('an account can be disabled and then locked out', async () => {
  const login = await req('POST', '/api/login/password', { name: 'Owner', password: 'owner12345' });
  const c = cookieOf(login);
  const list = await req('GET', '/api/admin/users', undefined, c);
  const ana = list.json.users.find(u => u.name === 'Ana');

  const dis = await req('POST', '/api/admin/user/disable', { id: ana.id, disabled: true }, c);
  assert.equal(dis.status, 200);
  assert.equal(dis.json.disabled, true);

  const blocked = await req('POST', '/api/login/password', { name: 'Ana', password: 'newpass12345' });
  assert.equal(blocked.status, 403);

  await req('POST', '/api/admin/user/disable', { id: ana.id, disabled: false }, c);
  const back = await req('POST', '/api/login/password', { name: 'Ana', password: 'newpass12345' });
  assert.equal(back.status, 200);
});

test('an invite code can be generated, used and revoked', async () => {
  const login = await req('POST', '/api/login/password', { name: 'Owner', password: 'owner12345' });
  const c = cookieOf(login);

  const made = await req('POST', '/api/admin/invites/new', { note: 'for a friend' }, c);
  assert.equal(made.status, 200);
  const code = made.json.invite.code;
  assert.ok(code);

  const listed = await req('GET', '/api/admin/invites', undefined, c);
  assert.ok(listed.json.invites.some(i => i.code === code));

  const revoked = await req('POST', '/api/admin/invites/revoke', { code }, c);
  assert.equal(revoked.status, 200);
  const after = await req('GET', '/api/admin/invites', undefined, c);
  assert.equal(after.json.invites.some(i => i.code === code), false);
});

test('the store and the key material are on disk', { skip: isPostgres() && 'the store is a database, not a file' }, () => {
  // Only meaningful for SQLite: with Postgres the records live in the
  // database, but the secret and the push keys are still files.
  const files = fs.readdirSync(dataDir).sort();
  assert.ok(files.includes('gym.db'), 'the sqlite file must exist');
  assert.ok(files.includes('secret'), 'the session secret must still be there');
  assert.ok(files.includes('vapid.json'), 'the push keys must still be there');
});
