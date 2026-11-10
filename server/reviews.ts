import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {Deck, Word} from './types';

interface Review {word_id: string; fingerprint: string; step: number; due_at: number}
const intervals = [1, 3, 7, 14, 30];
const lessonSize = 10;

function fingerprint(deck: Pick<Deck, 'termLang' | 'meaningLang'>, word: Word) {
  return createHash('sha256').update(JSON.stringify([word.term, word.meaning, word.termLang || deck.termLang, word.meaningLang || deck.meaningLang])).digest('hex');
}

export class Reviews {
  constructor(private db: DatabaseSync) {}

  private words(userId: string, deck: Deck, eligible: Word[], now: number) {
    const stored = this.db.prepare('SELECT word_id, fingerprint, step, due_at FROM word_reviews WHERE owner_id = ? AND deck_id = ?').all(userId, deck.id) as unknown as Review[];
    const reviews = new Map(stored.map(review => [review.word_id, review]));
    const due: {word: Word; at: number}[] = [];
    const unseen: Word[] = [];
    let nextDue: number | null = null;
    for (const word of eligible) {
      const review = reviews.get(word.id);
      if (!review || review.fingerprint !== fingerprint(deck, word)) unseen.push(word);
      else if (review.due_at <= now) due.push({word, at: review.due_at});
      else nextDue = nextDue === null ? review.due_at : Math.min(nextDue, review.due_at);
    }
    due.sort((a, b) => a.at - b.at);
    return {due, unseen, nextDue};
  }

  summary(userId: string, deck: Deck, eligible: Word[], now: number) {
    const {due, unseen, nextDue} = this.words(userId, deck, eligible, now);
    return {due: due.length, new: unseen.length, nextDue, lessonSize, asOf: now};
  }

  select(userId: string, deck: Deck, eligible: Word[], now: number) {
    const {due, unseen} = this.words(userId, deck, eligible, now);
    return new Set([...due.map(entry => entry.word), ...unseen].slice(0, lessonSize).map(word => word.id));
  }

  answer(userId: string, deck: Deck, word: Word, snapshotDeck: Pick<Deck, 'termLang' | 'meaningLang'>, snapshotWord: Word, correct: boolean, now: number) {
    const content = fingerprint(deck, word);
    if (content !== fingerprint(snapshotDeck, snapshotWord)) return;
    const previous = this.db.prepare('SELECT fingerprint, step FROM word_reviews WHERE owner_id = ? AND deck_id = ? AND word_id = ?').get(userId, deck.id, word.id) as {fingerprint: string; step: number} | undefined;
    const step = correct ? Math.min((previous?.fingerprint === content ? previous.step : 0) + 1, intervals.length) : 0;
    const due = now + (step ? intervals[step - 1] * 86400000 : 600000);
    this.db.prepare(`INSERT INTO word_reviews (owner_id, deck_id, word_id, fingerprint, step, due_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_id,deck_id,word_id) DO UPDATE SET fingerprint=excluded.fingerprint, step=excluded.step, due_at=excluded.due_at, answered_at=excluded.answered_at`)
      .run(userId, deck.id, word.id, content, step, due, now);
  }
}
