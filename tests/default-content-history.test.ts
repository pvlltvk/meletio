import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {ContentRepository} from '../server/content';
import {ContentMutations} from '../server/content-mutations';
import {openDatabase} from '../server/database';
import {Training} from '../server/training';
import {ApiError, type Attempt, type Content} from '../server/types';

const demo: Content = {uiLanguage: 'en', decks: ['greek', 'arabic'].map(id => ({id, title: id,
  termLang: 'en', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr',
  words: Array.from({length: 6}, (_, index) => ({id: String(index), term: `${id} ${index}`, meaning: `meaning ${index}`, image: null, audio: null}))}))};

test('default overrides isolate repeated word IDs across sets and new practice while keeping historical retry text', () => {
  const db = openDatabase(':memory:');
  const bundled = structuredClone(demo);
  try {
    for (const owner of ['first', 'second']) db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(owner, `${owner}@example.test`, 'fixture', 100);
    const content = new ContentRepository(db, demo);
    const changes = new ContentMutations(db, content, () => 100);
    const training = new Training(db, content, () => 100);
    const run = (action: string, id: string | undefined, body: Record<string, unknown>) => training.mutate('first', action, id, {...body, requestId: randomUUID()}) as {attempt: Attempt};
    let attempt = run('start', undefined, {deckId: 'greek'}).attempt;
    const originalId = attempt.id;
    const originalSnapshot = db.prepare('SELECT content FROM training_snapshots WHERE owner_id = ?').get('first')!.content;
    const removed = attempt.questions[0].word;
    const edited = attempt.questions[1].word;
    while (attempt.status === 'active') {
      const question = attempt.questions[attempt.position];
      const wrong = [removed.id, edited.id].includes(question.word.id);
      const optionId = wrong ? question.options.find(word => word.id !== question.word.id)!.id : question.word.id;
      attempt = run('answer', attempt.id, {position: attempt.position, revision: attempt.revision, optionId}).attempt;
      attempt = run('advance', attempt.id, {position: attempt.position, revision: attempt.revision}).attempt;
    }
    changes.mutate('first', 'greek', edited.id, 'edit', {term: 'new Greek', meaning: 'new meaning', revision: 1, requestId: randomUUID()});
    changes.mutate('first', 'greek', removed.id, 'delete', {revision: 2, requestId: randomUUID()});
    assert.equal(content.deck('first', 'arabic').words.find(word => word.id === edited.id)!.term, `arabic ${edited.id}`);
    assert.equal(content.deck('second', 'greek').words.find(word => word.id === edited.id)!.term, edited.term);
    assert.deepEqual(demo, bundled);
    const retry = run('retry', originalId, {}).attempt;
    assert.deepEqual(retry.questions.map(question => question.word.id), [edited.id]);
    assert.equal(retry.questions[0].word.term, edited.term);
    assert(!retry.questions.flatMap(question => question.options).some(word => word.id === removed.id));
    assert.equal(db.prepare('SELECT content FROM training_snapshots ORDER BY rowid LIMIT 1').get()!.content, originalSnapshot);
    const fresh = run('start', undefined, {deckId: 'greek'}).attempt;
    assert.equal(fresh.questions.find(question => question.word.id === edited.id)!.word.term, 'new Greek');
    assert(!fresh.questions.some(question => question.word.id === removed.id));
    changes.mutate('first', 'arabic', edited.id, 'edit', {term: 'new Arabic', meaning: 'Arabic meaning', revision: 1, requestId: randomUUID()});
    assert.equal(content.deck('first', 'greek').words.find(word => word.id === edited.id)!.term, 'new Greek');
    assert.equal(content.deck('first', 'arabic').words.find(word => word.id === edited.id)!.term, 'new Arabic');
    for (const word of content.deck('first', 'greek').words.slice(0, 2)) {
      const revision = content.metadata('first', 'greek').revision;
      changes.mutate('first', 'greek', word.id, 'delete', {revision, requestId: randomUUID()});
    }
    assert.throws(() => run('start', undefined, {deckId: 'greek'}), error => error instanceof ApiError && error.status === 400);
  } finally { db.close(); }
});

test('schema three migration preserves existing rows and failure rolls back only new default tables', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-default-migration-'));
  try {
    for (const conflict of [false, true]) {
      const path = join(directory, conflict ? 'conflict.sqlite' : 'app.sqlite');
      const before = openDatabase(path);
      before.prepare('INSERT INTO users VALUES (?,?,?,?)').run('owner', 'owner@example.test', 'fixture-hash', 100);
      before.prepare('INSERT INTO auth_sessions VALUES (?,?,?,?)').run('fixture-token-hash', 'owner', 9999999999999, 100);
      before.prepare('INSERT INTO imported_decks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('owned', 'owner', 'Imported', 'el', 'en', 'ltr', 'ltr', 2, '{}', 'hash', 100, 100);
      before.prepare('INSERT INTO deck_overrides VALUES (?,?,?)').run('owned', 'Local title', null);
      before.prepare('INSERT INTO content_mutations VALUES (?,?,?,?,?)').run('owner', 'receipt', 'fingerprint', '{"revision":2}', 100);
      before.exec('DROP TABLE default_word_overrides; DROP TABLE default_deck_overrides; PRAGMA user_version=3;');
      const names = before.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => String(row.name));
      const rows = names.map(name => before.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all());
      if (conflict) before.exec("CREATE TABLE default_word_overrides(marker TEXT); INSERT INTO default_word_overrides VALUES ('preserved');");
      before.close();
      if (conflict) assert.throws(() => openDatabase(path));
      const after = conflict ? new DatabaseSync(path) : openDatabase(path);
      try {
        assert.equal(after.prepare('PRAGMA user_version').get()!.user_version, conflict ? 3 : 4);
        names.forEach((name, index) => assert.deepEqual(after.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(), rows[index]));
        if (conflict) {
          assert.equal(after.prepare('SELECT marker FROM default_word_overrides').get()!.marker, 'preserved');
          assert.equal(after.prepare("SELECT count(*) n FROM sqlite_master WHERE name='default_deck_overrides'").get()!.n, 0);
        } else for (const name of ['default_deck_overrides', 'default_word_overrides']) assert.equal(after.prepare(`SELECT count(*) n FROM ${name}`).get()!.n, 0);
        assert.equal(after.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
      } finally { after.close(); }
    }
  } finally { await rm(directory, {recursive: true, force: true}); }
});
