import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {ContentRepository} from '../server/content';
import {openDatabase} from '../server/database';
import {ApiError, type Content} from '../server/types';

const demo: Content = {uiLanguage: 'en', decks: [{id: 'demo', title: 'Demo', termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr',
  words: [{id: 'demo-word', term: 'demo', meaning: 'example', image: null, audio: null}]}]};
const users = (db: DatabaseSync) => db.exec("INSERT INTO users VALUES ('first','first@example.com','hash',1),('second','second@example.com','hash',1)");
function seedDeck(db: DatabaseSync, id: string, owner = 'first', title = id) {
  db.prepare('INSERT INTO imported_decks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id, owner, title, 'el', 'en', 'ltr', 'ltr', 1, '{}', 'package-hash', 1, 1);
  db.prepare('INSERT INTO imported_words VALUES (?,?,?,?,?,?,?,?,?,?)').run(`word-${id}`, id, `guid-${id}`, 100, 'content-hash', `term-${id}`, `meaning-${id}`, null, null, 0);
}
function forbidden(run: () => unknown) {
  assert.throws(run, (error: unknown) => error instanceof ApiError && error.status === 404);
}

async function temporary(run: (path: string) => Promise<void> | void) {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-content-'));
  try { await run(join(directory, 'app.sqlite')); } finally { await rm(directory, {recursive: true, force: true}); }
}

function v1(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX sessions_user ON auth_sessions(user_id);
    CREATE TABLE training_attempts (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),deck_id TEXT NOT NULL,status TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,completed_at INTEGER);
    CREATE UNIQUE INDEX active_attempt ON training_attempts(user_id,deck_id) WHERE status='active';
    CREATE INDEX attempts_user_deck ON training_attempts(user_id,deck_id,created_at);
    CREATE TABLE mutation_receipts (user_id TEXT NOT NULL REFERENCES users(id),request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,response TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,request_id));
    PRAGMA user_version=1;`);
  users(db);
  db.prepare('INSERT INTO auth_sessions VALUES (?,?,?,?)').run('opaque-token-hash', 'first', 9999999999999, 100);
  for (const status of ['active', 'completed']) {
    const state = {id: `old-${status}`, deckId: 'demo', status, revision: 1,
      deck: demo.decks[0], questions: [{word: demo.decks[0].words[0], options: demo.decks[0].words}],
      answers: [{word: demo.decks[0].words[0], optionId: 'demo-word', correct: true}],
      position: status === 'active' ? 0 : 1, selected: status === 'active' ? 'demo-word' : null, createdAt: 100, completedAt: status === 'completed' ? 200 : null};
    db.prepare('INSERT INTO training_attempts VALUES (?,?,?,?,?,?,?)').run(state.id, 'first', 'demo', status, JSON.stringify(state), 100, state.completedAt);
    db.prepare('INSERT INTO mutation_receipts VALUES (?,?,?,?,?)').run('first', `receipt-${status}`, 'fingerprint', JSON.stringify({attempt: state}), 100);
  }
  return db;
}

test('schema v1 migration preserves accounts sessions attempt snapshots and receipts byte for byte', async () => temporary(path => {
  const original = v1(path);
  const tables = ['users', 'auth_sessions', 'training_attempts', 'mutation_receipts'];
  const before = tables.map(table => original.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  original.close();
  const migrated = openDatabase(path);
  try {
    assert.equal(migrated.prepare('PRAGMA user_version').get()!.user_version, 4);
    tables.forEach((table, index) => assert.deepEqual(migrated.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), before[index]));
    assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM imported_decks').get()!.count, 0);
    assert.deepEqual(new ContentRepository(migrated, demo).deck('first', 'demo'), {...demo.decks[0], wordCount: demo.decks[0].words.length, revision: 1, imported: false, editable: true});
  } finally { migrated.close(); }
}));

test('failed additive migration rolls back its schema and retains v1 rows and version', async () => temporary(path => {
  const original = v1(path);
  original.exec('CREATE TABLE imported_decks(marker TEXT); INSERT INTO imported_decks VALUES (\'existing-marker\')');
  original.close();
  assert.throws(() => openDatabase(path));
  const db = new DatabaseSync(path);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 1);
    assert.equal(db.prepare('SELECT marker FROM imported_decks').get()!.marker, 'existing-marker');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get()!.count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='imported_media'").get()!.count, 0);
  } finally { db.close(); }
}));

test('catalog pagination exposes only owner metadata and covers more than fifty decks without duplicates', () => {
  const db = openDatabase(':memory:');
  try {
    users(db);
    for (let index = 0; index < 125; index++) seedDeck(db, `owned-${String(index).padStart(3, '0')}`);
    seedDeck(db, 'secret', 'second', 'Other learner private title');
    const repo = new ContentRepository(db, demo);
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = repo.list('first', cursor);
      assert(page.decks.length <= 50);
      assert(Buffer.byteLength(JSON.stringify(page)) <= 128 * 1024);
      for (const deck of page.decks) {
        assert(!('words' in deck));
        assert.notEqual(deck.id, 'secret');
        ids.push(deck.id);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(ids.length, 126);
    assert.equal(new Set(ids).size, 126);
    forbidden(() => repo.deck('first', 'secret'));
    forbidden(() => repo.metadata('first', 'secret'));
    assert.equal(repo.deck('second', 'secret').title, 'Other learner private title');
  } finally { db.close(); }
});

test('immutable media remains owner-only when a current word changes its media reference', () => {
  const db = openDatabase(':memory:');
  try {
    users(db); seedDeck(db, 'owned');
    for (const id of ['old-media', 'new-media']) {
      db.prepare('INSERT INTO imported_media VALUES (?,?,?,?,?,?)').run(id, 'first', id, 'image/png', 3, Buffer.from(id === 'old-media' ? 'old' : 'new'));
    }
    db.prepare('UPDATE imported_words SET image_media_id=? WHERE deck_id=?').run('old-media', 'owned');
    const repo = new ContentRepository(db, demo);
    const old = repo.deck('first', 'owned');
    db.prepare('UPDATE imported_words SET image_media_id=? WHERE deck_id=?').run('new-media', 'owned');
    db.prepare('UPDATE imported_decks SET revision=2 WHERE id=?').run('owned');
    assert.equal(old.words[0].image, '/api/media/old-media');
    assert.equal(repo.deck('first', 'owned').words[0].image, '/api/media/new-media');
    assert.equal(Buffer.from(repo.media('first', 'old-media')!.bytes).toString(), 'old');
    assert.equal(repo.media('second', 'old-media'), undefined);
  } finally { db.close(); }
});

test('selected-deck byte budget is enforced separately from bounded catalog metadata', () => {
  const db = openDatabase(':memory:');
  try {
    users(db); seedDeck(db, 'oversized');
    db.prepare('UPDATE imported_words SET term=? WHERE deck_id=?').run('x'.repeat(1024 * 1024), 'oversized');
    const repo = new ContentRepository(db, demo);
    assert.equal(repo.list('first').decks.length, 2);
    assert.throws(() => repo.deck('first', 'oversized'), (error: unknown) => error instanceof ApiError && error.status === 422);
  } finally { db.close(); }
});
