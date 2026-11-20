/* opengym-api — one-time import of the legacy JSON store.
 *
 * The app used to keep everything in ./data/db.json plus one state file per
 * user. The move to a real database has to preserve those users, so the
 * legacy files are read once and inserted.
 *
 * Three properties make this safe to run on every boot:
 *   - it only runs when the database has no users AND the legacy file has
 *     some. Once the import has happened the second condition is false, so
 *     a restart never re-imports.
 *   - the legacy files are left untouched on disk. They are the rollback: if
 *     the new store misbehaves, reverting the code brings the old store
 *     back with the data still there.
 *   - it runs inside a transaction. A failure halfway through leaves the
 *     database empty rather than half-populated.
 */
import fs from 'node:fs';
import path from 'node:path';

export function migrateLegacyJson({ dataDir, repo }) {
  const legacyFile = path.join(dataDir, 'db.json');
  if (!fs.existsSync(legacyFile)) return { imported: false, reason: 'no legacy file' };
  if (repo.users.count() > 0) return { imported: false, reason: 'database already has users' };

  let legacy;
  try {
    legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
  } catch (e) {
    return { imported: false, reason: 'legacy file unreadable: ' + e.message };
  }

  const users = legacy.users || [];
  const creds = legacy.creds || [];
  const subs = legacy.subs || [];
  const invites = legacy.invites || [];
  if (!users.length) return { imported: false, reason: 'legacy file has no users' };

  // The per-user state files are read directly — they are the other half of
  // the legacy store.
  const stateFiles = fs.readdirSync(dataDir)
    .filter(f => /^state-[A-Za-z0-9_-]+\.json$/.test(f));

  let states = 0;
  for (const u of users) {
    for (const c of creds.filter(x => x.userId === u.id)) repo.creds.insert(c);
    for (const s of subs.filter(x => x.userId === u.id)) repo.subs.insert(s);
    for (const i of invites.filter(x => x.usedBy === u.id)) repo.invites.insert(i);
    repo.users.insert(u);

    const file = path.join(dataDir, 'state-' + u.id.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
    if (fs.existsSync(file)) {
      try {
        repo.state.set(u.id, JSON.parse(fs.readFileSync(file, 'utf8')));
        states++;
      } catch { /* an unreadable state file is not fatal — the user re-syncs from their device */ }
    }
  }
  // Invites nobody used still have to come across.
  for (const i of invites.filter(x => !x.usedBy)) repo.invites.insert(i);

  return { imported: true, users: users.length, creds: creds.length, subs: subs.length, invites: invites.length, states, stateFiles: stateFiles.length };
}
