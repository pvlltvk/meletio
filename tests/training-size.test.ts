import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {ContentRepository} from '../server/content';
import {openDatabase} from '../server/database';
import {Training} from '../server/training';
import {ApiError, type Content, type CompactAttempt, type Attempt, type TrainingSnapshot} from '../server/types';

function content(count = 10, padding = 0): Content {
  return {uiLanguage: 'en', decks: [{id: 'size-deck', title: 'Size test', termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr',
    words: Array.from({length: count}, (_, index) => ({id: `word-${index}`, term: `term ${index} ${'t'.repeat(padding)}`, meaning: `meaning ${index} ${'m'.repeat(padding)}`, image: null, audio: null}))}]};
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function seedUsers(db: ReturnType<typeof openDatabase>) {
  db.exec("INSERT INTO users VALUES ('first','first@example.com','hash',1),('second','second@example.com','hash',1)");
}
function compact(result: {attempt: Attempt | CompactAttempt}): CompactAttempt {
  assert('answerCount' in result.attempt);
  assert(bytes(result) <= 4096);
  return result.attempt;
}
function answer(training: Training, state: CompactAttempt, snapshot: TrainingSnapshot, right = true, requestId = randomUUID()) {
  const question = snapshot.questions[state.position];
  const optionId = right ? question.wordId : question.optionIds.find(id => id !== question.wordId)!;
  const body = {position: state.position, revision: state.revision, optionId, requestId};
  return {state: compact(training.mutate('first', 'answer', state.id, body, true)), body};
}
function advance(training: Training, state: CompactAttempt) {
  return compact(training.mutate('first', 'advance', state.id, {position: state.position, revision: state.revision, requestId: randomUUID()}, true));
}

test('compact and legacy projections share first-answer scoring and exact historical receipt replay after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-training-format-'));
  const path = join(directory, 'app.sqlite');
  let db = openDatabase(path);
  try {
    seedUsers(db);
    let training = new Training(db, content(), () => 100);
    const startBody = {deckId: 'size-deck', requestId: randomUUID()};
    const initial = compact(training.mutate('first', 'start', undefined, startBody, true));
    const snapshot = training.snapshot('first', initial.id);
    const accepted = answer(training, initial, snapshot, false);
    const moved = advance(training, accepted.state);
    const later = answer(training, moved, snapshot);
    assert.equal(later.state.answerCount, 2);
    assert.deepEqual(compact(training.mutate('first', 'answer', initial.id, accepted.body, true)), accepted.state);
    const legacy = training.mutate('first', 'answer', initial.id, accepted.body).attempt as Attempt;
    assert.equal(legacy.answers.length, 1);
    assert.equal(legacy.revision, 1);
    assert.equal(legacy.selected, accepted.state.selected);
    assert.equal(legacy.questions[0].word.id, snapshot.questions[0].wordId);
    assert.equal(legacy.answers[0].correct, false);
    const createdReplay = training.mutate('first', 'start', undefined, startBody).attempt as Attempt;
    assert.equal(createdReplay.answers.length, 0);
    assert.equal(createdReplay.revision, 0);
    db.close();
    db = openDatabase(path);
    training = new Training(db, content(), () => 200);
    assert.deepEqual(compact(training.mutate('first', 'answer', initial.id, accepted.body, true)), accepted.state);
    assert.deepEqual(training.snapshot('first', initial.id), snapshot);
    assert.throws(() => training.snapshot('second', initial.id), (error: unknown) => error instanceof ApiError && error.status === 404);
    assert.throws(() => training.history('second', initial.id), (error: unknown) => error instanceof ApiError && error.status === 404);
    assert.deepEqual(training.history('first', initial.id).answers.map(answer => answer.correct), [false, true]);
  } finally { db.close(); await rm(directory, {recursive: true, force: true}); }
});

