/* opengym-api — Postgres driver.
 *
 * NOT USED BY THE DEFAULT DEPLOYMENT. openGym runs on SQLite (api/db.js);
 * this file exists so that the "portable to any relational engine" claim is
 * a tested fact rather than an architectural promise: the same repository and
 * the same SQL run green against both (see test/repo-postgres.test.js).
 *
 * The repository (api/repo.js) speaks SQL with `?` placeholders. Postgres
 * wants `$1..$n`, so the translation happens here — the only place in the
 * codebase that knows a placeholder means something different. Everything
 * above this file is identical on both engines.
 *
 * `pg` is a devDependency: the production image installs with --omit=dev and
 * never loads this file, so the running deployment carries no extra package.
 */
import { Pool } from 'pg';

/* `?` -> `$1, $2, ...`. The SQL in the repository never contains a literal
 * question mark outside a placeholder, and no `?` appears inside a string
 * literal — so a straight scan is safe. A doubled quote inside a string is
 * an escaped quote and does not end it.
 */
function toNumbered(sql) {
  let out = '';
  let n = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      if (inString && sql[i + 1] === "'") { out += "''"; i++; continue; }
      inString = !inString;
      out += c;
      continue;
    }
    if (c === '?' && !inString) { out += '$' + (++n); continue; }
    out += c;
  }
  return out;
}

/* Postgres binds null, string, number, boolean, Date, Buffer and arrays of
 * those. The repository binds strings, numbers and nulls, so the only
 * normalisation needed is undefined -> null. Booleans become 0/1 because the
 * flag columns are INTEGER on every engine (see schema.js).
 */
function bind(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError('cannot bind a value of type ' + typeof value + ' — serialise it first');
}

/* A Postgres schema is the isolation mechanism the test suite uses: two test
 * files can run in parallel against the same database without seeing each
 * other's tables. The schema travels in the connection URL as `?schema=name`.
 *
 * It has to be moved into the Pool's `options` because libpq's `options`
 * parameter is not parsed out of a connection URI by the pg driver — only
 * from the config object. The driver is where that translation belongs.
 */
function splitSchema(url) {
  const i = url.indexOf('?');
  if (i < 0) return { url, schema: null };
  const params = new URLSearchParams(url.slice(i + 1));
  const schema = params.get('schema');
  params.delete('schema');
  const rest = params.toString();
  return { url: url.slice(0, i) + (rest ? '?' + rest : ''), schema };
}

export function openPostgres(url) {
  const { url: cleanUrl, schema } = splitSchema(url);
  const pool = new Pool({
    connectionString: cleanUrl,
    ...(schema ? { options: '-c search_path=' + schema } : {})
  });

  /* While a transaction is open, its statements must run on the SAME client
   * that issued BEGIN. Otherwise they go through the pool on another
   * connection and land outside the transaction — the COMMIT would then
   * commit an empty transaction and the ROLLBACK would undo nothing. This
   * variable is the whole reason the driver is not a thin wrapper.
   */
  let txClient = null;

  const query = async (sql, params) => {
    const text = toNumbered(sql);
    const values = params.map(bind);
    const conn = txClient || pool;
    return conn.query(text, values);
  };

  return {
    driver: 'postgres',

    async all(sql, params = []) {
      return (await query(sql, params)).rows;
    },

    async get(sql, params = []) {
      return (await query(sql, params)).rows[0];
    },

    async run(sql, params = []) {
      const r = await query(sql, params);
      return { changes: r.rowCount };
    },

    async exec(sql) {
      await (txClient || pool).query(sql);
    },

    /* The repository's tx body is async (it awaits the repository methods),
     * so the transaction has to be async too. The client is checked out for
     * the whole duration and every statement in the body goes through it.
     */
    async tx(fn) {
      if (txClient) throw new Error('nested transactions are not supported');
      const conn = await pool.connect();
      try {
        await conn.query('BEGIN');
        txClient = conn;
        const result = await fn(conn);
        await conn.query('COMMIT');
        return result;
      } catch (e) {
        try { await conn.query('ROLLBACK'); } catch { /* the transaction was already gone */ }
        throw e;
      } finally {
        txClient = null;
        conn.release();
      }
    },

    async close() {
      await pool.end();
    }
  };
}
