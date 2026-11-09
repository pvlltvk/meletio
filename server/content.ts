import type {DatabaseSync} from 'node:sqlite';
import {ApiError, invalid, type Content, type Deck, type DeckMetadata, type Word} from './types';

const pageLimit = 128 * 1024;
const deckLimit = 1024 * 1024;

interface ImportedDeck {
  id: string;
  title: string;
  term_lang: string;
  meaning_lang: string;
  term_dir: string;
  meaning_dir: string;
  revision: number;
  word_count?: number;
}

interface ImportedWord {
  id: string;
  term: string;
  meaning: string;
  image_media_id: string | null;
  audio_media_id: string | null;
}

function metadata(row: ImportedDeck): DeckMetadata {
  return {id: row.id, title: row.title, termLang: row.term_lang, meaningLang: row.meaning_lang,
    termDir: row.term_dir, meaningDir: row.meaning_dir, wordCount: row.word_count || 0,
    revision: row.revision, imported: true, editable: true};
}

export function deckMetadata(deck: Deck): DeckMetadata {
  const details = deck as Deck & {revision?: number; imported?: boolean; editable?: boolean};
  return {id: deck.id, title: deck.title, termLang: deck.termLang, meaningLang: deck.meaningLang,
    termDir: deck.termDir, meaningDir: deck.meaningDir, wordCount: deck.words.length,
    revision: details.revision || 1, imported: details.imported || false, editable: details.editable || false};
}

function cursorKey(cursor: string | undefined): string {
  if (cursor === undefined) return '';
  if (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalid('Invalid catalog cursor.');
  const key = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^(demo|import):.+$/.test(key) || Buffer.from(key).toString('base64url') !== cursor) invalid('Invalid catalog cursor.');
  return key;
}

export class ContentRepository {
  constructor(private db: DatabaseSync, private demo: Content) {}

  private defaultDeck(userId: string, id: string): Deck | undefined {
    const original = this.demo.decks.find(deck => deck.id === id);
    if (!original) return;
    const override = this.db.prepare('SELECT title, deleted_at, revision FROM default_deck_overrides WHERE owner_id = ? AND deck_id = ?').get(userId, id) as {title: string | null; deleted_at: number | null; revision: number} | undefined;
    if (override?.deleted_at != null) return;
    const rows = this.db.prepare('SELECT word_id, term, meaning, deleted_at FROM default_word_overrides WHERE owner_id = ? AND deck_id = ?').all(userId, id) as unknown as {word_id: string; term: string | null; meaning: string | null; deleted_at: number | null}[];
    const overrides = new Map(rows.map(row => [row.word_id, row]));
    const words = original.words.flatMap(word => {
      const local = overrides.get(word.id);
      return local?.deleted_at != null ? [] : [{...word, term: local?.term ?? word.term, meaning: local?.meaning ?? word.meaning}];
    });
    const deck = {...structuredClone(original), title: override?.title ?? original.title, words};
    return {...deck, ...deckMetadata(deck), revision: override?.revision || 1, imported: false, editable: true} as Deck;
  }

  list(userId: string, cursor?: string) {
    const after = cursorKey(cursor);
    const demos = this.demo.decks.flatMap((original, index) => {
      const deck = this.defaultDeck(userId, original.id);
      return deck ? [{key: `demo:${String(index).padStart(8, '0')}:${original.id}`, deck: deckMetadata(deck)}] : [];
    }).filter(entry => entry.key > after);
    const lastImported = after.startsWith('import:') ? after.slice(7) : '';
    const imported = (this.db.prepare(`SELECT d.id, COALESCE(o.title,d.title) AS title, d.term_lang, d.meaning_lang, d.term_dir, d.meaning_dir, d.revision,
      (SELECT COUNT(*) FROM imported_words w LEFT JOIN word_overrides wo ON wo.word_id = w.id WHERE w.deck_id = d.id AND wo.deleted_at IS NULL) AS word_count
      FROM imported_decks d LEFT JOIN deck_overrides o ON o.deck_id = d.id WHERE d.owner_id = ? AND d.id > ? AND o.deleted_at IS NULL ORDER BY d.id LIMIT 51`).all(userId, lastImported) as unknown as ImportedDeck[])
      .map(row => ({key: `import:${row.id}`, deck: metadata(row)}));
    const candidates = [...demos, ...imported].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const decks: DeckMetadata[] = [];
    let last = '';
    for (const candidate of candidates) {
      if (decks.length === 50) break;
      const nextCursor = Buffer.from(candidate.key).toString('base64url');
      if (Buffer.byteLength(JSON.stringify({uiLanguage: this.demo.uiLanguage, decks: [...decks, candidate.deck], nextCursor})) > pageLimit) {
        if (!decks.length) throw new ApiError(422, 'catalog_too_large', 'Learning set metadata exceeds the catalog limit.');
        break;
      }
      decks.push(candidate.deck);
      last = candidate.key;
    }
    return {uiLanguage: this.demo.uiLanguage, decks,
      nextCursor: decks.length < candidates.length ? Buffer.from(last).toString('base64url') : null};
  }

