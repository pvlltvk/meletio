import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {openDatabase} from '../server/database';

test('schema five adds empty review storage and preserves every schema four table row', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-lesson-migration-'));
  try {
    const path = join(directory, 'app.sqlite');
    const before = openDatabase(path);
    before.prepare('INSERT INTO users VALUES (?,?,?,?)').run('owner', 'owner@example.com', 'hash', 10);
    before.prepare('INSERT INTO auth_sessions VALUES (?,?,?,?)').run('session-hash', 'owner', 1000, 10);
    before.prepare('INSERT INTO training_attempts VALUES (?,?,?,?,?,?,?)').run('attempt', 'owner', 'demo', 'completed', '{"legacy":true}', 10, 20);
    before.prepare('INSERT INTO mutation_receipts VALUES (?,?,?,?,?)').run('owner', 'request', 'fingerprint', '{"attempt":{}}', 20);
    before.prepare('INSERT INTO training_snapshots VALUES (?,?,?)').run('attempt', 'owner', '{"snapshot":true}');
    before.prepare('INSERT INTO training_answers VALUES (?,?,?,?,?)').run('attempt', 0, 'word', 'option', 1);
    before.exec('DROP TABLE IF EXISTS word_reviews; PRAGMA user_version=4;');
    const names = (before.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name: string}[]).map(row => row.name);
    const rows = names.map(name => before.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all());
    before.close();

    const after = openDatabase(path);
    try {
      assert.equal((after.prepare('PRAGMA user_version').get() as {user_version: number}).user_version, 5);
      names.forEach((name, index) => assert.deepEqual(after.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(), rows[index], name));
      assert.equal((after.prepare('SELECT count(*) AS n FROM word_reviews').get() as {n: number}).n, 0);
      assert.equal((after.prepare('PRAGMA integrity_check').get() as {integrity_check: string}).integrity_check, 'ok');
    } finally { after.close(); }
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('failed schema five migration rolls back and keeps schema four rows intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-lesson-rollback-'));
  try {
    const path = join(directory, 'app.sqlite');
    const before = openDatabase(path);
    before.prepare('INSERT INTO users VALUES (?,?,?,?)').run('owner', 'owner@example.com', 'hash', 10);
    before.prepare('INSERT INTO mutation_receipts VALUES (?,?,?,?,?)').run('owner', 'request', 'fingerprint', '{"kept":true}', 20);
    before.exec('DROP TABLE IF EXISTS word_reviews; PRAGMA user_version=4;');
    before.exec("CREATE TABLE word_reviews (marker TEXT); INSERT INTO word_reviews VALUES ('preexisting');");
    before.close();

    assert.throws(() => openDatabase(path));
    const after = new DatabaseSync(path);
    try {
      assert.equal((after.prepare('PRAGMA user_version').get() as {user_version: number}).user_version, 4);
      assert.equal((after.prepare('SELECT response FROM mutation_receipts').get() as {response: string}).response, '{"kept":true}');
      assert.equal((after.prepare('SELECT marker FROM word_reviews').get() as {marker: string}).marker, 'preexisting');
      assert.deepEqual((after.prepare('PRAGMA table_info(word_reviews)').all() as {name: string}[]).map(column => column.name), ['marker']);
    } finally { after.close(); }
  } finally { await rm(directory, {recursive: true, force: true}); }
});