test('preexisting full-JSON receipts remain replayable in both API formats', () => {
  const db = openDatabase(':memory:');
  try {
    seedUsers(db);
    const data = content(4);
    const deck = data.decks[0];
    const state: Attempt = {id: 'legacy-attempt', deckId: deck.id, status: 'active', revision: 0, deck,
      questions: deck.words.map(word => ({word, options: deck.words})), answers: [], position: 0, selected: null, createdAt: 1, completedAt: null};
    db.prepare('INSERT INTO training_attempts VALUES (?,?,?,?,?,?,NULL)').run(state.id, 'first', deck.id, 'active', JSON.stringify(state), 1);
    const body = {deckId: deck.id, requestId: 'old-create-receipt'};
    const fingerprint = createHash('sha256').update(JSON.stringify(['start', undefined, Object.entries(body).sort(([a], [b]) => a.localeCompare(b))])).digest('hex');
    db.prepare('INSERT INTO mutation_receipts VALUES (?,?,?,?,?)').run('first', body.requestId, fingerprint, JSON.stringify({attempt: state}), 1);
    const training = new Training(db, data, () => 2);
    assert.deepEqual(training.mutate('first', 'start', undefined, body).attempt, state);
    const projection = compact(training.mutate('first', 'start', undefined, body, true));
    assert.equal(projection.id, state.id);
    assert.equal(projection.answerCount, 0);
    assert.equal(training.snapshot('first', state.id).words.length, 4);
    assert.deepEqual(training.history('first', state.id).answers, []);
  } finally { db.close(); }
});

test('over-budget legacy or snapshot creation rolls back without replacing an active attempt', () => {
  const db = openDatabase(':memory:');
  try {
    seedUsers(db);
    const small = new Training(db, content(4), () => 1);
    const original = compact(small.mutate('first', 'start', undefined, {deckId: 'size-deck', requestId: randomUUID()}, true));
    const large = new Training(db, content(2000, 140), () => 2);
    assert.throws(() => large.mutate('first', 'start', undefined, {deckId: 'size-deck', requestId: randomUUID()}),
      (error: unknown) => error instanceof ApiError && error.status === 422 && /compact/i.test(error.message));
    assert.equal(small.owned('first', original.id, true).status, 'active');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM training_attempts').get()!.count, 1);
    const impossible = new Training(db, content(4, 600000), () => 3);
    assert.throws(() => impossible.mutate('first', 'start', undefined, {deckId: 'size-deck', requestId: randomUUID()}, true),
      (error: unknown) => error instanceof ApiError && error.status === 422);
    assert.equal(small.owned('first', original.id, true).status, 'active');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM training_snapshots').get()!.count, 1);
  } finally { db.close(); }
});

test('two-thousand-question completion stays inside snapshot response history and durable-storage budgets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-training-budget-'));
  const path = join(directory, 'app.sqlite');
  const db = openDatabase(path);
  try {
    seedUsers(db);
    const data = content(2000, 140);
    assert(bytes(data.decks[0]) <= 1024 * 1024);
    const repo = new ContentRepository(db, data);
    const training = new Training(db, repo, () => 100);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const before = (await stat(path)).size;
    let state = compact(training.mutate('first', 'start', undefined, {deckId: 'size-deck', requestId: randomUUID()}, true));
    const snapshot = training.snapshot('first', state.id);
    assert.equal(snapshot.questions.length, 2000);
    assert(bytes(snapshot) <= 2 * 1024 * 1024);
    let firstAnswer: ReturnType<typeof answer> | undefined;
    for (let position = 0; position < snapshot.questions.length; position++) {
      const accepted = answer(training, state, snapshot, position !== 0);
      if (position === 0) firstAnswer = accepted;
      state = advance(training, accepted.state);
    }
    assert.equal(state.status, 'completed');
    assert.equal(state.answerCount, 2000);
    assert.equal(state.correct, 1999);
    assert.equal(state.position, 2000);
    const savedReceipt = training.mutate('first', 'answer', state.id, firstAnswer!.body, true);
    assert.deepEqual(savedReceipt.attempt, firstAnswer!.state);
    let cursor: string | undefined;
    const positions: number[] = [];
    do {
      const page = training.history('first', state.id, cursor);
      assert(page.answers.length <= 100);
      positions.push(...page.answers.map(answer => answer.position));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(positions, Array.from({length: 2000}, (_, index) => index));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM training_answers').get()!.count, 2000);
    const maxReceipt = db.prepare('SELECT MAX(length(CAST(response AS BLOB))) AS bytes FROM mutation_receipts').get()!.bytes as number;
    assert(maxReceipt <= 4096);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const growth = (await stat(path)).size - before;
    assert(growth <= 32 * 1024 * 1024, `Durable SQLite growth ${growth} exceeds 32MiB`);
    console.log(`2000-question evidence: snapshot=${bytes(snapshot)}B maxReceipt=${maxReceipt}B durableGrowth=${growth}B; heap/RSS not measured`);
  } finally { db.close(); await rm(directory, {recursive: true, force: true}); }
});
