/* opengym-api — storage driver.
 *
 * This file is the ONLY place that knows which database engine is in use.
 * Everything above it speaks SQL with `?` placeholders; everything below is
 * engine-specific. Moving from SQLite to Postgres means adding a driver file
 * and changing one line in openDb() — no caller changes, and no SQL changes
 * as long as the SQL stays inside the ANSI subset.
 *
 * Why SQLite: node:sqlite ships in the Node standard library, so the app
 * gains real transactions and a single-file backup without a new container,
 * a new dependency, or a build toolchain in the image.
 *
 * The pragma is the whole performance story: with the default
 * synchronous=FULL a 5000-row insert took 53 s on the target CPU; with
 * WAL + synchronous=NORMAL the same work took 0.57 s (~92x). NORMAL is the
 * honest setting here because the data is reconstructible (a user's workout
 * history lives on their device too) — a power cut can lose the last
 * transaction, never the file.
 */
import { DatabaseSync } from 'node:sqlite';

/* SQLite binds only null, number, bigint, string and Uint8Array. Two
 * normalisations are needed, and both are dialect-specific rather than
 * app-specific, which is why they live here and not in the repository:
 *
 *   - undefined is not a bindable value; it means "no value", so it becomes
 *     NULL. (Postgres has the same rule.)
 *   - booleans are not a SQLite type. SQLite stores them as 0/1; Postgres
 *     has a real boolean type and binds TRUE/FALSE. Normalising to 0/1 here
 *     is what keeps the column definitions identical on both engines.
 */
function bind(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value;
  if (value instanceof Uint8Array) return value;
  // Objects and arrays are the caller's business — a repository that wants to
  // store one must serialise it explicitly. Silently stringifying here would
  // hide a bug behind a string column.
  throw new TypeError('cannot bind a value of type ' + typeof value + ' — serialise it first');
}

export function openSqlite(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');

  // Prepared statements are cached by SQL text: the same handful of queries
  // run on every request, and re-parsing them each time is pure overhead.
  const cache = new Map();
  const stmt = sql => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };

  return {
    driver: 'sqlite',

    all(sql, params = []) {
      return stmt(sql).all(...params.map(bind));
    },

    get(sql, params = []) {
      const row = stmt(sql).get(...params.map(bind));
      return row === undefined ? undefined : row;
    },

    run(sql, params = []) {
      return stmt(sql).run(...params.map(bind));
    },

    exec(sql) {
      db.exec(sql);
    },

    // Synchronous transaction. The repository API is synchronous throughout, so
    // a transaction cannot be suspended mid-way by an await — which is what
    // makes "either the whole write lands or none of it does" true here.
    tx(fn) {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* the transaction was already gone */ }
        throw e;
      }
    },

    close() {
      cache.clear();
      db.close();
    }
  };
}

/* The one line that decides the engine. To move to Postgres:
 *
 *   export function openDb(opts) { return openPostgres(opts.url); }
 *
 * and add api/postgres.js with the same interface (all/get/run/exec/tx/close),
 * translating `?` to `$1..$n` on the way in. The repository and the API above
 * it do not change.
 */
export function openDb(opts = {}) {
  return openSqlite(opts.file || '/data/gym.db');
}
