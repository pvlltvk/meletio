import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {openDatabase} from '../server/database';

function accessTokenTables(db: DatabaseSync): string[] {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name: string}[])
    .map(({name}) => name);
  return tables.filter(name => {
    const columns = (db.prepare(`PRAGMA table_info("${name}")`).all() as {name: string}[]).map(({name: column}) => column);
    return columns.includes('token_hash') && columns.includes('name') && columns.includes('expires_at') &&
      (columns.includes('owner_id') || columns.includes('user_id'));
  });
}

async function directory() { return mkdtemp(join(tmpdir(), 'meletio-authoring-migration-')); }

function prepareVersionFive(path: string): {tables: string[]; rows: unknown[][]; accessTokenTable?: string} {
  const db = openDatabase(path);
  db.prepare('INSERT INTO users VALUES (?,?,?,?)').run('owner', 'owner@example.com', 'hash', 10);
  db.prepare('INSERT INTO auth_sessions VALUES (?,?,?,?)').run('session-hash', 'owner', 9999999999999, 10);
  db.prepare('INSERT INTO training_attempts VALUES (?,?,?,?,?,?,?)').run('attempt', 'owner', 'demo', 'completed', '{"saved":true}', 10, 20);
  db.prepare('INSERT INTO mutation_receipts VALUES (?,?,?,?,?)').run('owner', 'request', 'fingerprint', '{"saved":true}', 20);
  db.prepare('INSERT INTO training_snapshots VALUES (?,?,?)').run('attempt', 'owner', '{"immutable":true}');
  db.prepare('INSERT INTO training_answers VALUES (?,?,?,?,?)').run('attempt', 0, 'word', 'option', 1);

  const newTokenTables = accessTokenTables(db);
  assert(newTokenTables.length <= 1, 'one access-token table is expected');
  for (const name of newTokenTables) db.exec(`DROP TABLE "${name}"`);
  db.exec('DROP INDEX imported_media_owner_size; PRAGMA user_version = 5');
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name: string}[])
    .map(({name}) => name);
  const rows = tables.map(name => db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all());
  db.close();
  return {tables, rows, accessTokenTable: newTokenTables[0]};
}

test('schema six adds empty personal-token storage and preserves every schema five row', async () => {
  const folder = await directory();
  try {
    const path = join(folder, 'app.sqlite');
    const before = prepareVersionFive(path);
    const after = openDatabase(path);
    try {
      assert.equal((after.prepare('PRAGMA user_version').get() as {user_version: number}).user_version, 7);
      before.tables.forEach((name, index) => assert.deepEqual(after.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(), before.rows[index], name));
      const newTables = (after.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name: string}[])
        .map(({name}) => name).filter(name => !before.tables.includes(name));
      assert.deepEqual(newTables, accessTokenTables(after));
      assert.equal(newTables.length, 1);
      assert.equal(after.prepare(`SELECT count(*) AS n FROM "${newTables[0]}"`).get()!.n, 0);
      assert.equal(after.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    } finally { after.close(); }
  } finally { await rm(folder, {recursive: true, force: true}); }
});

test('failed schema six migration rolls back and keeps schema five data intact', async () => {
  const folder = await directory();
  try {
    const path = join(folder, 'app.sqlite');
    const fresh = openDatabase(path);
    const tables = accessTokenTables(fresh);
    assert.equal(tables.length, 1);
    const tokenTable = tables[0];
    fresh.prepare('INSERT INTO users VALUES (?,?,?,?)').run('owner', 'owner@example.com', 'hash', 10);
    fresh.prepare('INSERT INTO mutation_receipts VALUES (?,?,?,?,?)').run('owner', 'request', 'fingerprint', '{"saved":true}', 20);
    fresh.exec(`DROP TABLE "${tokenTable}"; DROP INDEX imported_media_owner_size; PRAGMA user_version = 5; CREATE TABLE "${tokenTable}" (marker TEXT); INSERT INTO "${tokenTable}" VALUES ('preexisting');`);
    fresh.close();

    assert.throws(() => openDatabase(path));
    const after = new DatabaseSync(path);
    try {
      assert.equal((after.prepare('PRAGMA user_version').get() as {user_version: number}).user_version, 5);
      assert.equal((after.prepare('SELECT response FROM mutation_receipts').get() as {response: string}).response, '{"saved":true}');
      assert.equal((after.prepare(`SELECT marker FROM "${tokenTable}"`).get() as {marker: string}).marker, 'preexisting');
      assert.deepEqual((after.prepare(`PRAGMA table_info("${tokenTable}")`).all() as {name: string}[]).map(({name}) => name), ['marker']);
    } finally { after.close(); }
  } finally { await rm(folder, {recursive: true, force: true}); }
});

test('schema seven adds a covering media usage index and preserves every schema six media row', async () => {
  const folder = await directory();
  try {
    const path = join(folder, 'app.sqlite');
    const fresh = openDatabase(path);
    fresh.prepare('INSERT INTO users VALUES (?,?,?,?)').run('owner', 'owner@example.com', 'hash', 10);
    const insert = fresh.prepare('INSERT INTO imported_media VALUES (?,?,?,?,?,?)');
    insert.run('image', 'owner', 'a'.repeat(64), 'image/webp', 3, new Uint8Array([1, 2, 3]));
    insert.run('audio', 'owner', 'b'.repeat(64), 'audio/mpeg', 2, new Uint8Array([4, 5]));
    fresh.exec('DROP INDEX imported_media_owner_size; PRAGMA user_version = 6');
    const rows = fresh.prepare('SELECT * FROM imported_media ORDER BY rowid').all();
    fresh.close();

    const after = openDatabase(path);
    try {
      assert.equal((after.prepare('PRAGMA user_version').get() as {user_version: number}).user_version, 7);
      assert.deepEqual(after.prepare('SELECT * FROM imported_media ORDER BY rowid').all(), rows);
      assert((after.prepare("PRAGMA index_list('imported_media')").all() as {name: string}[]).some(({name}) => name === 'imported_media_owner_size'));
      const plan = (after.prepare('EXPLAIN QUERY PLAN SELECT count(*) AS files, COALESCE(sum(size),0) AS bytes FROM imported_media WHERE owner_id = ?').all('owner') as {detail: string}[])
        .map(({detail}) => detail).join('\n');
      assert.match(plan, /USING COVERING INDEX imported_media_owner_size/);
      assert.deepEqual({...after.prepare('SELECT count(*) AS files, COALESCE(sum(size),0) AS bytes FROM imported_media WHERE owner_id = ?').get('owner')}, {files: 2, bytes: 5});
      assert.equal(after.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    } finally { after.close(); }
  } finally { await rm(folder, {recursive: true, force: true}); }
});

test('schema eight is rejected without changing the database', async () => {
  const folder = await directory();
  try {
    const path = join(folder, 'app.sqlite');
    const fresh = openDatabase(path);
    fresh.prepare('INSERT INTO users VALUES (?,?,?,?)').run('owner', 'owner@example.com', 'hash', 10);
    fresh.exec('PRAGMA user_version = 8');
    fresh.close();

    assert.throws(() => openDatabase(path), /Unsupported database schema version/);
    const after = new DatabaseSync(path);
    try {
      assert.equal((after.prepare('PRAGMA user_version').get() as {user_version: number}).user_version, 8);
      assert.equal((after.prepare('SELECT email FROM users').get() as {email: string}).email, 'owner@example.com');
    } finally { after.close(); }
  } finally { await rm(folder, {recursive: true, force: true}); }
});
