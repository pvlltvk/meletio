import {createHash, randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {ContentRepository} from './content';
import {transaction} from './database';
import {ApiError, fields, invalid, languageField, stringField} from './types';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}

export class Authoring {
  constructor(private db: DatabaseSync, private content: ContentRepository, private now: () => number) {}

  list(userId: string, cursor?: string) {
    return this.content.list(userId, cursor, true);
  }

  read(userId: string, deckId: string) {
    if (!this.content.metadata(userId, deckId).authored) throw new ApiError(404, 'not_found', 'Learning set not found.');
    return {deck: this.content.deck(userId, deckId)};
  }

  private write<T>(userId: string, requestId: unknown, operation: string, input: unknown, run: () => T): T {
    const id = stringField(requestId, 'request ID', 128);
    const fingerprint = createHash('sha256').update(JSON.stringify(canonical([operation, input]))).digest('hex');
    return transaction(this.db, () => {
      const receipt = this.db.prepare('SELECT fingerprint, response FROM content_mutations WHERE owner_id = ? AND request_id = ?')
        .get(userId, id) as {fingerprint: string; response: string} | undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new ApiError(409, 'request_conflict', 'Request ID was already used for another action.');
        return JSON.parse(receipt.response) as T;
      }
      const result = run();
      this.db.prepare('INSERT INTO content_mutations VALUES (?,?,?,?,?)').run(userId, id, fingerprint, JSON.stringify(result), this.now());
      return result;
    });
  }

  create(userId: string, body: Record<string, unknown>) {
    return this.write(userId, body.requestId, 'POST /api/authoring/decks', body, () => {
      fields(body, ['requestId', 'title', 'termLang', 'meaningLang', 'termDir', 'meaningDir']);
      const title = stringField(body.title, 'learning set title', 240).trim();
      if (!title || [...title].length > 120) invalid('Invalid learning set title.');
      const termLang = languageField(body.termLang);
      const meaningLang = languageField(body.meaningLang);
      const termDir = stringField(body.termDir, 'word direction', 3);
      const meaningDir = stringField(body.meaningDir, 'translation direction', 3);
      if (!['ltr', 'rtl'].includes(termDir) || !['ltr', 'rtl'].includes(meaningDir)) invalid('Invalid text direction.');
      const deckId = randomUUID();
      const instant = this.now();
      this.db.prepare('INSERT INTO imported_decks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(deckId, userId, title, termLang, meaningLang, termDir, meaningDir, 1, '{"kind":"authored"}', '', instant, instant);
      this.content.deck(userId, deckId);
      return {deck: this.content.metadata(userId, deckId)};
    });
  }
}
