import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {deflateRawSync} from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer | string;
  method?: 0 | 8;
  externalAttributes?: number;
  crcOverride?: number;
  declaredSize?: number;
  flags?: number;
}

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const value of data) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function writeZip(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const bytes = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const method = entry.method ?? 0;
    const packed = method === 8 ? deflateRawSync(bytes) : bytes;
    const crc = entry.crcOverride ?? crc32(bytes);
    const size = entry.declaredSize ?? bytes.length;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.flags ?? 0x800, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, packed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE((3 << 8) | 20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(entry.flags ?? 0x800, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(packed.length, 20);
    directory.writeUInt32LE(size, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(entry.externalAttributes ?? ((0o100600 << 16) >>> 0), 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export interface SourceNote {
  id?: bigint | number;
  guid: string;
  modified?: number;
  modelId?: string;
  fields: string[];
  deckIds?: string[];
}

export interface PackageOptions {
  notes?: SourceNote[];
  media?: Record<string, Buffer>;
  method?: 0 | 8;
  collectionName?: string;
  extraEntries?: ZipEntry[];
  mediaMap?: string;
  mutate?: (database: DatabaseSync) => void;
  noteTypes?: Record<string, unknown>;
  decks?: Record<string, unknown>;
}

export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPa8AAAAASUVORK5CYII=', 'base64');
export function wav(): Buffer {
  const buffer = Buffer.alloc(44 + 16000);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(16000, 40);
  return buffer;
}

export async function makePackage(directory: string, options: PackageOptions = {}) {
  const databasePath = join(directory, 'collection-source.sqlite');
  const database = new DatabaseSync(databasePath);
  const notes: SourceNote[] = options.notes ?? Array.from({length: 4}, (_, index) => ({
    guid: `note-guid-${index + 1}`, fields: [`λέξη ${index + 1}`, `meaning ${index + 1}`, '[sound:voice.wav]'],
  }));
  const noteTypes = options.noteTypes ?? {'100': {id: 100, name: 'Vocabulary', type: 0,
    flds: ['Term', 'Meaning', 'Audio'].map((name, ord) => ({name, ord})),
    tmpls: [{name: 'Card 1', ord: 0, qfmt: '{{Term}}', afmt: '{{Meaning}}'}], css: ''}};
  const decks = options.decks ?? {'1': {id: 1, name: 'Root', dyn: 0}, '2': {id: 2, name: 'Root::Child', dyn: 0}, '3': {id: 3, name: 'Other', dyn: 0}};
  try {
    database.exec(`
      CREATE TABLE col(id INTEGER PRIMARY KEY,crt INTEGER,mod INTEGER,scm INTEGER,ver INTEGER,dty INTEGER,usn INTEGER,ls INTEGER,conf TEXT,models TEXT,decks TEXT,dconf TEXT,tags TEXT);
      CREATE TABLE notes(id INTEGER PRIMARY KEY,guid TEXT,mid INTEGER,mod INTEGER,usn INTEGER,tags TEXT,flds TEXT,sfld INTEGER,csum INTEGER,flags INTEGER,data TEXT);
      CREATE TABLE cards(id INTEGER PRIMARY KEY,nid INTEGER,did INTEGER,ord INTEGER,mod INTEGER,usn INTEGER,type INTEGER,queue INTEGER,due INTEGER,ivl INTEGER,factor INTEGER,reps INTEGER,lapses INTEGER,left INTEGER,odue INTEGER,odid INTEGER,flags INTEGER,data TEXT);
    `);
    database.prepare('INSERT INTO col VALUES (1,0,0,0,11,0,0,0,?,?,?,?,?)').run('{}', JSON.stringify(noteTypes), JSON.stringify(decks), '{}', '{}');
    const insertNote = database.prepare('INSERT INTO notes VALUES (?,?,?,?,0,?,?,0,0,0,?)');
    insertNote.setReadBigInts(true);
    notes.forEach((note, index) => {
      const id = note.id ?? index + 1;
      insertNote.run(id, note.guid, BigInt(note.modelId ?? '100'), note.modified ?? 100, '', note.fields.join('\x1f'), '');
      for (const [cardIndex, deckId] of (note.deckIds ?? ['1']).entries()) {
        database.prepare('INSERT INTO cards VALUES (?,?,?,?,0,0,0,0,0,0,0,0,0,0,0,0,0,?)').run((index + 1) * 10 + cardIndex, id, BigInt(deckId), cardIndex, '');
      }
    });
    options.mutate?.(database);
  } finally { database.close(); }
  const entries: ZipEntry[] = [{name: options.collectionName ?? 'collection.anki2', data: await readFile(databasePath), method: options.method}];
  const map: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(options.media ?? {})) {
    const entryId = String(Object.keys(map).length);
    map[entryId] = name;
    entries.push({name: entryId, data: bytes, method: options.method});
  }
  entries.push({name: 'media', data: options.mediaMap ?? JSON.stringify(map), method: options.method});
  entries.push(...(options.extraEntries ?? []));
  const bytes = writeZip(entries);
  const archivePath = join(directory, 'synthetic.apkg');
  await writeFile(archivePath, bytes);
  return {archivePath, bytes, entries, notes};
}
