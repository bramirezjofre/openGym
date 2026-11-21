/* Repository tests against SQLite — the engine the deployment uses.
 *
 * The suite itself lives in repo-suite.js and is shared with the Postgres
 * run: the repository is the layer that has to be engine-agnostic, so the
 * same assertions against both engines are the proof.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../db.js';
import { createRepo } from '../repo.js';
import { schemaFor } from '../schema.js';
import { repoSuite } from './repo-suite.js';

repoSuite('sqlite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-repo-'));
  // url: '' forces SQLite even when DATABASE_URL is set — this file must
  // always test SQLite.
  const db = openDb({ file: path.join(dir, 'test.db'), url: '' });
  db.exec(schemaFor(db.driver));
  return { db, repo: createRepo(db), dir };
});
