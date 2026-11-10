import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const version = db.prepare('PRAGMA user_version').get() as {user_version: number};
    if (version.user_version > 5) throw new Error('Unsupported database schema version.');
    db.exec('PRAGMA journal_mode = WAL;');
    if (version.user_version === 0) {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
        CREATE INDEX sessions_user ON auth_sessions(user_id);
        CREATE TABLE training_attempts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), deck_id TEXT NOT NULL, status TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, completed_at INTEGER);
        CREATE UNIQUE INDEX active_attempt ON training_attempts(user_id, deck_id) WHERE status = 'active';
        CREATE INDEX attempts_user_deck ON training_attempts(user_id, deck_id, created_at);
        CREATE TABLE mutation_receipts (user_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, request_id));
        PRAGMA user_version = 1;
        COMMIT;`);
    }
    if (version.user_version < 2) {
      transaction(db, () => {
        db.exec(`
          CREATE TABLE imported_decks (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, term_lang TEXT NOT NULL, meaning_lang TEXT NOT NULL, term_dir TEXT NOT NULL, meaning_dir TEXT NOT NULL, revision INTEGER NOT NULL, source_json TEXT NOT NULL, last_package_hash TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
          CREATE INDEX imported_decks_owner ON imported_decks(owner_id, created_at, id);
          CREATE TABLE imported_media (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), sha256 TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, bytes BLOB NOT NULL, UNIQUE(owner_id,sha256,mime));
          CREATE TABLE imported_words (id TEXT PRIMARY KEY, deck_id TEXT NOT NULL REFERENCES imported_decks(id), source_guid TEXT NOT NULL, source_modified INTEGER NOT NULL, content_hash TEXT NOT NULL, term TEXT NOT NULL, meaning TEXT NOT NULL, image_media_id TEXT REFERENCES imported_media(id), audio_media_id TEXT REFERENCES imported_media(id), sort_order INTEGER NOT NULL, UNIQUE(deck_id,source_guid));
          CREATE TABLE import_stages (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL, archive_hash TEXT, directory TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, preview_json TEXT, error TEXT, UNIQUE(owner_id,request_id));
          CREATE TABLE import_commits (owner_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner_id,request_id));
          CREATE TABLE training_snapshots (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), content TEXT NOT NULL);
          CREATE TABLE training_answers (attempt_id TEXT NOT NULL REFERENCES training_attempts(id), position INTEGER NOT NULL, word_id TEXT NOT NULL, option_id TEXT NOT NULL, correct INTEGER NOT NULL, PRIMARY KEY(attempt_id,position));
          PRAGMA user_version = 2;
        `);
      });
    }
    if (version.user_version < 3) {
      transaction(db, () => {
        db.exec(`
          CREATE TABLE word_overrides (word_id TEXT PRIMARY KEY REFERENCES imported_words(id), term TEXT, meaning TEXT, deleted_at INTEGER);
          CREATE TABLE deck_overrides (deck_id TEXT PRIMARY KEY REFERENCES imported_decks(id), title TEXT, deleted_at INTEGER);
          CREATE TABLE content_mutations (owner_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner_id,request_id));
          CREATE INDEX imported_decks_source ON imported_decks(owner_id,json_extract(source_json,'$.sourceDeckId'),json_extract(source_json,'$.noteTypeId'));
          PRAGMA user_version = 3;
        `);
      });
    }
    if (version.user_version < 4) {
      transaction(db, () => {
        db.exec(`
          CREATE TABLE default_deck_overrides (owner_id TEXT NOT NULL REFERENCES users(id), deck_id TEXT NOT NULL, title TEXT, deleted_at INTEGER, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(owner_id,deck_id));
          CREATE TABLE default_word_overrides (owner_id TEXT NOT NULL REFERENCES users(id), deck_id TEXT NOT NULL, word_id TEXT NOT NULL, term TEXT, meaning TEXT, deleted_at INTEGER, PRIMARY KEY(owner_id,deck_id,word_id));
          PRAGMA user_version = 4;
        `);
      });
    }
    if (version.user_version < 5) {
      transaction(db, () => {
        db.exec(`
          CREATE TABLE word_reviews (owner_id TEXT NOT NULL REFERENCES users(id), deck_id TEXT NOT NULL, word_id TEXT NOT NULL, fingerprint TEXT NOT NULL, step INTEGER NOT NULL CHECK(step BETWEEN 0 AND 5), due_at INTEGER NOT NULL, answered_at INTEGER NOT NULL, PRIMARY KEY(owner_id,deck_id,word_id));
          PRAGMA user_version = 5;
        `);
      });
    }
    db.exec("CREATE INDEX IF NOT EXISTS imported_decks_source ON imported_decks(owner_id,json_extract(source_json,'$.sourceDeckId'),json_extract(source_json,'$.noteTypeId'))");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
