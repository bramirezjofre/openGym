/* opengym-api — repository.
 *
 * The only module that contains SQL. Callers work with plain objects and
 * never see a row, a column name or a placeholder — so the API layer above
 * is unaffected by which engine is behind it.
 *
 * Every query here is inside the ANSI subset: `?` placeholders, `LOWER()`,
 * `INSERT ... ON CONFLICT ... DO UPDATE`, no engine-specific functions. A
 * Postgres driver only has to rewrite `?` to `$1..$n`; the SQL text itself
 * does not change.
 *
 * Object shapes match what the API layer used to hold in memory, so the
 * callers did not have to change shape when the store changed.
 */
export function createRepo(db) {
  /* ---------- users ---------- */

  const rowToUser = r => r ? {
    id: r.id,
    name: r.name,
    created: r.created ?? undefined,
    admin: !!r.admin,
    disabled: !!r.disabled,
    passwordHash: r.password_hash ?? undefined,
    invitedBy: r.invited_by ?? undefined,
    sv: r.session_ver ?? 0,
    lastReminder: r.last_reminder ?? undefined
  } : null;

  const users = {
    count: () => db.get('SELECT COUNT(*) AS n FROM users').n,

    byId: id => rowToUser(db.get('SELECT * FROM users WHERE id = ?', [id])),

    // Case-insensitive: the API layer has always compared
    // `name.toLowerCase() === name.toLowerCase()`.
    byName: name => rowToUser(db.get('SELECT * FROM users WHERE LOWER(name) = LOWER(?)', [name])),

    existsByName: name => !!db.get('SELECT 1 AS x FROM users WHERE LOWER(name) = LOWER(?)', [name]),

    list: () => db.all('SELECT * FROM users ORDER BY created').map(rowToUser),

    insert: u => db.run(
      'INSERT INTO users (id, name, password_hash, admin, disabled, session_ver, created, invited_by, last_reminder)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [u.id, u.name, u.passwordHash ?? null, u.admin ? 1 : 0, u.disabled ? 1 : 0,
        u.sv ?? 0, u.created ?? null, u.invitedBy ?? null, u.lastReminder ?? null]),

    // Writes the whole row. The API layer mutates a user object it already
    // holds and saves it, so replacing the row keeps that shape — and a
    // whole-row write is one statement either way.
    update: u => db.run(
      'UPDATE users SET name = ?, password_hash = ?, admin = ?, disabled = ?,' +
      ' session_ver = ?, invited_by = ?, last_reminder = ? WHERE id = ?',
      [u.name, u.passwordHash ?? null, u.admin ? 1 : 0, u.disabled ? 1 : 0,
        u.sv ?? 0, u.invitedBy ?? null, u.lastReminder ?? null, u.id])
  };

  /* ---------- passkey credentials ---------- */

  const rowToCred = r => r ? {
    id: r.id,
    userId: r.user_id,
    publicKey: r.public_key,
    counter: r.counter ?? 0,
    transports: r.transports ? JSON.parse(r.transports) : []
  } : null;

  const creds = {
    byId: id => rowToCred(db.get('SELECT * FROM creds WHERE id = ?', [id])),
    insert: c => db.run(
      'INSERT INTO creds (id, user_id, public_key, counter, transports) VALUES (?, ?, ?, ?, ?)',
      [c.id, c.userId, c.publicKey, c.counter ?? 0, JSON.stringify(c.transports ?? [])]),
    update: c => db.run('UPDATE creds SET counter = ? WHERE id = ?', [c.counter ?? 0, c.id])
  };

  /* ---------- push subscriptions ---------- */

  const rowToSub = r => r ? {
    endpoint: r.endpoint,
    userId: r.user_id,
    keys: JSON.parse(r.keys),
    created: r.created ?? undefined
  } : null;

  const subs = {
    byUser: userId => db.all('SELECT * FROM subs WHERE user_id = ?', [userId]).map(rowToSub),
    hasForUser: userId => !!db.get('SELECT 1 AS x FROM subs WHERE user_id = ?', [userId]),
    // A subscription is identified by its endpoint: the same browser endpoint
    // re-subscribing replaces the old row instead of duplicating it.
    deleteByEndpoint: endpoint => db.run('DELETE FROM subs WHERE endpoint = ?', [endpoint]),
    deleteByUserEndpoint: (userId, endpoint) =>
      db.run('DELETE FROM subs WHERE user_id = ? AND endpoint = ?', [userId, endpoint]),
    insert: s => db.run(
      'INSERT INTO subs (endpoint, user_id, keys, created) VALUES (?, ?, ?, ?)',
      [s.endpoint, s.userId, JSON.stringify(s.keys), s.created ?? null])
  };

  /* ---------- invite codes ---------- */

  const rowToInvite = r => r ? {
    code: r.code,
    note: r.note ?? undefined,
    createdBy: r.created_by ?? undefined,
    created: r.created ?? undefined,
    usedBy: r.used_by ?? undefined,
    usedAt: r.used_at ?? undefined,
    revoked: !!r.revoked
  } : null;

  const invites = {
    byCode: code => rowToInvite(db.get('SELECT * FROM invites WHERE code = ?', [code])),

    // An invite is usable when it exists, has not been used and has not been
    // revoked. The empty-string check mirrors the old `!i.usedBy` test.
    validByCode: code => rowToInvite(db.get(
      'SELECT * FROM invites WHERE code = ? AND (used_by IS NULL OR used_by = \'\') AND revoked = 0',
      [code])),

    existsByCode: code => !!db.get('SELECT 1 AS x FROM invites WHERE code = ?', [code]),

    list: () => db.all('SELECT * FROM invites ORDER BY created DESC').map(rowToInvite),

    insert: i => db.run(
      'INSERT INTO invites (code, note, created_by, created, used_by, used_at, revoked)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      [i.code, i.note ?? null, i.createdBy ?? null, i.created ?? null,
        i.usedBy ?? null, i.usedAt ?? null, i.revoked ? 1 : 0]),

    update: i => db.run(
      'UPDATE invites SET note = ?, used_by = ?, used_at = ?, revoked = ? WHERE code = ?',
      [i.note ?? null, i.usedBy ?? null, i.usedAt ?? null, i.revoked ? 1 : 0, i.code]),

    deleteByCode: code => db.run('DELETE FROM invites WHERE code = ?', [code])
  };

  /* ---------- per-user state ---------- */

  const state = {
    get: uid => {
      const row = db.get('SELECT json FROM state WHERE uid = ?', [uid]);
      if (!row) return null;
      try { return JSON.parse(row.json); } catch { return null; }
    },
    set: (uid, obj) => db.run(
      'INSERT INTO state (uid, json) VALUES (?, ?)' +
      ' ON CONFLICT(uid) DO UPDATE SET json = excluded.json',
      [uid, JSON.stringify(obj)])
  };

  return { users, creds, subs, invites, state };
}
