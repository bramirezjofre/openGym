/* Test helpers shared by the API test files. */

/* Puts the store back to a known empty state, and isolates this test file
 * from the others.
 *
 * With SQLite that is automatic — each test file gets its own temp data
 * directory. With Postgres the database is shared by everything pointed at it,
 * and `node --test` runs the test FILES in parallel, so one file truncating
 * the tables would pull the ground from under another one mid-test.
 *
 * Postgres schemas are the isolation mechanism: each test file gets its own
 * namespace inside the same database, and search_path points the connection
 * at it. The tables are then invisible to the other files.
 */
import { randomBytes } from 'node:crypto';

const PG_URL_RE = /^postgres(ql)?:\/\//i;

export function isPostgres() {
  return PG_URL_RE.test(process.env.DATABASE_URL || '');
}

/* Builds a connection string that points at a fresh schema, and creates it.
 * The schema name is derived from the caller's file so two files never
 * collide; the random suffix keeps two runs of the same file apart.
 */
export async function pgSchemaUrl(prefix) {
  const base = process.env.DATABASE_URL;
  const name = 't_' + prefix.replace(/[^a-z0-9_]/gi, '_') + '_' + randomBytes(4).toString('hex');

  const { openDb } = await import('../db.js');
  const admin = openDb({ file: null, url: base });
  await admin.exec('CREATE SCHEMA IF NOT EXISTS ' + name);
  await admin.close();

  // `?schema=name` — the driver moves it into the Pool's `options`, because
  // libpq's options parameter is not parsed out of a URI by the pg driver.
  const sep = base.includes('?') ? '&' : '?';
  return base + sep + 'schema=' + name;
}

/* Empties the tables of the current schema. */
export async function resetStore() {
  if (!isPostgres()) return;
  const { openDb } = await import('../db.js');
  const { schemaFor } = await import('../schema.js');
  const db = openDb({ file: null, url: process.env.DATABASE_URL });
  await db.exec(schemaFor(db.driver));
  await db.exec('TRUNCATE users, creds, subs, invites, state');
  await db.close();
}
