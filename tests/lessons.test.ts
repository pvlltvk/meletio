import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {openDatabase} from '../server/database';
import {Training} from '../server/training';
import type {Content} from '../server/types';

const words = Array.from({length: 14}, (_, index) => ({
  id: `word-${index + 1}`, term: `term ${index + 1}`, meaning: `meaning ${index + 1}`,
  termLang: 'el', meaningLang: 'en', image: null, audio: null,
}));
const content: Content = {uiLanguage: 'en', decks: [{id: 'deck', title: 'Deck', termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr', words}]};

function fixture() {
  const db = openDatabase(':memory:');
  db.prepare('INSERT INTO users VALUES (?,?,?,?)').run('learner', 'learner@example.com', 'hash', 0);
  db.prepare('INSERT INTO users VALUES (?,?,?,?)').run('other', 'other@example.com', 'hash', 0);
  let now = 1_800_000_000_000;
  const training = new Training(db, content, () => now);
  return {db, training, setNow: (value: number) => { now = value; }};
}

function start(training: Training, userId = 'learner', deckId = 'deck', mode?: 'lesson' | 'practice') {
  return training.mutate(userId, 'start', undefined, {deckId, ...(mode ? {mode} : {}), requestId: randomUUID()}, true) as unknown as {
    attempt: {id: string; mode?: string; total: number};
  };
}

test('lesson start is capped at ten while preserving the full eligible choice pool', () => {
  const {db, training} = fixture();
  try {
    const lesson = start(training, 'learner', 'deck', 'lesson').attempt;
    assert.equal(lesson.mode, 'lesson');
    assert.equal(lesson.total, 10);
    const snapshot = training.snapshot('learner', lesson.id);
    assert.equal(snapshot.questions.length, 10);
    assert.ok(snapshot.questions.every(question => question.optionIds.length === 4));
    const practice = start(training).attempt;
    assert.equal(practice.mode, undefined);
    assert.equal(practice.total, 14);
  } finally { db.close(); }
});

test('review summary is account guarded and a correct first lesson answer schedules one new word', () => {
  const {db, training, setNow} = fixture();
  try {
    const summary = training.current('learner', 'deck', true) as unknown as {review: {due: number; new: number; nextDue: number | null; lessonSize: number; asOf: number}};
    assert.deepEqual(summary.review, {due: 0, new: 14, nextDue: null, lessonSize: 10, asOf: 1_800_000_000_000});
    const attempt = start(training, 'learner', 'deck', 'lesson').attempt;
    const question = training.snapshot('learner', attempt.id).questions[0];
    const answer = training.mutate('learner', 'answer', attempt.id, {position: 0, optionId: question.wordId, revision: 0, requestId: 'accepted-answer'}, true);
    assert.equal((answer.attempt as unknown as {mode: string}).mode, 'lesson');
    const after = training.current('learner', 'deck', true) as unknown as {review: {due: number; new: number; nextDue: number | null}};
    assert.equal(after.review.new, 13);
    assert.equal(after.review.due, 0);
    assert.equal(after.review.nextDue, 1_800_000_000_000 + 86_400_000);
    setNow(1_800_000_000_000 + 86_400_000);
    const due = training.current('learner', 'deck', true) as unknown as {review: {due: number; new: number}};
    assert.equal(due.review.due, 1);
    assert.equal(due.review.new, 13);
  } finally { db.close(); }
});

test('manual practice and retry do not alter due and new review counts', () => {
  const {db, training} = fixture();
  try {
    const before = training.current('learner', 'deck', true) as unknown as {review: {due: number; new: number}};
    assert.deepEqual(before.review, {due: 0, new: 14, nextDue: null, lessonSize: 10, asOf: 1_800_000_000_000});
    const practice = start(training).attempt;
    assert.equal(practice.total, 14);
    assert.equal((training.current('learner', 'deck', true) as unknown as {attempt: {mode?: string}}).attempt.mode, undefined);
    const questions = training.snapshot('learner', practice.id).questions;
    questions.forEach((question, position) => {
      const current = training.owned('learner', practice.id, true);
      const optionId = position === 0 ? question.optionIds.find(id => id !== question.wordId)! : question.wordId;
      training.mutate('learner', 'answer', practice.id, {position, optionId, revision: current.revision, requestId: `practice-answer-${position}`}, true);
      training.mutate('learner', 'advance', practice.id, {position, revision: current.revision + 1, requestId: `practice-next-${position}`}, true);
    });
    const retry = training.mutate('learner', 'retry', practice.id, {requestId: 'practice-retry'}, true).attempt;
    assert.equal((retry as unknown as {total: number}).total, 1);
    assert.equal((training.current('learner', 'deck', true) as unknown as {attempt: {mode?: string}}).attempt.mode, undefined);
    const after = training.current('learner', 'deck', true) as unknown as {review: {due: number; new: number; nextDue: number | null; lessonSize: number; asOf: number}};
    assert.deepEqual(after.review, before.review);
  } finally { db.close(); }
});
