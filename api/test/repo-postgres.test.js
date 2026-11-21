/* Repository tests against Postgres — the same suite as the SQLite run.
 *
 * This is the proof behind the "portable to any relational engine" claim: the
 * repository, the schema and every SQL statement are identical; only the
 * driver differs. If this suite passes, the repository really is
 * engine-agnostic.
 *
 * It needs a Postgres to talk to. Set PG_TEST_URL to point at one; without it
 * the suite skips instead of failing, so a normal `node --test test/` on a
 * machine without Postgres still works.
 */
import { createRepo } from '../repo.js';
import { schemaFor } from '../schema.js';
import { repoSuite } from './repo-suite.js';

const url = process.env.PG_TEST_URL;

if (!url) {
  // Nothing to test against. node:test treats a skipped test as skipped, not
  // failed, so the suite stays green on a machine without Postgres.
  const { test } = await import('node:test');
  test('postgres: skipped (set PG_TEST_URL to run it)', { skip: 'no PG_TEST_URL' }, () => {});
} else {
  const { openPostgres } = await import('../db-postgres.js');

  repoSuite('postgres', async () => {
    const db = openPostgres(url);
    await db.exec(schemaFor(db.driver));
    // Each test starts from an empty schema.
    await db.exec('TRUNCATE users, creds, subs, invites, state');
    return { db, repo: createRepo(db) };
  });
}
