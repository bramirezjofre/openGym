/* Repository tests — node:test, no dependencies.
 *
 * These run against a real SQLite file in a temp directory: the repository is
 * the layer that was rewritten, so it is the layer that has to be proven.
 * Run with: node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../db.js';
import { createRepo } from '../repo.js';
import { schemaFor } from '../schema.js';

function freshRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-repo-'));
  const db = openDb({ file: path.join(dir, 'test.db') });
  db.exec(schemaFor(db.driver));
  return { db, repo: createRepo(db), dir };
}

const user = (over = {}) => ({
  id: 'u1', name: 'Ana', created: '2026-01-01T00:00:00.000Z',
  admin: false, disabled: false, sv: 0, ...over
});

test('users: insert, read back, and the flags round-trip', () => {
  const { db, repo } = freshRepo();
  repo.users.insert(user({ admin: true, passwordHash: 'hash', invitedBy: 'CODE' }));
  const u = repo.users.byId('u1');
  assert.equal(u.name, 'Ana');
  assert.equal(u.admin, true);
  assert.equal(u.disabled, false);
  assert.equal(u.passwordHash, 'hash');
  assert.equal(u.invitedBy, 'CODE');
  assert.equal(u.sv, 0);
  assert.equal(repo.users.count(), 1);
  db.close();
});

test('users: lookup by name is case-insensitive', () => {
  const { db, repo } = freshRepo();
  repo.users.insert(user());
  assert.ok(repo.users.byName('ana'));
  assert.ok(repo.users.byName('ANA'));
  assert.ok(repo.users.existsByName('AnA'));
  assert.equal(repo.users.byName('nope'), null);
  assert.equal(repo.users.existsByName('nope'), false);
  db.close();
});

test('users: update writes the whole row', () => {
  const { db, repo } = freshRepo();
  repo.users.insert(user());
  const u = repo.users.byId('u1');
  u.passwordHash = 'newhash';
  u.sv = 3;
  u.disabled = true;
  repo.users.update(u);
  const after = repo.users.byId('u1');
  assert.equal(after.passwordHash, 'newhash');
  assert.equal(after.sv, 3);
  assert.equal(after.disabled, true);
  assert.equal(after.name, 'Ana', 'the name must survive an update');
  db.close();
});

test('users: an update that does not touch the password keeps it', () => {
  const { db, repo } = freshRepo();
  repo.users.insert(user({ passwordHash: 'keepme' }));
  const u = repo.users.byId('u1');
  u.sv = 1;
  repo.users.update(u);
  assert.equal(repo.users.byId('u1').passwordHash, 'keepme');
  db.close();
});

test('creds: insert and read back, transports survive as an array', () => {
  const { db, repo } = freshRepo();
  repo.creds.insert({ id: 'c1', userId: 'u1', publicKey: 'pk', counter: 4, transports: ['usb', 'nfc'] });
  const c = repo.creds.byId('c1');
  assert.equal(c.userId, 'u1');
  assert.equal(c.counter, 4);
  assert.deepEqual(c.transports, ['usb', 'nfc']);
  assert.deepEqual(repo.creds.byId('missing'), null);
  db.close();
});

test('subs: the endpoint is the key, so re-subscribing replaces', () => {
  const { db, repo } = freshRepo();
  repo.subs.insert({ endpoint: 'https://push/1', userId: 'u1', keys: { p256dh: 'a', auth: 'b' } });
  repo.subs.deleteByEndpoint('https://push/1');
  repo.subs.insert({ endpoint: 'https://push/1', userId: 'u2', keys: { p256dh: 'c', auth: 'd' } });
  assert.equal(repo.subs.byUser('u1').length, 0);
  assert.equal(repo.subs.byUser('u2').length, 1);
  assert.deepEqual(repo.subs.byUser('u2')[0].keys, { p256dh: 'c', auth: 'd' });
  assert.equal(repo.subs.hasForUser('u2'), true);
  assert.equal(repo.subs.hasForUser('u1'), false);
  db.close();
});

test('subs: the endpoint belongs to one user, so it is the primary key', () => {
  // The old store keyed subscriptions by endpoint as well: re-subscribing
  // replaced the row, and a push endpoint belongs to one browser profile.
  // The schema keeps that rule, and this test states it.
  const { db, repo } = freshRepo();
  repo.subs.insert({ endpoint: 'e1', userId: 'u1', keys: {} });
  repo.subs.insert({ endpoint: 'e2', userId: 'u1', keys: {} });
  assert.throws(() => repo.subs.insert({ endpoint: 'e1', userId: 'u2', keys: {} }),
    /UNIQUE|constraint/i, 'the same endpoint cannot belong to two users');
  repo.subs.deleteByUserEndpoint('u1', 'e1');
  assert.equal(repo.subs.byUser('u1').length, 1);
  assert.equal(repo.subs.byUser('u2').length, 0);
  db.close();
});

test('invites: validByCode rejects used, revoked and unknown codes', () => {
  const { db, repo } = freshRepo();
  repo.invites.insert({ code: 'AAA', note: 'x' });
  assert.ok(repo.invites.validByCode('AAA'));

  const used = repo.invites.byCode('AAA');
  used.usedBy = 'u1';
  used.usedAt = 'now';
  repo.invites.update(used);
  assert.equal(repo.invites.validByCode('AAA'), null, 'a used invite is not valid');

  repo.invites.insert({ code: 'BBB' });
  const rev = repo.invites.byCode('BBB');
  rev.revoked = true;
  repo.invites.update(rev);
  assert.equal(repo.invites.validByCode('BBB'), null, 'a revoked invite is not valid');

  assert.equal(repo.invites.validByCode('CCC'), null, 'an unknown code is not valid');
  assert.equal(repo.invites.existsByCode('AAA'), true);
  db.close();
});

test('invites: delete by code', () => {
  const { db, repo } = freshRepo();
  repo.invites.insert({ code: 'AAA' });
  repo.invites.deleteByCode('AAA');
  assert.equal(repo.invites.byCode('AAA'), null);
  db.close();
});

test('state: set, get, overwrite and the JSON round-trip', () => {
  const { db, repo } = freshRepo();
  assert.equal(repo.state.get('u1'), null, 'no state yet');
  const s = { workouts: [{ d: '2026-01-01' }], unit: 'kg', _ts: 123 };
  repo.state.set('u1', s);
  assert.deepEqual(repo.state.get('u1'), s);
  repo.state.set('u1', { unit: 'lb' });
  assert.deepEqual(repo.state.get('u1'), { unit: 'lb' }, 'set overwrites, it does not merge');
  db.close();
});

test('state: a second user does not see the first user state', () => {
  const { db, repo } = freshRepo();
  repo.state.set('u1', { secret: 1 });
  assert.equal(repo.state.get('u2'), null);
  db.close();
});

test('a transaction that throws leaves nothing behind', () => {
  const { db, repo } = freshRepo();
  assert.throws(() => db.tx(() => {
    repo.users.insert(user());
    throw new Error('boom');
  }), /boom/);
  assert.equal(repo.users.count(), 0, 'the insert must have been rolled back');
  db.close();
});

test('a transaction that succeeds commits', () => {
  const { db, repo } = freshRepo();
  db.tx(() => {
    repo.users.insert(user());
    repo.creds.insert({ id: 'c1', userId: 'u1', publicKey: 'pk' });
  });
  assert.equal(repo.users.count(), 1);
  assert.ok(repo.creds.byId('c1'));
  db.close();
});

test('the data survives closing and reopening the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-repo-'));
  const file = path.join(dir, 'test.db');
  let db = openDb({ file });
  db.exec(schemaFor(db.driver));
  createRepo(db).users.insert(user({ passwordHash: 'persisted' }));
  db.close();

  db = openDb({ file });
  db.exec(schemaFor(db.driver));
  const u = createRepo(db).users.byId('u1');
  assert.equal(u.passwordHash, 'persisted');
  db.close();
});