  metadata(userId: string, id: string): DeckMetadata {
    const row = this.db.prepare(`SELECT d.id, COALESCE(o.title,d.title) AS title, d.term_lang, d.meaning_lang, d.term_dir, d.meaning_dir, d.revision,
      (SELECT COUNT(*) FROM imported_words w LEFT JOIN word_overrides wo ON wo.word_id = w.id WHERE w.deck_id = d.id AND wo.deleted_at IS NULL) AS word_count
      FROM imported_decks d LEFT JOIN deck_overrides o ON o.deck_id = d.id WHERE d.id = ? AND d.owner_id = ? AND o.deleted_at IS NULL`).get(id, userId) as unknown as ImportedDeck | undefined;
    if (row) return metadata(row);
    const deck = this.defaultDeck(userId, id);
    if (!deck) throw new ApiError(404, 'not_found', 'Learning set not found.');
    return deckMetadata(deck);
  }

  deck(userId: string, id: string): Deck {
    const row = this.db.prepare(`SELECT d.id, COALESCE(o.title,d.title) AS title, d.term_lang, d.meaning_lang, d.term_dir, d.meaning_dir, d.revision
      FROM imported_decks d LEFT JOIN deck_overrides o ON o.deck_id = d.id WHERE d.id = ? AND d.owner_id = ? AND o.deleted_at IS NULL`).get(id, userId) as unknown as ImportedDeck | undefined;
    let deck: Deck;
    if (row) {
      const rows = this.db.prepare(`SELECT w.id, COALESCE(o.term,w.term) AS term, COALESCE(o.meaning,w.meaning) AS meaning, w.image_media_id, w.audio_media_id
        FROM imported_words w LEFT JOIN word_overrides o ON o.word_id = w.id WHERE w.deck_id = ? AND o.deleted_at IS NULL ORDER BY w.sort_order, w.id`).all(id) as unknown as ImportedWord[];
      const words: Word[] = rows.map(word => ({id: word.id, term: word.term, meaning: word.meaning,
        termLang: row.term_lang, meaningLang: row.meaning_lang,
        image: word.image_media_id ? `/api/media/${encodeURIComponent(word.image_media_id)}` : null,
        audio: word.audio_media_id ? `/api/media/${encodeURIComponent(word.audio_media_id)}` : null}));
      deck = {...metadata({...row, word_count: words.length}), words};
    } else {
      const demo = this.defaultDeck(userId, id);
      if (!demo) throw new ApiError(404, 'not_found', 'Learning set not found.');
      deck = structuredClone(demo);
    }
    if (Buffer.byteLength(JSON.stringify(deck)) > deckLimit) throw new ApiError(422, 'deck_too_large', 'Learning set exceeds the selected-deck limit.');
    return deck;
  }

  media(userId: string, id: string): {bytes: Uint8Array; mime: string; size: number} | undefined {
    const row = this.db.prepare('SELECT bytes, mime, size FROM imported_media WHERE id = ? AND owner_id = ?').get(id, userId) as {bytes: Uint8Array; mime: string; size: number} | undefined;
    return row;
  }

  source(userId: string, id: string): unknown {
    const row = this.db.prepare(`SELECT d.source_json FROM imported_decks d LEFT JOIN deck_overrides o ON o.deck_id = d.id
      WHERE d.id = ? AND d.owner_id = ? AND o.deleted_at IS NULL`).get(id, userId) as {source_json: string} | undefined;
    return row ? JSON.parse(row.source_json) : null;
  }
}
