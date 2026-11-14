import {createHash, randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {ContentRepository} from './content';
import {transaction} from './database';
import {ApiError, fields, invalid, languageField, stringField} from './types';

function canonical(value: unknown, depth = 0): unknown {
  if (depth > 8) invalid('Request nesting is too deep.');
  if (Array.isArray(value)) return value.map(entry => canonical(entry, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry, depth + 1)]));
  return value;
}

interface StoredWord {id: string; image_media_id: string | null; audio_media_id: string | null}

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

  batch(userId: string, deckId: string, body: Record<string, unknown>) {
    return this.write(userId, body.requestId, `POST /api/authoring/decks/${deckId}/words`, body, () => {
      fields(body, ['requestId', 'revision', 'words']);
      if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 1) invalid('Invalid learning set revision.');
      if (!Array.isArray(body.words) || body.words.length < 1 || body.words.length > 100) invalid('Send between 1 and 100 words.');
      const metadata = this.content.metadata(userId, deckId);
      if (!metadata.authored) throw new ApiError(404, 'not_found', 'Learning set not found.');
      if (metadata.revision !== body.revision) throw new ApiError(409, 'stale_content', 'This learning set changed. Reload it and try again.');
      const existing = new Map((this.db.prepare(`SELECT w.id, w.image_media_id, w.audio_media_id FROM imported_words w
        LEFT JOIN word_overrides o ON o.word_id = w.id WHERE w.deck_id = ? AND o.deleted_at IS NULL`).all(deckId) as unknown as StoredWord[])
        .map(word => [word.id, word]));
      const seen = new Set<string>();
      const text = (value: unknown, name: string) => {
        const result = stringField(value, name, 4000).trim();
        if (!result || [...result].length > 2000) invalid(`Invalid ${name}.`);
        return result;
      };
      const identifier = (value: unknown, name: string) => {
        const id = stringField(value, name, 128);
        if (!/^[a-zA-Z0-9-]+$/.test(id)) invalid(`Invalid ${name}.`);
        return id;
      };
      const media = (value: unknown, kind: string) => {
        if (value === null) return null;
        const id = identifier(value, `${kind} media ID`);
        const row = this.db.prepare('SELECT mime FROM imported_media WHERE id = ? AND owner_id = ?').get(id, userId) as {mime: string} | undefined;
        if (!row) throw new ApiError(404, 'not_found', 'Media not found.');
        if (!row.mime.startsWith(kind + '/')) invalid(`Invalid ${kind} media.`);
        return id;
      };
      const words = body.words.map((value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Invalid word.');
        const word = value as Record<string, unknown>;
        fields(word, ['id', 'term', 'meaning', 'imageMediaId', 'audioMediaId']);
        const id = Object.hasOwn(word, 'id') ? identifier(word.id, 'word ID') : null;
        if (id && seen.has(id)) invalid('A word ID appears more than once.');
        if (id) seen.add(id);
        const previous = id ? existing.get(id) : undefined;
        if (id && !previous) throw new ApiError(404, 'not_found', 'Word not found.');
        return {id: id || randomUUID(), added: !id, term: text(word.term, 'word'), meaning: text(word.meaning, 'translation'),
          image: Object.hasOwn(word, 'imageMediaId') ? media(word.imageMediaId, 'image') : previous?.image_media_id ?? null,
          audio: Object.hasOwn(word, 'audioMediaId') ? media(word.audioMediaId, 'audio') : previous?.audio_media_id ?? null};
      });
      if (existing.size + words.filter(word => word.added).length > 2000) throw new ApiError(422, 'content_too_large', 'The learning set exceeds the 2,000-word limit.');
      let order = Number((this.db.prepare('SELECT MAX(sort_order) AS last FROM imported_words WHERE deck_id = ?').get(deckId) as {last: number | null}).last ?? -1) + 1;
      const instant = this.now();
      for (const word of words) {
        const hash = createHash('sha256').update(JSON.stringify([word.term, word.meaning, word.image, word.audio])).digest('hex');
        if (word.added) this.db.prepare('INSERT INTO imported_words VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(word.id, deckId, word.id, instant, hash, word.term, word.meaning, word.image, word.audio, order++);
        else {
          this.db.prepare('UPDATE imported_words SET term = ?, meaning = ?, image_media_id = ?, audio_media_id = ?, source_modified = ?, content_hash = ? WHERE deck_id = ? AND id = ?')
            .run(word.term, word.meaning, word.image, word.audio, instant, hash, deckId, word.id);
          this.db.prepare('UPDATE word_overrides SET term = NULL, meaning = NULL WHERE word_id = ? AND deleted_at IS NULL').run(word.id);
        }
      }
      const revision = metadata.revision + 1;
      this.db.prepare('UPDATE imported_decks SET revision = ?, updated_at = ? WHERE id = ?').run(revision, instant, deckId);
      const current = new Map(this.content.deck(userId, deckId).words.map(word => [word.id, word]));
      return {deckId, revision, words: words.map(word => current.get(word.id)!)};
    });
  }
}
