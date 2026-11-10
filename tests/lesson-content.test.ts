import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {openDatabase} from '../server/database';
import {Training} from '../server/training';
import type {Content, Deck} from '../server/types';

const words = Array.from({length: 14}, (_, index) => ({id: `word-${index + 1}`, term: `term ${index + 1}`, meaning: `meaning ${index + 1}`, termLang: 'el', meaningLang: 'en', image: null as string | null, audio: null as string | null}));

function fixture(wordCount = words.length) {
  const db = openDatabase(':memory:');
  db.prepare('INSERT INTO users VALUES (?,?,?,?)').run('learner', 'learner@example.com', 'hash', 0);
  const deck: Deck = {id: 'deck', title: 'Original title', termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr', words: structuredClone(words.slice(0, wordCount))};
  const content: Content = {uiLanguage: 'en', decks: [deck]};
  let now = 1_800_000_000_000;
  const training = new Training(db, content, () => now);
  return {db, content, training, now: () => now, setNow: (value: number) => { now = value; }};
}

function start(training: Training) {
  return training.mutate('learner', 'start', undefined, {deckId: 'deck', mode: 'lesson', requestId: randomUUID()}, true).attempt as unknown as {id: string; total: number};
}

function review(training: Training) {
  return (training.current('learner', 'deck', true) as unknown as {review: {due: number; new: number; nextDue: number | null}}).review;
}

function answerWord(training: Training, attempt: {id: string}, wordId: string, correct: boolean) {
  const questions = training.snapshot('learner', attempt.id).questions;
  const target = questions.findIndex(question => question.wordId === wordId);
  assert.notEqual(target, -1);
  for (let position = 0; position <= target; position++) {
    const current = training.owned('learner', attempt.id, true) as unknown as {revision: number; position: number};
    const question = questions[position];
    const optionId = position === target && !correct ? question.optionIds.find(id => id !== question.wordId)! : question.wordId;
    const saved = training.mutate('learner', 'answer', attempt.id, {position, optionId, revision: current.revision, requestId: randomUUID()}, true).attempt as unknown as {revision: number};
    training.mutate('learner', 'advance', attempt.id, {position, revision: saved.revision, requestId: randomUUID()}, true);
  }
}

test('lesson selection takes due words first, fills from source order, and draws choices from the full eligible set', () => {
  const {db, training, now, setNow} = fixture();
  try {
    const first = start(training);
    const missedWord = training.snapshot('learner', first.id).questions[0].wordId;
    answerWord(training, first, missedWord, false);
    assert.equal(review(training).new, 13);
    assert.equal(review(training).nextDue, now() + 600_000);

    setNow(now() + 600_000);
    assert.equal(review(training).due, 1);
    const next = start(training);
    const snapshot = training.snapshot('learner', next.id);
    const actualIds = snapshot.questions.map(question => question.wordId);
    const expectedIds = [missedWord, ...words.map(word => word.id).filter(id => id !== missedWord).slice(0, 9)];
    assert.equal(actualIds.length, 10);
    assert.deepEqual(new Set(actualIds), new Set(expectedIds));
    assert.ok(snapshot.questions.every(question => question.optionIds.length === 4));
    assert.ok(snapshot.questions.every(question => question.optionIds.every(id => words.some(word => word.id === id))));
  } finally { db.close(); }
});

test('one due word still gets distractors from the full eligible deck', () => {
  const {db, training, now, setNow} = fixture(4);
  try {
    const first = start(training);
    const questions = training.snapshot('learner', first.id).questions;
    const missed = questions[0].wordId;
    answerWord(training, first, missed, false);
    const remaining = training.owned('learner', first.id, true) as unknown as {status: string};
    assert.equal(remaining.status, 'active');
    while ((training.owned('learner', first.id, true) as unknown as {status: string}).status === 'active') {
      const current = training.owned('learner', first.id, true) as unknown as {revision: number; position: number};
      const wordId = training.snapshot('learner', first.id).questions[current.position].wordId;
      const accepted = training.mutate('learner', 'answer', first.id, {position: current.position, optionId: wordId, revision: current.revision, requestId: randomUUID()}, true).attempt as unknown as {revision: number};
      training.mutate('learner', 'advance', first.id, {position: current.position, revision: accepted.revision, requestId: randomUUID()}, true);
    }
    setNow(now() + 600_000);
    assert.equal(review(training).due, 1);
    const next = start(training);
    const snapshot = training.snapshot('learner', next.id);
    assert.equal(snapshot.questions.length, 1);
    assert.equal(snapshot.questions[0].wordId, missed);
    assert.equal(snapshot.questions[0].optionIds.length, 4);
    assert.deepEqual(new Set(snapshot.questions[0].optionIds), new Set(words.slice(0, 4).map(word => word.id)));
  } finally { db.close(); }
});

test('when more than ten words are due, the oldest due words take the lesson slots', () => {
  const {db, training, now} = fixture();
  try {
    const insert = db.prepare('INSERT INTO word_reviews(owner_id,deck_id,word_id,fingerprint,step,due_at,answered_at) VALUES(?,?,?,?,?,?,?)');
    words.forEach((word, index) => {
      const fingerprint = createHash('sha256').update(JSON.stringify([word.term, word.meaning, word.termLang, word.meaningLang])).digest('hex');
      insert.run('learner', 'deck', word.id, fingerprint, 0, now() - (words.length - index) * 1000, now() - 100_000);
    });
    assert.equal(review(training).due, 14);
    assert.equal(review(training).new, 0);
    const lesson = start(training);
    const ids = training.snapshot('learner', lesson.id).questions.map(question => question.wordId);
    assert.equal(ids.length, 10);
    assert.deepEqual(new Set(ids), new Set(words.slice(0, 10).map(word => word.id)));
  } finally { db.close(); }
});

test('learning text and effective language changes make saved reviews new; title and media edits preserve them', () => {
  const {db, content, training, now} = fixture();
  try {
    const original = start(training);
    const target = training.snapshot('learner', original.id).questions[0].wordId;
    const targetWord = content.decks[0].words.find(word => word.id === target)!;
    targetWord.term = 'changed term';
    const changedCount = review(training).new;
    assert.equal(changedCount, 14);
    answerWord(training, original, target, true);
    assert.equal(review(training).new, changedCount - training.history('learner', original.id).answers.length + 1);
    assert.equal(db.prepare('SELECT 1 FROM word_reviews WHERE owner_id=? AND deck_id=? AND word_id=?').get('learner', 'deck', target), undefined);

    const current = start(training);
    answerWord(training, current, target, true);
    const scheduled = review(training);
    assert.equal(scheduled.nextDue, now() + 86_400_000);
    const scheduledNew = scheduled.new;

    content.decks[0].title = 'Renamed deck';
    targetWord.image = '/demo/new-picture.svg';
    targetWord.audio = '/demo/new-audio.mp3';
    assert.deepEqual(review(training), scheduled);

    targetWord.meaningLang = 'fr';
    assert.equal(review(training).new, scheduledNew + 1);
    assert.equal(review(training).due, scheduled.due);
  } finally { db.close(); }
});

test('deleted words are excluded and an old snapshot answer does not create review state', () => {
  const {db, content, training} = fixture();
  try {
    const lesson = start(training);
    const target = training.snapshot('learner', lesson.id).questions[0].wordId;
    const before = review(training);
    content.decks[0].words = content.decks[0].words.filter(word => word.id !== target);
    const afterDelete = review(training);
    assert.equal(afterDelete.new, before.new - 1);
    answerWord(training, lesson, target, true);
    assert.deepEqual(review(training), afterDelete);
    assert.equal(training.history('learner', lesson.id).answers.length, training.owned('learner', lesson.id, true).answerCount);
  } finally { db.close(); }
});
