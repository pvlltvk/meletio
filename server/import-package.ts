import {createHash} from 'node:crypto';
import {chmod, mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import {extname, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {crc32} from 'node:zlib';
import {openPromise, type Entry, type ZipFile} from 'yauzl';
import {IMPORT_LIMITS, type ParsedPackage} from './import-types';
import {optimizeImage} from './import-images';
import {importSourceChoices, profileMediaFields, suggestImport} from './import-suggestions';

const exportHelp = 'Unsupported Anki package. Re-export the deck with Include Media and Support older Anki versions enabled.';

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function sourceText(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(message);
  return value;
}

function sourceId(value: unknown): string {
  const id = sourceText(value, 'Invalid source ID');
  if (!/^[0-9]+$/.test(id) || id.length > 20) throw new Error('Invalid source ID');
  return id;
}

function mediaName(value: string): string {
  if (!value || value.length > 255 || /[\\/\x00-\x1f\x7f:]/.test(value) || value === '.' || value === '..') throw new Error('Invalid media filename/path');
  return value.normalize('NFC');
}

function mediaMap(json: string): Map<string, string> {
  const result = new Map<string, string>();
  const names = new Set<string>();
  let offset = 0;
  const whitespace = () => { while (/\s/.test(json[offset] || '') && offset < json.length) offset++; };
  const string = () => {
    whitespace();
    if (json[offset] !== '"') throw new Error('Invalid media map string');
    const start = offset++;
    while (offset < json.length) {
      const char = json[offset++];
      if (char === '\\') offset++;
      else if (char === '"') return JSON.parse(json.slice(start, offset)) as string;
    }
    throw new Error('Invalid media map JSON');
  };
  whitespace();
  if (json[offset++] !== '{') throw new Error('Invalid media map JSON object');
  whitespace();
  if (json[offset] !== '}') while (true) {
    const key = string();
    if (!/^(0|[1-9][0-9]*)$/.test(key) || key.length > 10 || result.has(key)) throw new Error('Invalid or duplicate media map key');
    whitespace();
    if (json[offset++] !== ':') throw new Error('Invalid media map JSON');
    const name = mediaName(string());
    if (names.has(name)) throw new Error('Duplicate media filename');
    names.add(name);
    result.set(key, name);
    if (result.size > IMPORT_LIMITS.entries) throw new Error('Media map entry limit exceeded');
    whitespace();
    if (json[offset] !== ',') break;
    offset++;
  }
  whitespace();
  if (json[offset++] !== '}') throw new Error('Invalid media map JSON');
  whitespace();
  if (offset !== json.length) throw new Error('Invalid media map trailing data');
  return result;
}

function sniffMedia(data: Buffer, name: string): string | null {
  const extension = extname(name).toLowerCase();
  if (extension === '.png' && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (['.jpg', '.jpeg'].includes(extension) && data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (extension === '.webp' && data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (extension === '.wav' && data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (extension === '.ogg' && data.length >= 4 && data.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (extension === '.mp3' && ((data.length >= 10 && data.toString('ascii', 0, 3) === 'ID3') || (data.length >= 4 && data[0] === 255 && (data[1] & 0xe0) === 0xe0 && (data[1] & 6) !== 0))) return 'audio/mpeg';
  if (['.m4a', '.mp4'].includes(extension) && data.length >= 12 && data.toString('ascii', 4, 8) === 'ftyp' && ['M4A ', 'M4B ', 'isom', 'iso2', 'mp41', 'mp42', 'qt  '].includes(data.toString('ascii', 8, 12))) return 'audio/mp4';
  return null;
}

async function archiveEntries(zip: ZipFile): Promise<Map<string, Entry>> {
  if (zip.entryCount > IMPORT_LIMITS.entries) throw new Error('Archive entry limit exceeded');
  const entries = new Map<string, Entry>();
  let declared = 0;
  for await (const entry of zip.eachEntry()) {
    const name = entry.fileName.normalize('NFC');
    if (!name || name.length > 255 || /[\\/\x00-\x1f\x7f:]/.test(name) || name === '.' || name === '..') throw new Error('Invalid archive entry path');
    if (entries.has(name)) throw new Error('Duplicate archive entry');
    if (entry.isEncrypted() || (entry.generalPurposeBitFlag & 1)) throw new Error('Encrypted archive entries are unsupported');
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) throw new Error('Unsupported archive compression');
    const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
    if ((mode !== 0 && mode !== 0x8000) || (entry.externalFileAttributes & 0x10)) throw new Error('Unsupported archive symlink/directory entry');
    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0) throw new Error('Invalid archive size');
    declared += entry.uncompressedSize;
    if (declared > IMPORT_LIMITS.unpackedBytes) throw new Error('Archive unpacked size limit exceeded');
    if (!/^(?:collection\.anki2|collection\.anki21|collection\.anki21b|meta|media|[0-9]+)$/.test(name)) throw new Error('Unsupported package archive entry');
    entries.set(name, entry);
  }
  return entries;
}

async function entryBytes(zip: ZipFile, entry: Entry, limit: number, counter: {actual: number}): Promise<Buffer> {
  if (entry.uncompressedSize > limit) throw new Error('Archive entry size limit exceeded');
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let size = 0;
  let checksum = 0;
  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      size += chunk.length;
      counter.actual += chunk.length;
      if (size > limit || size > entry.uncompressedSize || counter.actual > IMPORT_LIMITS.unpackedBytes) throw new Error('Invalid archive actual size exceeds limit');
      checksum = crc32(chunk, checksum);
      chunks.push(chunk);
    }
  } finally { stream.destroy(); }
  if (size !== entry.uncompressedSize || checksum !== entry.crc32) throw new Error('Invalid archive entry size or CRC');
  return Buffer.concat(chunks, size);
}

function collectionData(path: string): Omit<ParsedPackage, 'media'> {
  const database = new DatabaseSync(path, {readOnly: true, enableForeignKeyConstraints: false, enableDoubleQuotedStringLiterals: false});
  try {
    database.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
    const objects = database.prepare('SELECT type, name, sql FROM sqlite_schema').all() as {type: string; name: string; sql: string | null}[];
    const tables = new Set(['col', 'notes', 'cards', 'revlog', 'graves', 'sqlite_stat1', 'sqlite_stat4']);
    for (const item of objects) {
      if (item.type === 'trigger' || item.type === 'view' || (item.sql && /\bCREATE\s+VIRTUAL\s+TABLE\b/i.test(item.sql))) throw new Error('Unsupported SQLite schema view, trigger or virtual table');
      if (item.type === 'table' && !tables.has(item.name)) throw new Error('Unsupported SQLite schema table');
    }
    const required: Record<string, string[]> = {
      col: ['id', 'crt', 'mod', 'scm', 'ver', 'dty', 'usn', 'ls', 'conf', 'models', 'decks', 'dconf', 'tags'],
      notes: ['id', 'guid', 'mid', 'mod', 'usn', 'tags', 'flds', 'sfld', 'csum', 'flags', 'data'],
      cards: ['id', 'nid', 'did', 'ord', 'mod', 'usn', 'type', 'queue', 'due', 'ivl', 'factor', 'reps', 'lapses', 'left', 'odue', 'odid', 'flags', 'data']
    };
    for (const [name, expected] of Object.entries(required)) {
      if (!objects.some(item => item.name === name && item.type === 'table')) throw new Error('Missing required SQLite schema table');
      const columns = database.prepare(`PRAGMA table_info(${name})`).all() as {name: string}[];
      if (columns.length !== expected.length || !expected.every(column => columns.some(value => value.name === column))) throw new Error('Unsupported SQLite table schema');
    }
    const counts = database.prepare('SELECT (SELECT count(*) FROM col) AS collections, (SELECT count(*) FROM notes) AS notes, (SELECT count(*) FROM cards) AS cards').get() as {collections: number; notes: number; cards: number};
    if (counts.collections !== 1 || counts.notes > IMPORT_LIMITS.notes || counts.cards > IMPORT_LIMITS.cards) throw new Error('Package collection/note/card limit exceeded');
    const metadataSize = database.prepare('SELECT ver, length(CAST(models AS BLOB)) + length(CAST(decks AS BLOB)) AS bytes FROM col').get() as {ver: number; bytes: number};
    if (metadataSize.ver !== 11) throw new Error(exportHelp);
    if (metadataSize.bytes > IMPORT_LIMITS.metadataBytes) throw new Error('Package metadata size limit exceeded');
    const metadata = database.prepare('SELECT models, decks FROM col').get() as {models: string; decks: string};
    const sourceDecks = object(JSON.parse(metadata.decks), 'Invalid deck metadata');
    const decks = Object.entries(sourceDecks).map(([id, value]) => {
      const deck = object(value, 'Invalid source deck metadata');
      if (deck.dyn !== undefined && deck.dyn !== 0 && deck.dyn !== 1 && deck.dyn !== false && deck.dyn !== true) throw new Error('Invalid source deck metadata');
      return {id: sourceId(id), name: sourceText(deck.name, 'Invalid source deck name'), filtered: Boolean(deck.dyn)};
    });
    const models = object(JSON.parse(metadata.models), 'Invalid note type metadata');
    const noteTypes = Object.entries(models).map(([id, value]) => {
      const model = object(value, 'Invalid note type metadata');
      if (!Array.isArray(model.flds) || model.flds.length === 0 || model.flds.length > 256 || !Number.isInteger(model.type) || (model.type !== 0 && model.type !== 1)) throw new Error('Invalid note type fields/schema');
      const fields = model.flds.map((value, index) => {
        const field = object(value, 'Invalid note type field');
        if (field.ord !== undefined && field.ord !== index) throw new Error('Unsupported note type field order');
        return sourceText(field.name, 'Invalid note type field name');
      });
      if (new Set(fields).size !== fields.length) throw new Error('Duplicate note type field names');
      return {id: sourceId(id), name: sourceText(model.name, 'Invalid note type name'), fields, type: model.type as number};
    });
    const textSize = database.prepare('SELECT coalesce(sum(length(CAST(flds AS BLOB))),0) AS bytes, coalesce(max(length(CAST(flds AS BLOB))),0) AS largest FROM notes').get() as {bytes: number; largest: number};
    if (textSize.bytes > IMPORT_LIMITS.parserOutputBytes - IMPORT_LIMITS.metadataBytes || textSize.largest > IMPORT_LIMITS.metadataBytes) throw new Error('Package source field/output size limit exceeded');
    const deckIds = new Set(decks.map(deck => deck.id));
    const modelsById = new Map(noteTypes.map(model => [model.id, model]));
    const sourceCards = database.prepare('SELECT CAST(nid AS TEXT) AS noteId, CAST(did AS TEXT) AS deckId FROM cards ORDER BY id').all() as {noteId: string; deckId: string}[];
    const membership = new Map<string, Set<string>>();
    for (const card of sourceCards) {
      if (!deckIds.has(card.deckId)) throw new Error('Invalid card source deck ID');
      const ids = membership.get(card.noteId) ?? new Set<string>();
      ids.add(card.deckId);
      membership.set(card.noteId, ids);
    }
    const sourceNotes = database.prepare('SELECT CAST(id AS TEXT) AS id, guid, CAST(mid AS TEXT) AS noteTypeId, mod AS modified, flds FROM notes ORDER BY id').all() as {id: string; guid: string; noteTypeId: string; modified: number; flds: string}[];
    const guids = new Set<string>();
    const notes = sourceNotes.map(note => {
      sourceId(note.id);
      const guid = sourceText(note.guid, 'Invalid note GUID');
      if (guid.length > 255 || guids.has(guid)) throw new Error('Duplicate or invalid note GUID');
      guids.add(guid);
      const model = modelsById.get(note.noteTypeId);
      if (!model || typeof note.flds !== 'string' || !Number.isSafeInteger(note.modified) || note.modified < 0) throw new Error('Invalid note field/model/revision');
      const fields = note.flds.split('\x1f');
      if (fields.length !== model.fields.length || fields.some(field => Buffer.byteLength(field, 'utf8') > IMPORT_LIMITS.fieldBytes)) throw new Error('Invalid note field count or field size limit');
      return {guid, id: note.id, noteTypeId: note.noteTypeId, deckIds: [...(membership.get(note.id) ?? [])], modified: note.modified, fields};
    });
    const noteIds = new Set(sourceNotes.map(note => note.id));
    if (sourceCards.some(card => !noteIds.has(card.noteId))) throw new Error('Invalid card source note ID');
    return {decks, noteTypes, notes};
  } finally { database.close(); }
}

export async function parsePackage(archivePath: string, stageDirectory: string): Promise<ParsedPackage> {
  const archive = await stat(archivePath);
  if (!archive.isFile() || archive.size > IMPORT_LIMITS.archiveBytes) throw new Error('Package archive size limit exceeded');
  const directory = await mkdtemp(join(stageDirectory, 'parsed-'));
  await chmod(directory, 0o700);
  let zip: ZipFile | undefined;
  try {
    zip = await openPromise(archivePath, {lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true});
    const entries = await archiveEntries(zip);
    const counter = {actual: 0};
    if (entries.has('collection.anki21b')) throw new Error(exportHelp);
    let collection: string | undefined;
    if (entries.has('meta')) {
      const meta = await entryBytes(zip, entries.get('meta')!, 32, counter);
      if (meta.equals(Buffer.from([8, 2]))) collection = 'collection.anki21';
      else if (meta.equals(Buffer.from([8, 1]))) collection = 'collection.anki2';
      else throw new Error(exportHelp);
    } else {
      const found = ['collection.anki2', 'collection.anki21'].filter(name => entries.has(name));
      if (found.length !== 1) throw new Error('Invalid ambiguous package collections. ' + exportHelp);
      collection = found[0];
    }
    if (!entries.has(collection)) throw new Error(exportHelp);
    if (collection === 'collection.anki2' && entries.has('collection.anki21')) throw new Error('Invalid ambiguous package collections');
    const mediaEntry = entries.get('media');
    if (!mediaEntry) throw new Error('Missing package media map');
    const mapping = mediaMap((await entryBytes(zip, mediaEntry, IMPORT_LIMITS.mediaMapBytes, counter)).toString('utf8'));
    for (const name of entries.keys()) if (/^[0-9]+$/.test(name) && !mapping.has(name)) throw new Error('Archive media entry missing from media map');
    for (const key of mapping.keys()) if (!entries.has(key)) throw new Error('Media map references missing archive entry');
    const databasePath = join(directory, 'collection.sqlite');
    const databaseBytes = await entryBytes(zip, entries.get(collection)!, IMPORT_LIMITS.databaseBytes, counter);
    if (!databaseBytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) throw new Error('Invalid package SQLite database');
    await writeFile(databasePath, databaseBytes, {mode: 0o600, flag: 'wx'});
    const content = collectionData(databasePath);
    const otherCollection = collection === 'collection.anki21' ? entries.get('collection.anki2') : undefined;
    if (otherCollection) await entryBytes(zip, otherCollection, IMPORT_LIMITS.databaseBytes, counter);
    const media: ParsedPackage['media'] = [];
    for (const [entryId, name] of mapping) {
      const entry = entries.get(entryId)!;
      const base = {entryId, name, path: null, mime: null, size: entry.uncompressedSize, sha256: null};
      const oversized = entry.uncompressedSize > IMPORT_LIMITS.mediaBytes;
      const image = ['.png', '.jpg', '.jpeg', '.webp'].includes(extname(name).toLowerCase());
      if (oversized && (!image || entry.uncompressedSize > IMPORT_LIMITS.imageSourceBytes)) {
        media.push({...base, error: 'Media exceeds the 512KiB size limit; replace it or explicitly skip it.'});
        continue;
      }
      let bytes = await entryBytes(zip, entry, oversized ? IMPORT_LIMITS.imageSourceBytes : IMPORT_LIMITS.mediaBytes, counter);
      let mime = sniffMedia(bytes, name);
      if (!mime) { media.push({...base, error: 'Unsupported media type or invalid file signature'}); continue; }
      if (oversized) {
        try {
          bytes = await optimizeImage(bytes);
          mime = 'image/webp';
        } catch {
          media.push({...base, error: 'Image could not be optimized within the 512KiB size and 16-million-pixel limits; replace it or explicitly skip it.'});
          continue;
        }
      }
      const path = join(directory, `media-${entryId}`);
      await writeFile(path, bytes, {mode: 0o600, flag: 'wx'});
      media.push({entryId, name, path, mime, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...(oversized ? {optimized: true, originalSize: entry.uncompressedSize} : {})});
    }
    const result: ParsedPackage = {...content, media,
      notes: content.notes.map(note => ({...note, mediaFields: profileMediaFields(note.fields)}))};
    result.suggestion = suggestImport(result);
    Object.assign(result, importSourceChoices(result));
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > IMPORT_LIMITS.parserOutputBytes) throw new Error('Package parser output size limit exceeded');
    return result;
  } catch (error) {
    await rm(directory, {recursive: true, force: true});
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Invalid Anki package/archive: ${message}`, {cause: error});
  } finally { zip?.close(); }
}
