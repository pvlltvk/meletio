import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {openDatabase} from '../server/database';
import {Training} from '../server/training';
import type {Content} from '../server/types';

const words = Array.from({length: 14}, (_, index) => ({id: `word-${index + 1}`, term: `term ${index + 1}`, meaning: `meaning ${index + 1}`, termLang: 'el', meaningLang: 'en', image: null, audio: null}));
const makeDeck = (id: string): Content['decks'][number] => ({id, title: id, termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr', words: structuredClone(words)});

function fixture(wordCount = words.length) {
  const db = openDatabase(':memory:');
  db.prepare('INSERT INTO users VALUES (?,?,?,?)').run('one', 'one@example.com', 'hash', 0);
  db.prepare('INSERT INTO users VALUES (?,?,?,?)').run('two', 'two@example.com', 'hash', 0);
  let now = 1_800_000_000_000;
  const decks = [makeDeck('a'), makeDeck('b')].map(deck => ({...deck, words: deck.words.slice(0, wordCount)}));
  const training = new Training(db, {uiLanguage: 'en', decks}, () => now);
  return {db, training, now: () => now, setNow: (value: number) => { now = value; }};
}

function start(training: Training, user: string, deck: string) {
  return training.mutate(user, 'start', undefined, {deckId: deck, mode: 'lesson', requestId: randomUUID()}, true).attempt as unknown as {id: string; revision: number; position: number; total: number; answerCount: number; status: string};
}

function summary(training: Training, user: string, deck: string) {
  return (training.current(user, deck, true) as unknown as {review: {due: number; new: number; nextDue: number | null; asOf: number}}).review;
}

function accept(training: Training, user: string, attempt: {id: string; revision: number; position: number}, wordId: string, correct: boolean, requestId = randomUUID()) {
  const question = training.snapshot(user, attempt.id).questions[attempt.position];
  assert.equal(question.wordId, wordId);
  const optionId = correct ? question.wordId : question.optionIds.find(id => id !== question.wordId)!;
  const answered = training.mutate(user, 'answer', attempt.id, {position: attempt.position, optionId, revision: attempt.revision, requestId}, true).attempt as unknown as {revision: number; position: number};
  training.mutate(user, 'advance', attempt.id, {position: attempt.position, revision: answered.revision, requestId: randomUUID()}, true);
}

function finishCorrectly(training: Training, user: string, attempt: {id: string}) {
  while (true) {
    const current = training.owned(user, attempt.id, true) as unknown as {revision: number; position: number; status: string};
    if (current.status !== 'active') return;
    const question = training.snapshot(user, attempt.id).questions[current.position];
    accept(training, user, {...current, id: attempt.id}, question.wordId, true);
  }
}

function answerWordCorrectly(training: Training, user: string, attempt: {id: string}, wordId: string) {
  const questions = training.snapshot(user, attempt.id).questions;
  const target = questions.findIndex(question => question.wordId === wordId);
  assert.notEqual(target, -1);
  for (let position = 0; position <= target; position++) {
    const current = training.owned(user, attempt.id, true) as unknown as {revision: number; position: number};
    accept(training, user, {...current, id: attempt.id}, questions[position].wordId, true, `review-${wordId}-${position}-${randomUUID()}`);
  }
}

test('wrong answers are due in ten minutes, answer replay is idempotent, and correct review advances the ladder', () => {
  const {db, training, now, setNow} = fixture(4);
  try {
    const initial = summary(training, 'one', 'a');
    assert.equal(initial.new, 4);
    const lesson = start(training, 'one', 'a');
    const question = training.snapshot('one', lesson.id).questions[0];
    const optionId = question.optionIds.find(id => id !== question.wordId)!;
    const body = {position: 0, optionId, revision: 0, requestId: 'wrong-first-answer'};
    const first = training.mutate('one', 'answer', lesson.id, body, true).attempt;
    const replay = training.mutate('one', 'answer', lesson.id, body, true).attempt;
    assert.deepEqual(replay, first);
    assert.throws(() => training.mutate('one', 'answer', lesson.id, {...body, requestId: 'stale-second-answer'}, true), {code: 'stale_session'});
    assert.equal(training.history('one', lesson.id).answers.length, 1);
    assert.equal(summary(training, 'one', 'a').new, 3);
    assert.equal(summary(training, 'one', 'a').due, 0);
    assert.equal(summary(training, 'one', 'a').nextDue, now() + 600_000);

    setNow(now() + 600_000);
    assert.equal(summary(training, 'one', 'a').due, 1);
    const retryLesson = start(training, 'one', 'a');
    answerWordCorrectly(training, 'one', retryLesson, question.wordId);
    finishCorrectly(training, 'one', retryLesson);
    assert.equal(summary(training, 'one', 'a').nextDue, now() + 86_400_000);

    for (const [days, interval] of [[1, 3], [3, 7], [7, 14], [14, 30], [30, 30]] as const) {
      setNow(now() + days * 86_400_000);
      const current = summary(training, 'one', 'a');
      assert.ok(current.due >= 1);
      const next = start(training, 'one', 'a');
      finishCorrectly(training, 'one', next);
      assert.equal(summary(training, 'one', 'a').nextDue, now() + interval * 86_400_000);
    }
  } finally { db.close(); }
});

test('a failed review write rolls back the accepted answer and receipt; a superseded lesson keeps its accepted answer', () => {
  const {db, training, now, setNow} = fixture();
  try {
    const lesson = start(training, 'one', 'a');
    const question = training.snapshot('one', lesson.id).questions[0];
    const body = {position: 0, optionId: question.wordId, revision: 0, requestId: 'retry-after-rollback'};
    db.exec("CREATE TRIGGER fail_lesson_review BEFORE INSERT ON word_reviews BEGIN SELECT RAISE(ABORT, 'injected review failure'); END");
    assert.throws(() => training.mutate('one', 'answer', lesson.id, body, true));
    assert.equal((training.owned('one', lesson.id, true) as unknown as {selected: string | null; answerCount: number}).selected, null);
    assert.equal((db.prepare('SELECT count(*) AS n FROM mutation_receipts WHERE request_id=?').get(body.requestId) as {n: number}).n, 0);
    db.exec('DROP TRIGGER fail_lesson_review');
    training.mutate('one', 'answer', lesson.id, body, true);
    const replacement = start(training, 'one', 'a');
    const superseded = training.owned('one', lesson.id, true) as unknown as {status: string; answerCount: number};
    assert.equal(superseded.status, 'superseded');
    assert.equal(superseded.answerCount, 1);
    assert.equal(summary(training, 'one', 'a').new, 13);
    assert.equal(summary(training, 'one', 'a').nextDue, now() + 86_400_000);

    const sameIdOtherDeck = summary(training, 'one', 'b');
    const sameIdOtherUser = summary(training, 'two', 'a');
    assert.equal(sameIdOtherDeck.new, 14);
    assert.equal(sameIdOtherUser.new, 14);
    assert.equal(training.snapshot('one', replacement.id).deck.id, 'a');
    setNow(now() + 86_400_000);
    assert.equal(summary(training, 'one', 'a').due, 1);
    assert.equal(summary(training, 'one', 'b').due, 0);
    assert.equal(summary(training, 'two', 'a').due, 0);
  } finally { db.close(); }
});
