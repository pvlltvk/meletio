import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {ContentRepository} from './content';
import {transaction} from './database';
import {ApiError, fields, invalid, stringField, type Word} from './types';

interface MutationResult {deckId: string; revision: number; word?: Word; title?: string; deleted?: boolean}

export class ContentMutations {
  constructor(private db: DatabaseSync, private content: ContentRepository, private now: () => number) {}

  mutate(userId: string, deckId: string, wordId: string | undefined, action: string, body: Record<string, unknown>) {
    fields(body, ['revision', 'requestId', ...(action === 'rename' ? ['title'] : action === 'edit' ? ['term', 'meaning'] : [])]);
    if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 1) invalid('Invalid learning set revision.');
    const requestId = stringField(body.requestId, 'request ID', 128);
    const text = (value: unknown, name: string, max: number) => {
      const result = stringField(value, name, max * 2).trim();
      if (!result || [...result].length > max) invalid(`Invalid ${name}.`);
      return result;
    };
    const title = action === 'rename' ? text(body.title, 'learning set title', 120) : null;
    const term = action === 'edit' ? text(body.term, 'word', 2000) : null;
    const meaning = action === 'edit' ? text(body.meaning, 'translation', 2000) : null;
    const fingerprint = createHash('sha256').update(JSON.stringify([deckId, wordId, action, Object.entries(body).sort(([a], [b]) => a.localeCompare(b))])).digest('hex');
    return transaction(this.db, () => {
      const receipt = this.db.prepare('SELECT fingerprint, response FROM content_mutations WHERE owner_id = ? AND request_id = ?').get(userId, requestId) as {fingerprint: string; response: string} | undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new ApiError(409, 'request_conflict', 'Request ID was already used for another action.');
        return JSON.parse(receipt.response) as MutationResult;
      }
      const deck = this.content.metadata(userId, deckId);
      if (!deck.editable) throw new ApiError(403, 'readonly_content', 'This learning set cannot be changed.');
      if (deck.revision !== body.revision) throw new ApiError(409, 'stale_content', 'This learning set changed. Reload it and try again.');
      const revision = deck.revision + 1;
      if (deck.imported) {
        if (wordId) {
          const word = this.db.prepare(`SELECT w.id, w.term, w.meaning FROM imported_words w LEFT JOIN word_overrides o ON o.word_id = w.id
            WHERE w.id = ? AND w.deck_id = ? AND o.deleted_at IS NULL`).get(wordId, deckId) as {id: string; term: string; meaning: string} | undefined;
          if (!word) throw new ApiError(404, 'not_found', 'Word not found.');
          if (action === 'edit') this.db.prepare(`INSERT INTO word_overrides (word_id,term,meaning) VALUES (?,?,?)
            ON CONFLICT(word_id) DO UPDATE SET term = excluded.term, meaning = excluded.meaning`).run(wordId, term === word.term ? null : term, meaning === word.meaning ? null : meaning);
          else this.db.prepare(`INSERT INTO word_overrides (word_id,deleted_at) VALUES (?,?)
            ON CONFLICT(word_id) DO UPDATE SET deleted_at = excluded.deleted_at`).run(wordId, this.now());
        } else if (action === 'rename') {
          const base = this.db.prepare('SELECT title FROM imported_decks WHERE id = ?').get(deckId) as {title: string};
          this.db.prepare(`INSERT INTO deck_overrides (deck_id,title) VALUES (?,?)
            ON CONFLICT(deck_id) DO UPDATE SET title = excluded.title`).run(deckId, title === base.title ? null : title);
        } else this.db.prepare(`INSERT INTO deck_overrides (deck_id,deleted_at) VALUES (?,?)
          ON CONFLICT(deck_id) DO UPDATE SET deleted_at = excluded.deleted_at`).run(deckId, this.now());
        this.db.prepare('UPDATE imported_decks SET revision = ?, updated_at = ? WHERE id = ?').run(revision, this.now(), deckId);
      } else {
        if (wordId) {
          if (!this.content.deck(userId, deckId).words.some(word => word.id === wordId)) throw new ApiError(404, 'not_found', 'Word not found.');
          if (action === 'edit') this.db.prepare(`INSERT INTO default_word_overrides (owner_id,deck_id,word_id,term,meaning) VALUES (?,?,?,?,?)
            ON CONFLICT(owner_id,deck_id,word_id) DO UPDATE SET term = excluded.term, meaning = excluded.meaning`).run(userId, deckId, wordId, term, meaning);
          else this.db.prepare(`INSERT INTO default_word_overrides (owner_id,deck_id,word_id,deleted_at) VALUES (?,?,?,?)
            ON CONFLICT(owner_id,deck_id,word_id) DO UPDATE SET deleted_at = excluded.deleted_at`).run(userId, deckId, wordId, this.now());
        } else if (action === 'rename') this.db.prepare(`INSERT INTO default_deck_overrides (owner_id,deck_id,title) VALUES (?,?,?)
          ON CONFLICT(owner_id,deck_id) DO UPDATE SET title = excluded.title`).run(userId, deckId, title);
        else this.db.prepare(`INSERT INTO default_deck_overrides (owner_id,deck_id,deleted_at) VALUES (?,?,?)
          ON CONFLICT(owner_id,deck_id) DO UPDATE SET deleted_at = excluded.deleted_at`).run(userId, deckId, this.now());
        this.db.prepare(`INSERT INTO default_deck_overrides (owner_id,deck_id,revision) VALUES (?,?,?)
          ON CONFLICT(owner_id,deck_id) DO UPDATE SET revision = excluded.revision`).run(userId, deckId, revision);
      }
      const result: MutationResult = {deckId, revision};
      if (action === 'delete') result.deleted = true;
      else {
        const current = this.content.deck(userId, deckId);
        if (wordId) result.word = current.words.find(word => word.id === wordId)!;
        else result.title = current.title;
      }
      this.db.prepare('INSERT INTO content_mutations VALUES (?,?,?,?,?)').run(userId, requestId, fingerprint, JSON.stringify(result), this.now());
      return result;
    });
  }
}
