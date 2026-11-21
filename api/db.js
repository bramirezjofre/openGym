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
import { createRequire } from 'node:module';

// `pg` is CommonJS and is only needed by the Postgres driver, which the
// default deployment never loads. createRequire lets it be required lazily
// from this ESM module instead of being a hard import at the top.
const require = createRequire(import.meta.url);

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

    /* The transaction body is async (the repository methods are), so this is
     * too. That does not open an interleaving window in SQLite: node:sqlite
     * is synchronous, so every statement in the body has already executed by
     * the time the body awaits — the only thing pending is a microtask. Node
     * drains the microtask queue completely before it runs the next I/O
     * callback, so no other request handler can slip a statement into this
     * transaction. The Postgres driver does not have that luxury and has to
     * hold a dedicated client instead (see db-postgres.js).
     */
    async tx(fn) {
      db.exec('BEGIN');
      try {
        const result = await fn();
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

/* The one place that decides the engine.
 *
 * DATABASE_URL selects it:
 *   unset or file:...   -> SQLite, the default and what the deployment uses
 *   postgres://...      -> Postgres
 *
 * The Postgres driver is loaded on demand, so the default deployment never
 * loads `pg` and never needs it installed. The repository and every handler
 * above this file are identical on both engines — that is the claim the
 * dual-engine test suite (test/repo.test.js and test/repo-postgres.test.js)
 * checks.
 */
export function openDb(opts = {}) {
  // `opts.url` given explicitly wins, including when it is empty: passing
  // url: '' forces SQLite even when DATABASE_URL is set in the environment.
  // That is what lets the test suite run the SQLite repository against a
  // machine that also has a Postgres to test against.
  const url = opts.url === undefined ? (process.env.DATABASE_URL || '') : (opts.url || '');
  if (/^postgres(ql)?:\/\//i.test(url)) {
    // Loaded here, not at the top, so `pg` is only required when it is used.
    const { openPostgres } = require('./db-postgres.js');
    return openPostgres(url);
  }
  if (url && !url.startsWith('file:')) {
    throw new Error('unsupported DATABASE_URL scheme: ' + url.split(':')[0]);
  }
  return openSqlite(opts.file || '/data/gym.db');
}
