import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import sharp from 'sharp';
import {parsePackage} from '../server/import-package';
import {createApplication} from '../server/app';
import {crc32, makePackage, png, wav, type PackageOptions, type SourceNote} from './helpers/anki-package';

const origin = 'http://127.0.0.1:4173';
const demo = {uiLanguage: 'en', decks: [{id: 'demo', title: 'Demo', termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr',
  words: Array.from({length: 4}, (_, index) => ({id: String(index), term: `demo ${index}`, meaning: `example ${index}`, image: null, audio: null}))}]};
const notes: SourceNote[] = Array.from({length: 4}, (_, index) => ({guid: `greek-${index + 1}`, deckIds: ['2'], fields: [
  `λέξη ${index + 1}`, `<div>meaning ${index + 1}</div><img src="book.png">`, 'written pronunciation', index < 3 ? '[sound:voice.wav]' : '',
]}));
const noteTypes = {'100': {id: 100, name: 'Greek Vocabulary', type: 0,
  flds: ['Greek', 'Meaning', 'Pronunciation', 'Audio'].map((name, ord) => ({name, ord})),
  tmpls: [{name: 'Card 1', ord: 0, qfmt: '{{Greek}}', afmt: '{{Meaning}}'}], css: ''}};
const decks = {'1': {id: 1, name: 'Default', dyn: 0}, '2': {id: 2, name: 'Greek', dyn: 0}};

async function temp(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-media-followup-'));
  await mkdir(join(directory, 'packages'));
  await mkdir(join(directory, 'parser-stage'));
  try { await run(directory); } finally { await rm(directory, {recursive: true, force: true}); }
}

