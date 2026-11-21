/* Repository tests, run against a driver.
 *
 * The same suite runs against SQLite and against Postgres: the repository is
 * the layer that has to be engine-agnostic, so the same assertions are the
 * proof. The engine-specific part is only how a store is opened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

export function repoSuite(name, openStore) {
  const fresh = () => openStore();

  test(name + ': users: insert, read back, and the flags round-trip', async () => {
    const { db, repo } = await fresh();
    await repo.users.insert({ id: 'u1', name: 'Ana', created: '2026-01-01T00:00:00.000Z', admin: true, disabled: false, sv: 0, passwordHash: 'hash', invitedBy: 'CODE' });
    const u = await repo.users.byId('u1');
    assert.equal(u.name, 'Ana');
    assert.equal(u.admin, true);
    assert.equal(u.disabled, false);
    assert.equal(u.passwordHash, 'hash');
    assert.equal(u.invitedBy, 'CODE');
    assert.equal(u.sv, 0);
    assert.equal(await repo.users.count(), 1);
    await db.close();
  });

  test(name + ': users: lookup by name is case-insensitive', async () => {
    const { db, repo } = await fresh();
    await repo.users.insert({ id: 'u1', name: 'Ana', created: '', admin: false, disabled: false, sv: 0 });
    assert.ok(await repo.users.byName('ana'));
    assert.ok(await repo.users.byName('ANA'));
    assert.equal(await repo.users.existsByName('AnA'), true);
    assert.equal(await repo.users.byName('nope'), null);
    assert.equal(await repo.users.existsByName('nope'), false);
    await db.close();
  });

  test(name + ': users: count is a number, comparable with ===', async () => {
    const { db, repo } = await fresh();
    // Postgres returns COUNT(*) as a bigint; the repository has to normalise
    // it or `count() === 0` is false on an empty instance.
    assert.equal(await repo.users.count(), 0);
    assert.equal(typeof await repo.users.count(), 'number');
    await repo.users.insert({ id: 'u1', name: 'A', created: '', admin: false, disabled: false, sv: 0 });
    assert.equal(await repo.users.count(), 1);
    await db.close();
  });

  test(name + ': users: update writes the whole row and keeps the password', async () => {
    const { db, repo } = await fresh();
    await repo.users.insert({ id: 'u1', name: 'Ana', created: '', admin: false, disabled: false, sv: 0, passwordHash: 'keepme' });
    const u = await repo.users.byId('u1');
    u.passwordHash = 'newhash';
    u.sv = 3;
    u.disabled = true;
    await repo.users.update(u);
    const after = await repo.users.byId('u1');
    assert.equal(after.passwordHash, 'newhash');
    assert.equal(after.sv, 3);
    assert.equal(after.disabled, true);
    assert.equal(after.name, 'Ana');
    await db.close();
  });

  test(name + ': creds: transports survive as an array', async () => {
    const { db, repo } = await fresh();
    await repo.creds.insert({ id: 'c1', userId: 'u1', publicKey: 'pk', counter: 4, transports: ['usb', 'nfc'] });
    const c = await repo.creds.byId('c1');
    assert.equal(c.userId, 'u1');
    assert.equal(c.counter, 4);
    assert.deepEqual(c.transports, ['usb', 'nfc']);
    assert.equal(await repo.creds.byId('missing'), null);
    await db.close();
  });

  test(name + ': subs: the endpoint is the primary key', async () => {
    const { db, repo } = await fresh();
    await repo.subs.insert({ endpoint: 'e1', userId: 'u1', keys: { p256dh: 'a', auth: 'b' } });
    await repo.subs.insert({ endpoint: 'e2', userId: 'u1', keys: {} });
    await assert.rejects(() => repo.subs.insert({ endpoint: 'e1', userId: 'u2', keys: {} }));
    await repo.subs.deleteByEndpoint('e1');
    await repo.subs.insert({ endpoint: 'e1', userId: 'u2', keys: { p256dh: 'c' } });
    assert.equal((await repo.subs.byUser('u1')).length, 1);
    assert.equal((await repo.subs.byUser('u2')).length, 1);
    assert.equal(await repo.subs.hasForUser('u2'), true);
    assert.equal(await repo.subs.hasForUser('u9'), false);
    await repo.subs.deleteByUserEndpoint('u1', 'e2');
    assert.equal((await repo.subs.byUser('u1')).length, 0);
    await db.close();
  });

  test(name + ': invites: validByCode rejects used, revoked and unknown', async () => {
    const { db, repo } = await fresh();
    await repo.invites.insert({ code: 'AAA', note: 'x' });
    assert.ok(await repo.invites.validByCode('AAA'));
    const used = await repo.invites.byCode('AAA');
    used.usedBy = 'u1'; used.usedAt = 'now';
    await repo.invites.update(used);
    assert.equal(await repo.invites.validByCode('AAA'), null);
    await repo.invites.insert({ code: 'BBB' });
    const rev = await repo.invites.byCode('BBB');
    rev.revoked = true;
    await repo.invites.update(rev);
    assert.equal(await repo.invites.validByCode('BBB'), null);
    assert.equal(await repo.invites.validByCode('CCC'), null);
    assert.equal(await repo.invites.existsByCode('AAA'), true);
    await repo.invites.deleteByCode('AAA');
    assert.equal(await repo.invites.byCode('AAA'), null);
    await db.close();
  });

  test(name + ': state: set, get, overwrite and per-user isolation', async () => {
    const { db, repo } = await fresh();
    assert.equal(await repo.state.get('u1'), null);
    const s = { workouts: [{ d: '2026-01-01' }], unit: 'kg', _ts: 123 };
    await repo.state.set('u1', s);
    assert.deepEqual(await repo.state.get('u1'), s);
    await repo.state.set('u1', { unit: 'lb' });
    assert.deepEqual(await repo.state.get('u1'), { unit: 'lb' });
    assert.equal(await repo.state.get('u2'), null);
    await db.close();
  });

  test(name + ': a transaction that throws leaves nothing behind', async () => {
    const { db, repo } = await fresh();
    await assert.rejects(() => db.tx(async () => {
      await repo.users.insert({ id: 'u1', name: 'A', created: '', admin: false, disabled: false, sv: 0 });
      throw new Error('boom');
    }), /boom/);
    assert.equal(await repo.users.count(), 0);
    await db.close();
  });

  test(name + ': a transaction that succeeds commits', async () => {
    const { db, repo } = await fresh();
    await db.tx(async () => {
      await repo.users.insert({ id: 'u1', name: 'A', created: '', admin: false, disabled: false, sv: 0 });
      await repo.creds.insert({ id: 'c1', userId: 'u1', publicKey: 'pk' });
    });
    assert.equal(await repo.users.count(), 1);
    assert.ok(await repo.creds.byId('c1'));
    await db.close();
  });
}
