import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {createApplication} from '../server/app';
import {ContentRepository} from '../server/content';
import {openDatabase} from '../server/database';

const demo = {uiLanguage: 'en', decks: []};

function asVersionTwo(db: DatabaseSync) {
  db.exec('DROP TABLE default_word_overrides; DROP TABLE default_deck_overrides; DROP TABLE content_mutations; DROP TABLE word_overrides; DROP TABLE deck_overrides; DROP INDEX imported_decks_source; PRAGMA user_version=2;');
}

function seed(db: DatabaseSync, owner: string, count = 1) {
  db.prepare('INSERT INTO imported_decks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('owned', owner, 'A', 'el', 'en', 'ltr', 'ltr', 1, '{}', 'archive', 100, 100);
  const insert = db.prepare('INSERT INTO imported_words VALUES (?,?,?,?,?,?,?,?,?,?)');
  for (let i = 0; i < count; i++) insert.run(`word-${i}`, 'owned', `guid-${i}`, 100, `hash-${i}`, `term ${i}`, 'm', null, null, i);
}

test('schema two migration preserves every original table row and adds only empty management tables', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-content-migration-'));
  try {
    const path = join(directory, 'app.sqlite');
    const before = openDatabase(path);
    before.prepare('INSERT INTO users VALUES (?,?,?,?)').run('owner', 'owner@example.com', 'salted-private-hash', 100);
    seed(before, 'owner');
    before.prepare('INSERT INTO auth_sessions VALUES (?,?,?,?)').run('session-hash', 'owner', 9999999999999, 100);
    before.prepare('INSERT INTO training_snapshots VALUES (?,?,?)').run('snapshot', 'owner', '{"immutable":true}');
    before.prepare('INSERT INTO mutation_receipts VALUES (?,?,?,?,?)').run('owner', 'training-key', 'fingerprint', '{"attempt":{}}', 100);
    asVersionTwo(before);
    const names = before.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => String(row.name));
    const rows = names.map(name => before.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all());
    before.close();
    const after = openDatabase(path);
    try {
      assert.equal(after.prepare('PRAGMA user_version').get()!.user_version, 4);
      names.forEach((name, i) => assert.deepEqual(after.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(), rows[i]));
      for (const name of ['word_overrides', 'deck_overrides', 'content_mutations', 'default_word_overrides', 'default_deck_overrides']) assert.equal(after.prepare(`SELECT count(*) n FROM ${name}`).get()!.n, 0);
      assert.equal(after.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    } finally { after.close(); }
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('failed schema three migration rolls back new tables and retains schema two data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-content-rollback-'));
  try {
    const path = join(directory, 'app.sqlite');
    const before = openDatabase(path);
    before.prepare('INSERT INTO users VALUES (?,?,?,?)').run('owner', 'owner@example.com', 'salted-private-hash', 100);
    seed(before, 'owner');
    asVersionTwo(before);
    before.exec("CREATE TABLE word_overrides(marker TEXT); INSERT INTO word_overrides VALUES ('original');");
    before.close();
    assert.throws(() => openDatabase(path));
    const after = new DatabaseSync(path);
    try {
      assert.equal(after.prepare('PRAGMA user_version').get()!.user_version, 2);
      assert.equal(after.prepare('SELECT marker FROM word_overrides').get()!.marker, 'original');
      assert.equal(after.prepare('SELECT term FROM imported_words').get()!.term, 'term 0');
      assert.equal(after.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('deck_overrides','content_mutations')").get()!.n, 0);
    } finally { after.close(); }
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('edits and renames that exceed the effective deck budget roll back overrides revisions and receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-content-budget-'));
  const path = join(directory, 'app.sqlite');
  const origin = 'http://127.0.0.1:4173';
  const app = createApplication({databasePath: path, content: demo, origin, registration: 'open'});
  try {
    await new Promise<void>((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
    const address = app.server.address();
    assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const registered = await fetch(base + '/api/auth/register', {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body: JSON.stringify({email: 'owner@example.com', password: 'a private test password'})});
    assert.equal(registered.status, 201);
    const cookie = registered.headers.get('set-cookie')!.split(';')[0];
    const {user} = await registered.json() as {user: {id: string}};
    const db = new DatabaseSync(path);
    try {
      seed(db, user.id, 600);
      const content = new ContentRepository(db, demo);
      const initial = content.deck(user.id, 'owned');
      let remaining = 1024 * 1024 - Buffer.byteLength(JSON.stringify(initial)) - 32;
      const update = db.prepare('UPDATE imported_words SET meaning = ? WHERE id = ?');
      for (const word of initial.words) {
        const added = Math.min(1999, remaining);
        update.run('m' + 'x'.repeat(added), word.id);
        remaining -= added;
        if (!remaining) break;
      }
      assert.equal(remaining, 0);
      const before = JSON.stringify(content.deck(user.id, 'owned'));
      assert.equal(Buffer.byteLength(before), 1024 * 1024 - 32);
      for (const [endpoint, body] of [
        ['/api/decks/owned/words/word-0/edit', {term: 'z'.repeat(2000), meaning: content.deck(user.id, 'owned').words[0].meaning}],
        ['/api/decks/owned/rename', {title: 'N'.repeat(120)}]
      ] as const) {
        const response = await fetch(base + endpoint, {method: 'POST', headers: {Origin: origin, Cookie: cookie, 'Content-Type': 'application/json'}, body: JSON.stringify({...body, revision: 1, requestId: randomUUID()})});
        assert.equal(response.status, 422);
        assert.equal(JSON.stringify(content.deck(user.id, 'owned')), before);
        for (const name of ['word_overrides', 'deck_overrides', 'content_mutations']) assert.equal(db.prepare(`SELECT count(*) n FROM ${name}`).get()!.n, 0);
      }
    } finally { db.close(); }
  } finally { await app.close(); await rm(directory, {recursive: true, force: true}); }
});