async function fixture(directory: string) {
  const databasePath = join(directory, 'app.sqlite');
  const application = createApplication({databasePath, content: demo, origin, registration: 'open'});
  await new Promise<void>((resolve, reject) => {
    application.server.once('error', reject);
    application.server.listen(0, '127.0.0.1', resolve);
  });
  const address = application.server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let packageIndex = 0;
  async function request(path: string, cookie?: string, body?: unknown, bytes?: Buffer) {
    const response = await fetch(base + path, {method: body !== undefined || bytes ? 'POST' : 'GET', headers: {
      Origin: origin, ...(cookie ? {Cookie: cookie} : {}), ...(body !== undefined ? {'Content-Type': 'application/json'} : {}),
      ...(bytes ? {'Content-Type': 'application/octet-stream', 'X-Import-Request-Id': randomUUID(), 'X-Import-Filename': 'greek.apkg'} : {}),
    }, body: bytes ? new Uint8Array(bytes) : body === undefined ? undefined : JSON.stringify(body)});
    const data = Buffer.from(await response.arrayBuffer());
    let result: any;
    try { result = JSON.parse(data.toString()); } catch { result = data.toString(); }
    return {response, data: result, bytes: data};
  }
  async function register(email = 'first@example.com') {
    const {response, data} = await request('/api/auth/register', undefined, {email, password: 'private test password'});
    assert(response.ok, JSON.stringify(data));
    return {cookie: response.headers.get('set-cookie')!.split(';')[0], user: data.user};
  }
  async function packageBytes(options: PackageOptions = {}) {
    const path = join(directory, 'packages', String(packageIndex++));
    await mkdir(path);
    return (await makePackage(path, {notes, decks, noteTypes, media: {'book.png': png, 'voice.wav': wav()}, ...options})).bytes;
  }
  async function upload(cookie: string, bytes: Buffer) {
    const {response, data} = await request('/api/imports/uploads', cookie, undefined, bytes);
    assert(response.ok, JSON.stringify(data));
    return data;
  }
  async function preview(cookie: string, stage: any, extra: Record<string, unknown> = {}) {
    const body = {sourceDeckId: '2', noteTypeId: '100', includeChildren: false, mapping: {term: 'Greek', meaning: 'Meaning', image: 'Meaning', audio: 'Audio'}, title: 'Greek', termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr', ...extra};
    const {response, data} = await request(`/api/imports/${stage.uploadId}/preview`, cookie, body);
    assert(response.ok, JSON.stringify(data));
    return data;
  }
  return {application, databasePath, request, register, packageBytes, upload, preview};
}

test('real-shaped field defaults choose the populated Greek deck and bundled Audio field', async () => temp(async directory => {
  const app = await fixture(directory);
  try {
    const {cookie} = await app.register();
    const stage = await app.upload(cookie, await app.packageBytes());
    assert.deepEqual(stage.suggestion, {sourceDeckId: '2', noteTypeId: '100', includeChildren: true,
      mapping: {term: 'Greek', meaning: 'Meaning', image: 'Meaning', audio: 'Audio'}, title: 'Greek'});
    const preview = await app.preview(cookie, stage, {mapping: stage.suggestion.mapping});
    assert.equal(preview.report.added, 4);
    assert.deepEqual(preview.report.media, {total: 4, images: 4, audio: 3, resizedImages: 0, withoutImage: 0, withoutAudio: 1,
      unselectedImages: 0, unselectedAudio: 0, missingFiles: 0, unsupportedFiles: 0, oversizedFiles: 0});
  } finally { await app.application.close(); }
}));

test('media-only repair fills absent audio without changing words, identities or an existing image', async () => temp(async directory => {
  const app = await fixture(directory);
  try {
    const {cookie} = await app.register();
    const oldBytes = await app.packageBytes({notes: notes.map(note => ({...note, modified: 100}))});
    const stage = await app.upload(cookie, oldBytes);
    const first = await app.preview(cookie, stage, {mapping: {term: 'Greek', meaning: 'Meaning', image: 'Meaning', audio: 'Pronunciation'}});
    const commit = await app.request(`/api/imports/${stage.uploadId}/commit`, cookie, {previewId: first.previewId, requestId: randomUUID(), acceptSkipped: true});
    assert(commit.response.ok, JSON.stringify(commit.data));
    const before = (await app.request(`/api/decks/${commit.data.deckId}`, cookie)).data.deck;
    const training = await app.request('/api/training?format=compact', cookie, {deckId: commit.data.deckId, requestId: randomUUID()});
    assert(training.response.ok, JSON.stringify(training.data));
    const attempt = training.data.attempt;
    const snapshotBefore = (await app.request(`/api/training/${attempt.id}/snapshot`, cookie)).data.snapshot;
    const question = snapshotBefore.questions[0];
    const answer = await app.request(`/api/training/${attempt.id}/answer?format=compact`, cookie, {
      requestId: randomUUID(), revision: attempt.revision, position: attempt.position, optionId: question.optionIds[0],
    });
    assert(answer.response.ok, JSON.stringify(answer.data));
    const changedImage = await sharp({create: {width: 2, height: 2, channels: 3, background: {r: 200, g: 20, b: 30}}}).png().toBuffer();
    const newerNotes = notes.map(note => ({...note, modified: 200, fields: [note.fields[0], String(note.fields[1]).replace('book.png', 'new-book.png'), ...note.fields.slice(2)]}));
    const repairBytes = await app.packageBytes({notes: newerNotes, media: {'new-book.png': changedImage, 'voice.wav': wav()}});
    const repairStage = await app.upload(cookie, repairBytes);
    const repair = await app.preview(cookie, repairStage, {sourceDeckId: '2', noteTypeId: '100', mapping: {term: 'Greek', meaning: 'Meaning', image: 'Meaning', audio: 'Audio'},
      title: before.title, termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr', destinationDeckId: commit.data.deckId, repairMedia: true});
    assert.equal(repair.report.added, 0);
    assert.equal(repair.report.media.audio, 3);
    assert.equal(repair.report.media.withoutAudio, 1);
    const repaired = await app.request(`/api/imports/${repairStage.uploadId}/commit`, cookie, {previewId: repair.previewId, requestId: randomUUID(), acceptSkipped: true});
    assert(repaired.response.ok, JSON.stringify(repaired.data));
    assert.equal(repaired.data.deckId, commit.data.deckId);
    const after = (await app.request(`/api/decks/${commit.data.deckId}`, cookie)).data.deck;
    assert.deepEqual(after.words.map((word: any) => word.id), before.words.map((word: any) => word.id));
    assert.deepEqual(after.words.map((word: any) => [word.term, word.meaning]), before.words.map((word: any) => [word.term, word.meaning]));
    assert(after.words.every((word: any) => word.image));
    assert.equal(after.words.filter((word: any) => word.audio).length, 3);
    const image = await app.request(after.words[0].image, cookie);
    assert(image.response.ok);
    const imageBefore = await app.request(before.words[0].image, cookie);
    assert.deepEqual(image.bytes, imageBefore.bytes);
    const snapshotAfter = (await app.request(`/api/training/${attempt.id}/snapshot`, cookie)).data.snapshot;
    assert.deepEqual(snapshotAfter, snapshotBefore);
    const history = (await app.request(`/api/training/${attempt.id}/answers`, cookie)).data.answers;
    assert.equal(history.length, 1);
    assert.equal(history[0].position, 0);
    const database = new DatabaseSync(app.databasePath, {readOnly: true});
    try {
      const saved = database.prepare('SELECT source_modified, content_hash FROM imported_words WHERE deck_id = ? ORDER BY sort_order').all(commit.data.deckId) as {source_modified: number}[];
      assert(saved.every(word => word.source_modified === 100));
      const source = database.prepare('SELECT source_json FROM imported_decks WHERE id = ?').get(commit.data.deckId) as {source_json: string};
      assert.equal(JSON.parse(source.source_json).mapping.audio, 'Audio');
    } finally { database.close(); }
    const replayStage = await app.upload(cookie, repairBytes);
    const repeated = await app.preview(cookie, replayStage, {sourceDeckId: '2', noteTypeId: '100', mapping: {term: 'Greek', meaning: 'Meaning', image: 'Meaning', audio: 'Audio'},
      title: before.title, termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr', destinationDeckId: commit.data.deckId, repairMedia: true});
    assert.equal(repeated.report.updated, 0);
    assert.equal(repeated.report.conflicting, 0);
    assert.equal(repeated.report.unchanged, 4);
    assert.equal(repeated.report.retained, 0);
    const strictReimport = await app.preview(cookie, replayStage, {sourceDeckId: '2', noteTypeId: '100', mapping: {term: 'Greek', meaning: 'Meaning', image: 'Meaning', audio: 'Audio'},
      title: before.title, termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr', destinationDeckId: commit.data.deckId});
    assert.equal(strictReimport.report.updated, 4);
  } finally { await app.application.close(); }
}));

test('media coverage counts retained words omitted by the selected export', async () => temp(async directory => {
  const app = await fixture(directory);
  try {
    const {cookie} = await app.register();
    const firstStage = await app.upload(cookie, await app.packageBytes());
    const firstPreview = await app.preview(cookie, firstStage, {mapping: firstStage.suggestion.mapping});
    const committed = await app.request(`/api/imports/${firstStage.uploadId}/commit`, cookie, {previewId: firstPreview.previewId, requestId: randomUUID(), acceptSkipped: true});
    assert(committed.response.ok, JSON.stringify(committed.data));
    const partialStage = await app.upload(cookie, await app.packageBytes({notes: notes.slice(0, 2)}));
    const partialPreview = await app.preview(cookie, partialStage, {mapping: partialStage.suggestion.mapping, destinationDeckId: committed.data.deckId});
    assert.equal(partialPreview.report.retained, 2);
    assert.deepEqual(partialPreview.report.media, {total: 4, images: 4, audio: 3, resizedImages: 0, withoutImage: 0, withoutAudio: 1,
      unselectedImages: 0, unselectedAudio: 0, missingFiles: 0, unsupportedFiles: 0, oversizedFiles: 0});
  } finally { await app.application.close(); }
}));

test('media repair leaves changed text and older note versions untouched', async () => temp(async directory => {
  const app = await fixture(directory);
  try {
    const {cookie} = await app.register();
    const initial = await app.upload(cookie, await app.packageBytes({notes: notes.map(note => ({...note, modified: 100}))}));
    const initialPreview = await app.preview(cookie, initial, {mapping: {term: 'Greek', meaning: 'Meaning', image: 'Meaning', audio: 'Pronunciation'}});
    const committed = await app.request(`/api/imports/${initial.uploadId}/commit`, cookie, {previewId: initialPreview.previewId, requestId: randomUUID(), acceptSkipped: true});
    assert(committed.response.ok, JSON.stringify(committed.data));
    const before = (await app.request(`/api/decks/${committed.data.deckId}`, cookie)).data.deck;
    const changedImage = await sharp({create: {width: 2, height: 2, channels: 3, background: {r: 12, g: 90, b: 180}}}).png().toBuffer();
    const repairNotes = notes.map((note, index) => {
      const meaning = String(note.fields[1]).replace('book.png', 'new-book.png');
      return {...note, modified: index === 1 ? 50 : 200,
        fields: [note.fields[0], index === 0 ? meaning.replace('meaning 1', 'changed meaning') : meaning, ...note.fields.slice(2)]};
    });
    const stage = await app.upload(cookie, await app.packageBytes({notes: repairNotes, media: {'new-book.png': changedImage, 'voice.wav': wav()}}));
    const preview = await app.preview(cookie, stage, {sourceDeckId: '2', noteTypeId: '100', mapping: {term: 'Greek', meaning: 'Meaning', image: 'Meaning', audio: 'Audio'},
      title: before.title, termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr', destinationDeckId: committed.data.deckId, repairMedia: true});
    assert.equal(preview.report.skipped, 2);
    assert.equal(preview.report.older, 1);
    assert.equal(preview.report.media.audio, 1);
    const repaired = await app.request(`/api/imports/${stage.uploadId}/commit`, cookie, {previewId: preview.previewId, requestId: randomUUID(), acceptSkipped: true});
    assert(repaired.response.ok, JSON.stringify(repaired.data));
    const after = (await app.request(`/api/decks/${committed.data.deckId}`, cookie)).data.deck;
    assert.deepEqual(after.words.map((word: any) => [word.id, word.term, word.meaning, word.image]), before.words.map((word: any) => [word.id, word.term, word.meaning, word.image]));
    assert.equal(after.words.filter((word: any) => word.audio).length, 1);
    const database = new DatabaseSync(app.databasePath, {readOnly: true});
    try {
      const rows = database.prepare('SELECT source_modified FROM imported_words WHERE deck_id = ?').all(committed.data.deckId) as {source_modified: number}[];
      assert(rows.every(word => word.source_modified === 100));
    } finally { database.close(); }
  } finally { await app.application.close(); }
}));

test('content suggestions handle many notes and very long nested source deck names promptly', async () => temp(async directory => {
  const app = await fixture(directory);
  try {
    const {cookie} = await app.register();
    const name = `${'nested::'.repeat(750)}Greek`;
    const longDecks = {'1': {id: 1, name: 'Default', dyn: 0}, '2': {id: 2, name, dyn: 0}};
    const manyNotes = Array.from({length: 100}, (_, index) => ({...notes[index % notes.length], id: index + 1, guid: `many-${index}`, deckIds: ['2']}));
    const bytes = await app.packageBytes({decks: longDecks, notes: manyNotes});
    const started = performance.now();
    const stage = await app.upload(cookie, bytes);
    assert(performance.now() - started < 3000, '100-note suggestion should not block the import request');
    assert.equal(stage.suggestion.sourceDeckId, '2');
    assert.equal(stage.suggestion.noteTypeId, '100');
    assert(stage.suggestion.title.length <= 120);
  } finally { await app.application.close(); }
}));

test('repair rejects a different account destination and commit rejects a stale preview', async () => temp(async directory => {
  const app = await fixture(directory);
  try {
    const first = await app.register('owner@example.com');
    const bytes = await app.packageBytes();
    const initial = await app.upload(first.cookie, bytes);
    const initialPreview = await app.preview(first.cookie, initial, {mapping: {...initial.suggestion.mapping, audio: 'Pronunciation'}});
    const imported = await app.request(`/api/imports/${initial.uploadId}/commit`, first.cookie, {previewId: initialPreview.previewId, requestId: randomUUID(), acceptSkipped: true});
    assert(imported.response.ok, JSON.stringify(imported.data));
    const second = await app.register('other@example.com');
    const foreignStage = await app.upload(second.cookie, bytes);
    const foreign = await app.request(`/api/imports/${foreignStage.uploadId}/preview`, second.cookie, {
      sourceDeckId: '2', noteTypeId: '100', includeChildren: false, mapping: initial.suggestion.mapping, title: 'Greek', termLang: 'el', meaningLang: 'en',
      termDir: 'ltr', meaningDir: 'ltr', destinationDeckId: imported.data.deckId, repairMedia: true,
    });
    assert.equal(foreign.response.status, 404);
    const one = await app.upload(first.cookie, bytes);
    const map = {term: 'Greek', meaning: 'Meaning', image: 'Meaning', audio: 'Audio'};
    const previewOne = await app.preview(first.cookie, one, {sourceDeckId: '2', noteTypeId: '100', mapping: map, destinationDeckId: imported.data.deckId,
      title: 'Greek', termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr', repairMedia: true});
    const database = new DatabaseSync(app.databasePath);
    database.prepare('UPDATE imported_decks SET revision = revision + 1 WHERE id = ?').run(imported.data.deckId);
    database.close();
    const stale = await app.request(`/api/imports/${one.uploadId}/commit`, first.cookie, {previewId: previewOne.previewId, requestId: randomUUID(), acceptSkipped: true});
    assert.equal(stale.response.status, 409);
    assert.equal(stale.data.error.code, 'stale_preview');
  } finally { await app.application.close(); }
}));

test('oversized bundled pictures are optimized under the stored cap while large audio remains skipped', async () => temp(async directory => {
  const largeImage = await sharp({create: {width: 1600, height: 1200, channels: 3, background: {r: 40, g: 110, b: 210}}}).png({compressionLevel: 0}).toBuffer();
  assert(largeImage.length > 512 * 1024);
  const largeAudio = Buffer.alloc(600 * 1024);
  largeAudio.write('RIFF', 0); largeAudio.writeUInt32LE(largeAudio.length - 8, 4); largeAudio.write('WAVE', 8);
  largeAudio.write('fmt ', 12); largeAudio.writeUInt32LE(16, 16); largeAudio.writeUInt16LE(1, 20); largeAudio.writeUInt16LE(1, 22);
  largeAudio.writeUInt32LE(8000, 24); largeAudio.writeUInt32LE(16000, 28); largeAudio.writeUInt16LE(2, 32); largeAudio.writeUInt16LE(16, 34);
  largeAudio.write('data', 36); largeAudio.writeUInt32LE(largeAudio.length - 44, 40);
  const packageDirectory = join(directory, 'packages', 'parser');
  await mkdir(packageDirectory);
  const sourcePackage = await makePackage(packageDirectory, {notes, decks, noteTypes,
    media: {'book.png': largeImage, 'voice.wav': largeAudio}});
  const originalHash = createHash('sha256').update(sourcePackage.bytes).digest('hex');
  const result = await parsePackage(sourcePackage.archivePath, join(directory, 'parser-stage'));
  const image = result.media.find(item => item.name === 'book.png')! as typeof result.media[number] & {optimized?: boolean; originalSize?: number};
  assert.equal(image.optimized, true);
  assert.equal(image.originalSize, largeImage.length);
  assert(image.path && image.size <= 512 * 1024);
  assert.equal(image.mime, 'image/webp');
  const metadata = await sharp(await readFile(image.path!)).metadata();
  assert((metadata.width || 0) <= 1024 && (metadata.height || 0) <= 1024);
  const audio = result.media.find(item => item.name === 'voice.wav')!;
  assert(audio.error);
  assert.equal(audio.path, null);
  assert.equal(createHash('sha256').update(await readFile(sourcePackage.archivePath)).digest('hex'), originalHash);
}));

test('invalid, over-pixel-limit and over-8MiB source images are reported without retained files', async () => temp(async directory => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const corrupt = Buffer.alloc(600 * 1024);
  signature.copy(corrupt);
  const tooLarge = Buffer.alloc(8 * 1024 * 1024 + 1);
  signature.copy(tooLarge);
  const largeCanvas = await sharp({create: {width: 5000, height: 4000, channels: 3, background: {r: 80, g: 100, b: 120}}}).png().toBuffer();
  const text = Buffer.alloc(600 * 1024, 120);
  Buffer.from('Description\0').copy(text);
  const type = Buffer.from('tEXt');
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32BE(text.length, 0);
  type.copy(chunkHeader, 4);
  const crcInput = Buffer.concat([type, text]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  const ihdrEnd = 8 + 12 + largeCanvas.readUInt32BE(8);
  const pixelBomb = Buffer.concat([largeCanvas.subarray(0, ihdrEnd), chunkHeader, text, crc, largeCanvas.subarray(ihdrEnd)]);
  assert(pixelBomb.length > 512 * 1024);
  const packageDirectory = join(directory, 'packages', 'unsafe');
  await mkdir(packageDirectory);
  const source = await makePackage(packageDirectory, {notes, decks, noteTypes,
    media: {'corrupt.png': corrupt, 'pixel-bomb.png': pixelBomb, 'over-8mib.png': tooLarge}});
  const digest = createHash('sha256').update(source.bytes).digest('hex');
  const result = await parsePackage(source.archivePath, join(directory, 'parser-stage'));
  for (const name of ['corrupt.png', 'pixel-bomb.png', 'over-8mib.png']) {
    const media = result.media.find(item => item.name === name)!;
    assert(media.error, `${name} should be rejected from retained media`);
    assert.equal(media.path, null);
    assert.equal(media.sha256, null);
  }
  assert.match(result.media.find(item => item.name === 'pixel-bomb.png')!.error!, /16-million-pixel/i);
  assert.equal(createHash('sha256').update(await readFile(source.archivePath)).digest('hex'), digest);
}));
