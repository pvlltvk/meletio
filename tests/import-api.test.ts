import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {request as httpRequest} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {createApplication} from '../server/app';
import {makePackage, png, wav, type PackageOptions, type SourceNote} from './helpers/anki-package';

const origin = 'http://127.0.0.1:4173';
const demo = {uiLanguage: 'en', decks: [{id: 'demo', title: 'Demo', termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr',
  words: Array.from({length: 4}, (_, index) => ({id: String(index), term: `demo ${index}`, meaning: `example ${index}`, image: null, audio: null}))}]};
const mapping = {sourceDeckId: '1', noteTypeId: '100', includeChildren: false,
  mapping: {term: 'Term', meaning: 'Meaning', image: 'Meaning', audio: 'Audio'},
  title: 'Private vocabulary', termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr'};
const sourceNotes = (modified = 100): SourceNote[] => Array.from({length: 4}, (_, index) => ({
  guid: `note-guid-${index + 1}`, modified,
  fields: [`λέξη ${index + 1}`, `<div>meaning &amp; ${index + 1}</div><img src="book.png">`, '[sound:voice.wav]'],
}));

type Result = {response: Response; body: any; bytes: Buffer};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-import-api-'));
  const databasePath = join(directory, 'app.sqlite');
  let now = Date.now();
  let application: ReturnType<typeof createApplication>;
  let base = '';
  async function open() {
    application = createApplication({databasePath, content: demo, origin, now: () => now});
    await new Promise<void>((resolve, reject) => {
      application.server.once('error', reject);
      application.server.listen(0, '127.0.0.1', resolve);
    });
    const address = application.server.address();
    assert(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
  }
  await open();
  async function request(path: string, options: {cookie?: string; body?: unknown; bytes?: Buffer; headers?: Record<string, string>; method?: string} = {}): Promise<Result> {
    const method = options.method ?? (options.body !== undefined || options.bytes !== undefined ? 'POST' : 'GET');
    const headers: Record<string, string> = {Origin: origin};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.bytes !== undefined) headers['Content-Type'] = 'application/octet-stream';
    if (options.cookie) headers.Cookie = options.cookie;
    Object.assign(headers, options.headers);
    const response = await fetch(base + path, {method, headers,
      body: options.bytes ? new Uint8Array(options.bytes) : options.body === undefined ? undefined : JSON.stringify(options.body)});
    const bytes = Buffer.from(await response.arrayBuffer());
    let body: any;
    try { body = JSON.parse(bytes.toString()); } catch { body = bytes.toString(); }
    return {response, body, bytes};
  }
  async function register(email = 'importer@example.com') {
    const result = await request('/api/auth/register', {body: {email, password: 'a private import password'}});
    assert(result.response.ok, JSON.stringify(result.body));
    return {cookie: result.response.headers.get('set-cookie')!.split(';')[0], user: result.body.user};
  }
  async function packageBytes(options: PackageOptions = {}) {
    const source = await mkdtemp(join(directory, 'source-'));
    return (await makePackage(source, {notes: sourceNotes(), media: {'book.png': png, 'voice.wav': wav()}, ...options})).bytes;
  }
  async function upload(cookie: string, bytes: Buffer, requestId = randomUUID()) {
    const result = await request('/api/imports/uploads', {cookie, bytes,
      headers: {'X-Import-Request-Id': requestId, 'X-Import-Filename': 'vocabulary.apkg'}});
    assert(result.response.ok, JSON.stringify(result.body));
    assert.equal(typeof result.body.uploadId, 'string');
    return {...result.body, requestId};
  }
  async function preview(cookie: string, uploadId: string, extra: Record<string, unknown> = {}) {
    const result = await request(`/api/imports/${uploadId}/preview`, {cookie, body: {...mapping, ...extra}});
    assert(result.response.ok, JSON.stringify(result.body));
    assert.equal(typeof result.body.previewId, 'string');
    return result.body;
  }
  async function commit(cookie: string, uploadId: string, previewId: string, requestId = randomUUID(), acceptSkipped = false) {
    const result = await request(`/api/imports/${uploadId}/commit`, {cookie, body: {previewId, requestId, acceptSkipped}});
    assert(result.response.ok, JSON.stringify(result.body));
    return {...result.body, requestId};
  }
  return {directory, databasePath, request, register, packageBytes, upload, preview, commit,
    get baseUrl() { return base; },
    elapse(milliseconds: number) { now += milliseconds; },
    async restart() { await application.close(); await open(); },
    async close() { await application.close(); await rm(directory, {recursive: true, force: true}); }};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function using(run: (fixture: Fixture) => Promise<void>) {
  const app = await fixture();
  try { await run(app); } finally { await app.close(); }
}
function status(result: Result, expected: number) {
  assert.equal(result.response.status, expected, JSON.stringify(result.body));
  assert.equal(typeof result.body.error?.code, 'string');
}

// This first case is intentionally a complete public API contract, independent of import internals.
test('private upload and preview create no visible deck until explicit atomic commit', async () => using(async app => {
  const {cookie} = await app.register();
  const bytes = await app.packageBytes();
  const stage = await app.upload(cookie, bytes);
  assert(stage.decks.some((deck: any) => deck.id === '1'));
  assert(stage.noteTypes.some((model: any) => model.fields.includes('Term')));
  assert(stage.limits);
  const before = await app.request('/api/decks', {cookie});
  assert.equal(before.body.decks.length, 1);
  const preview = await app.preview(cookie, stage.uploadId);
  assert.equal(preview.report.added, 4);
  assert.equal(preview.practiceAvailable, true);
  assert(preview.samples.length > 0 && preview.samples.length <= 10);
  assert((await app.request('/api/decks', {cookie})).body.decks.length === 1);
  const committed = await app.commit(cookie, stage.uploadId, preview.previewId);
  assert.equal(typeof committed.deckId, 'string');
  assert.equal(committed.revision, 1);
  const catalog = await app.request('/api/decks', {cookie});
  assert(catalog.body.decks.some((deck: any) => deck.id === committed.deckId));
  const detail = await app.request(`/api/decks/${committed.deckId}`, {cookie});
  assert.equal(detail.body.deck.words.length, 4);
  assert.equal(detail.body.deck.words[0].meaning, 'meaning & 1');
  assert.match(detail.body.deck.words[0].image, /^\/api\/media\//);
  assert.match(detail.body.deck.words[0].audio, /^\/api\/media\//);
  await app.restart();
  const restored = await app.request(`/api/decks/${committed.deckId}`, {cookie});
  assert.deepEqual(restored.body.deck, detail.body.deck);
}));

test('upload IDs recover through client request IDs and replay cannot change archive bytes', async () => using(async app => {
  const {cookie} = await app.register();
  const bytes = await app.packageBytes();
  const requestId = randomUUID();
  const uploaded = await app.upload(cookie, bytes, requestId);
  const lookup = await app.request(`/api/imports/current?requestId=${requestId}`, {cookie});
  assert.equal(lookup.body.uploadId, uploaded.uploadId);
  const replay = await app.upload(cookie, bytes, requestId);
  assert.equal(replay.uploadId, uploaded.uploadId);
  const different = await app.packageBytes({notes: sourceNotes(200)});
  status(await app.request('/api/imports/uploads', {cookie, bytes: different,
    headers: {'X-Import-Request-Id': requestId, 'X-Import-Filename': 'changed.apkg'}}), 409);
}));

test('staged and committed decks and media are private across every owner-checked endpoint', async () => using(async app => {
  const first = await app.register();
  const second = await app.register('other@example.com');
  const stage = await app.upload(first.cookie, await app.packageBytes());
  const preview = await app.preview(first.cookie, stage.uploadId);
  for (const path of [`/api/imports/${stage.uploadId}`, `/api/imports/${stage.uploadId}/media/0`]) {
    status(await app.request(path, {cookie: second.cookie}), 404);
  }
  for (const operation of ['preview', 'cancel', 'commit']) {
    const body = operation === 'preview' ? mapping : operation === 'cancel' ? {} : {previewId: preview.previewId, requestId: randomUUID(), acceptSkipped: false};
    status(await app.request(`/api/imports/${stage.uploadId}/${operation}`, {cookie: second.cookie, body}), 404);
  }
  const committed = await app.commit(first.cookie, stage.uploadId, preview.previewId);
  const detail = await app.request(`/api/decks/${committed.deckId}`, {cookie: first.cookie});
  const mediaPath = detail.body.deck.words[0].image;
  status(await app.request(`/api/decks/${committed.deckId}`, {cookie: second.cookie}), 404);
  status(await app.request(mediaPath, {cookie: second.cookie}), 404);
  status(await app.request(mediaPath), 401);
  status(await app.request('/api/training', {cookie: second.cookie, body: {deckId: committed.deckId, requestId: randomUUID()}}), 404);
  const catalog = await app.request('/api/decks', {cookie: second.cookie});
  assert(!catalog.body.decks.some((deck: any) => deck.id === committed.deckId));
  assert(!JSON.stringify(catalog.body).includes('Private vocabulary'));
}));

test('committed audio supports authorized HEAD and bounded single Range responses', async () => using(async app => {
  const {cookie} = await app.register();
  const stage = await app.upload(cookie, await app.packageBytes());
  const preview = await app.preview(cookie, stage.uploadId);
  const committed = await app.commit(cookie, stage.uploadId, preview.previewId);
  const detail = await app.request(`/api/decks/${committed.deckId}`, {cookie});
  const path = detail.body.deck.words[0].audio;
  const whole = await app.request(path, {cookie});
  assert.equal(whole.response.status, 200);
  assert.deepEqual(whole.bytes, wav());
  assert.equal(whole.response.headers.get('accept-ranges'), 'bytes');
  assert.match(whole.response.headers.get('cache-control') ?? '', /no-store/);
  const head = await app.request(path, {cookie, method: 'HEAD'});
  assert.equal(head.response.status, 200);
  assert.equal(head.bytes.length, 0);
  assert.equal(Number(head.response.headers.get('content-length')), wav().length);
  const part = await app.request(path, {cookie, headers: {Range: 'bytes=0-15'}});
  assert.equal(part.response.status, 206);
  assert.deepEqual(part.bytes, wav().subarray(0, 16));
  assert.equal(part.response.headers.get('content-range'), `bytes 0-15/${wav().length}`);
  const suffix = await app.request(path, {cookie, headers: {Range: 'bytes=-8'}});
  assert.equal(suffix.response.status, 206);
  assert.deepEqual(suffix.bytes, wav().subarray(-8));
  assert.equal((await app.request(path, {cookie, headers: {Range: 'bytes=999999-'}})).response.status, 416);
  assert.equal((await app.request(path, {cookie, headers: {Range: 'bytes=0-1,3-4'}})).response.status, 416);
}));

test('cancel and expiry leave no visible deck and commit receipt survives stage lifetime', async () => using(async app => {
  const {cookie} = await app.register();
  const bytes = await app.packageBytes();
  const cancelled = await app.upload(cookie, bytes);
  assert((await app.request('/api/imports/current/cancel', {cookie, body: {requestId: cancelled.requestId}})).response.ok);
  assert((await app.request(`/api/imports/${cancelled.uploadId}/cancel`, {cookie, body: {}})).response.ok);
  assert.equal((await app.request('/api/decks', {cookie})).body.decks.length, 1);
  const expired = await app.upload(cookie, bytes);
  app.elapse(31 * 60 * 1000);
  status(await app.request(`/api/imports/${expired.uploadId}`, {cookie}), 410);
  const stage = await app.upload(cookie, bytes);
  const preview = await app.preview(cookie, stage.uploadId);
  const result = await app.commit(cookie, stage.uploadId, preview.previewId);
  app.elapse(31 * 60 * 1000);
  const replay = await app.commit(cookie, stage.uploadId, preview.previewId, result.requestId);
  assert.equal(replay.deckId, result.deckId);
  assert.equal(replay.revision, result.revision);
}));

test('reimport preserves GUID identities, revisions and omitted words while reporting stale changes', async () => using(async app => {
  const {cookie} = await app.register();
  const bytes = await app.packageBytes();
  let stage = await app.upload(cookie, bytes);
  let preview = await app.preview(cookie, stage.uploadId);
  const first = await app.commit(cookie, stage.uploadId, preview.previewId);
  const initial = (await app.request(`/api/decks/${first.deckId}`, {cookie})).body.deck;
  stage = await app.upload(cookie, bytes);
  preview = await app.preview(cookie, stage.uploadId, {destinationDeckId: first.deckId});
  assert.equal(preview.report.unchanged, 4);
  const unchanged = await app.commit(cookie, stage.uploadId, preview.previewId);
  assert.equal(unchanged.revision, first.revision);
  const edited = sourceNotes(200);
  edited[0].fields[0] = 'changed term';
  edited.pop();
  edited.push({guid: 'new-note-guid', modified: 200, fields: ['new term', 'new meaning', '']});
  stage = await app.upload(cookie, await app.packageBytes({notes: edited}));
  preview = await app.preview(cookie, stage.uploadId, {destinationDeckId: first.deckId});
  assert.equal(preview.report.added, 1);
  assert(preview.report.updated >= 1);
  assert.equal(preview.report.retained, 1);
  const updated = await app.commit(cookie, stage.uploadId, preview.previewId);
  assert(updated.revision > first.revision);
  const current = (await app.request(`/api/decks/${first.deckId}`, {cookie})).body.deck;
  assert.equal(current.words.length, 5);
  assert.equal(current.words.find((word: any) => word.term === 'changed term').id, initial.words[0].id);
  assert(current.words.some((word: any) => word.id === initial.words[3].id));
  stage = await app.upload(cookie, bytes);
  preview = await app.preview(cookie, stage.uploadId, {destinationDeckId: first.deckId});
  assert(preview.report.older >= 1);
  status(await app.request(`/api/imports/${stage.uploadId}/commit`, {cookie,
    body: {previewId: preview.previewId, requestId: randomUUID(), acceptSkipped: false}}), 400);
  await app.commit(cookie, stage.uploadId, preview.previewId, randomUUID(), true);
  const retained = (await app.request(`/api/decks/${first.deckId}`, {cookie})).body.deck;
  assert(retained.words.some((word: any) => word.term === 'changed term'));
}));

test('immutable mappings and stale preview revisions cannot overwrite a destination', async () => using(async app => {
  const {cookie} = await app.register();
  const stage = await app.upload(cookie, await app.packageBytes());
  const preview = await app.preview(cookie, stage.uploadId);
  const first = await app.commit(cookie, stage.uploadId, preview.previewId);
  const updatedStage = await app.upload(cookie, await app.packageBytes({notes: sourceNotes(200)}));
  status(await app.request(`/api/imports/${updatedStage.uploadId}/preview`, {cookie,
    body: {...mapping, destinationDeckId: first.deckId, mapping: {...mapping.mapping, term: 'Meaning'}}}), 409);
  const approved = await app.preview(cookie, updatedStage.uploadId, {destinationDeckId: first.deckId});
  const database = new DatabaseSync(app.databasePath);
  database.prepare('UPDATE imported_decks SET revision = revision + 1 WHERE id = ?').run(first.deckId);
  database.close();
  status(await app.request(`/api/imports/${updatedStage.uploadId}/commit`, {cookie,
    body: {previewId: approved.previewId, requestId: randomUUID(), acceptSkipped: false}}), 409);
}));

test('commit rollback preserves staging for a retry without partial decks words or media', async () => using(async app => {
  const {cookie} = await app.register();
  const stage = await app.upload(cookie, await app.packageBytes());
  const preview = await app.preview(cookie, stage.uploadId);
  const database = new DatabaseSync(app.databasePath);
  database.exec("CREATE TRIGGER reject_import BEFORE INSERT ON imported_words BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END;");
  const requestId = randomUUID();
  const failed = await app.request(`/api/imports/${stage.uploadId}/commit`, {cookie,
    body: {previewId: preview.previewId, requestId, acceptSkipped: false}});
  assert(failed.response.status >= 500);
  for (const table of ['imported_decks', 'imported_words', 'imported_media', 'import_commits']) {
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count, 0);
  }
  database.exec('DROP TRIGGER reject_import');
  database.close();
  const committed = await app.commit(cookie, stage.uploadId, preview.previewId, requestId);
  assert.equal(committed.report.added, 4);
}));

test('uploads authenticate and validate origin before accepting package bytes', async () => using(async app => {
  const bytes = await app.packageBytes();
  const headers = {'X-Import-Request-Id': randomUUID(), 'X-Import-Filename': 'vocabulary.apkg'};
  status(await app.request('/api/imports/uploads', {bytes, headers}), 401);
  const {cookie, user} = await app.register();
  status(await app.request('/api/imports/uploads', {cookie, bytes, headers: {...headers, Origin: 'https://evil.example'}}), 403);
  status(await app.request('/api/imports/uploads', {cookie, bytes, headers: {...headers, 'X-Meletio-User': 'another-account'}}), 401);
  status(await app.request('/api/imports/uploads', {cookie, bytes, headers: {...headers, 'X-Import-Filename': 'collection.colpkg'}}), 400);
  const valid = await app.upload(cookie, bytes);
  assert(valid.uploadId);
  assert.equal((await app.request('/api/auth/me', {cookie})).body.user.id, user.id);
}));

async function currentStage(app: Fixture, cookie: string, requestId: string, accept: (stage: any) => boolean) {
  for (let index = 0; index < 100; index++) {
    const result = await app.request(`/api/imports/current?requestId=${requestId}`, {cookie});
    const stage = result.body.stage ?? result.body;
    if (accept(stage)) return stage;
    await delay(10);
  }
  assert.fail('Import stage did not reach the expected state');
}

test('interrupted upload releases its stage and the same client key can retry the complete archive', async () => using(async app => {
  const {cookie} = await app.register();
  const bytes = await app.packageBytes();
  const requestId = randomUUID();
  const upload = httpRequest(app.baseUrl + '/api/imports/uploads', {method: 'POST', headers: {
    Origin: origin, Cookie: cookie, 'Content-Type': 'application/octet-stream',
    'X-Import-Request-Id': requestId, 'X-Import-Filename': 'interrupted.apkg',
  }});
  upload.on('error', () => {});
  upload.write(bytes.subarray(0, 100));
  const stage = await currentStage(app, cookie, requestId, stage => stage.status === 'uploading');
  assert(stage.uploadId);
  upload.destroy();
  await currentStage(app, cookie, requestId, stage => stage.status === 'failed');
  const retried = await app.upload(cookie, bytes, requestId);
  assert.equal(retried.uploadId, stage.uploadId);
  assert.equal(retried.status, 'ready');
}));

test('cancel by client key works before upload ID delivery and exposes no content', async () => using(async app => {
  const {cookie} = await app.register();
  const bytes = await app.packageBytes();
  const requestId = randomUUID();
  const upload = httpRequest(app.baseUrl + '/api/imports/uploads', {method: 'POST', headers: {
    Origin: origin, Cookie: cookie, 'Content-Type': 'application/octet-stream',
    'X-Import-Request-Id': requestId, 'X-Import-Filename': 'cancel-before-id.apkg',
  }});
  upload.on('error', () => {});
  upload.on('response', response => response.resume());
  upload.write(bytes.subarray(0, 100));
  await currentStage(app, cookie, requestId, stage => stage.status === 'uploading');
  const cancelled = await app.request('/api/imports/current/cancel', {cookie, body: {requestId}});
  assert(cancelled.response.ok, JSON.stringify(cancelled.body));
  upload.destroy();
  await currentStage(app, cookie, requestId, stage => stage.status === 'cancelled');
  assert.equal((await app.request('/api/decks', {cookie})).body.decks.length, 1);
}));

test('oversized uploads and unsupported modern exports fail without consuming future import slots', async () => using(async app => {
  const {cookie} = await app.register();
  const oversizedStatus = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(app.baseUrl + '/api/imports/uploads', {method: 'POST', headers: {
      Origin: origin, Cookie: cookie, 'Content-Type': 'application/octet-stream',
      'Content-Length': String(100 * 1024 * 1024 + 1),
      'X-Import-Request-Id': randomUUID(), 'X-Import-Filename': 'too-large.apkg',
    }}, response => { resolve(response.statusCode!); response.resume(); request.destroy(); });
    request.once('error', reject);
    request.flushHeaders();
  });
  assert.equal(oversizedStatus, 413);
  const modern = await app.packageBytes({extraEntries: [{name: 'meta', data: Buffer.from([8, 3])}, {name: 'collection.anki21b', data: 'modern'}]});
  const rejected = await app.request('/api/imports/uploads', {cookie, bytes: modern,
    headers: {'X-Import-Request-Id': randomUUID(), 'X-Import-Filename': 'modern.apkg'}});
  assert([400, 422].includes(rejected.response.status), JSON.stringify(rejected.body));
  assert.match(rejected.body.error.message, /older|compatible|export/i);
  const valid = await app.upload(cookie, await app.packageBytes());
  assert.equal(valid.status, 'ready');
}));

test('reimport changes current vocabulary while active completed and retry snapshots retain original words and media', async () => using(async app => {
  const {cookie} = await app.register();
  const stage = await app.upload(cookie, await app.packageBytes());
  const preview = await app.preview(cookie, stage.uploadId);
  const imported = await app.commit(cookie, stage.uploadId, preview.previewId);
  let result = await app.request('/api/training?format=compact', {cookie,
    body: {deckId: imported.deckId, requestId: randomUUID()}});
  assert(result.response.ok, JSON.stringify(result.body));
  let attempt = result.body.attempt;
  const initial = await app.request(`/api/training/${attempt.id}/snapshot`, {cookie});
  const snapshot = initial.body.snapshot;
  assert(snapshot);
  const first = snapshot.questions[0];
  const wrong = first.optionIds.find((id: string) => id !== first.wordId);
  result = await app.request(`/api/training/${attempt.id}/answer?format=compact`, {cookie,
    body: {position: 0, revision: 0, optionId: wrong, requestId: randomUUID()}});
  assert(result.response.ok, JSON.stringify(result.body));
  attempt = result.body.attempt;
  const beforeUpdate = structuredClone(attempt);
  const source = sourceNotes(200);
  source[0].fields[0] = 'replacement term';
  const update = await app.upload(cookie, await app.packageBytes({notes: source, media: {'book.png': Buffer.concat([png, Buffer.from('new-version')]), 'voice.wav': wav()}}));
  const updatedPreview = await app.preview(cookie, update.uploadId, {destinationDeckId: imported.deckId});
  await app.commit(cookie, update.uploadId, updatedPreview.previewId);
  const current = (await app.request(`/api/decks/${imported.deckId}`, {cookie})).body.deck;
  assert(current.words.some((word: any) => word.term === 'replacement term'));
  assert(!snapshot.words.some((word: any) => word.term === 'replacement term'));
  const oldImage = snapshot.words[0].image;
  assert.deepEqual((await app.request(oldImage, {cookie})).bytes, png);
  await app.restart();
  assert.deepEqual((await app.request(`/api/training/${attempt.id}/snapshot`, {cookie})).body.snapshot, snapshot);
  assert.deepEqual((await app.request(`/api/training/${attempt.id}?format=compact`, {cookie})).body.attempt, beforeUpdate);
  while (attempt.position < snapshot.questions.length) {
    if (attempt.selected === null) {
      const accepted = await app.request(`/api/training/${attempt.id}/answer?format=compact`, {cookie,
        body: {position: attempt.position, revision: attempt.revision, optionId: snapshot.questions[attempt.position].wordId, requestId: randomUUID()}});
      assert(accepted.response.ok, JSON.stringify(accepted.body)); attempt = accepted.body.attempt;
    }
    const advanced = await app.request(`/api/training/${attempt.id}/advance?format=compact`, {cookie,
      body: {position: attempt.position, revision: attempt.revision, requestId: randomUUID()}});
    assert(advanced.response.ok, JSON.stringify(advanced.body)); attempt = advanced.body.attempt;
  }
  const retry = await app.request(`/api/training/${attempt.id}/retry?format=compact`, {cookie, body: {requestId: randomUUID()}});
  assert(retry.response.ok, JSON.stringify(retry.body));
  const retrySnapshot = (await app.request(`/api/training/${retry.body.attempt.id}/snapshot`, {cookie})).body.snapshot;
  assert.equal(retrySnapshot.questions.length, 1);
  assert.equal(retrySnapshot.questions[0].wordId, first.wordId);
  assert.deepEqual(retrySnapshot.words, snapshot.words);
  const fresh = await app.request('/api/training?format=compact', {cookie, body: {deckId: imported.deckId, requestId: randomUUID()}});
  assert(fresh.response.ok, JSON.stringify(fresh.body));
  const freshSnapshot = (await app.request(`/api/training/${fresh.body.attempt.id}/snapshot`, {cookie})).body.snapshot;
  assert(freshSnapshot.words.some((word: any) => word.term === 'replacement term'));
}));

test('one archive can import different source decks while an identical source selection cannot be cloned', async () => using(async app => {
  const {cookie} = await app.register();
  const rootNotes = sourceNotes();
  const childNotes = sourceNotes().map((note, index) => ({...note, guid: `child-note-${index}`, fields: [`child term ${index}`, `child meaning ${index}`, ''], deckIds: ['2']}));
  const bytes = await app.packageBytes({notes: [...rootNotes, ...childNotes]});
  const firstStage = await app.upload(cookie, bytes);
  const firstPreview = await app.preview(cookie, firstStage.uploadId);
  assert.equal(firstPreview.report.added, 4);
  const first = await app.commit(cookie, firstStage.uploadId, firstPreview.previewId);
  const childStage = await app.upload(cookie, bytes);
  const childPreview = await app.preview(cookie, childStage.uploadId, {sourceDeckId: '2', title: 'Private child vocabulary'});
  assert.equal(childPreview.report.added, 4);
  const second = await app.commit(cookie, childStage.uploadId, childPreview.previewId);
  assert.notEqual(first.deckId, second.deckId);
  const childDeck = (await app.request(`/api/decks/${second.deckId}`, {cookie})).body.deck;
  assert(childDeck.words.every((word: any) => word.term.startsWith('child term')));
  const duplicateStage = await app.upload(cookie, bytes);
  status(await app.request(`/api/imports/${duplicateStage.uploadId}/preview`, {cookie, body: mapping}), 409);
  const catalog = await app.request('/api/decks', {cookie});
  assert.equal(catalog.body.decks.filter((deck: any) => deck.imported).length, 2);
}));

test('lost commit responses recover owned durable results by upload key and after restart without a key', async () => using(async app => {
  const first = await app.register();
  const second = await app.register('recovery-other@example.com');
  const stage = await app.upload(first.cookie, await app.packageBytes());
  const preview = await app.preview(first.cookie, stage.uploadId);
  const committed = await app.commit(first.cookie, stage.uploadId, preview.previewId);
  const expected = {deckId: committed.deckId, revision: committed.revision, report: committed.report};
  const byKey = await app.request(`/api/imports/current?requestId=${stage.requestId}`, {cookie: first.cookie});
  assert.equal(byKey.body.status, 'committed');
  assert.deepEqual(byKey.body.result, expected);
  assert.equal(byKey.body.preview, null);
  const hidden = await app.request(`/api/imports/current?requestId=${stage.requestId}`, {cookie: second.cookie});
  assert.deepEqual(hidden.body, {stage: null});
  await app.restart();
  const afterReload = await app.request('/api/imports/current', {cookie: first.cookie});
  assert.equal(afterReload.body.uploadId, stage.uploadId);
  assert.deepEqual(afterReload.body.result, expected);
  assert.deepEqual((await app.request('/api/imports/current', {cookie: second.cookie})).body, {stage: null});
  assert.equal((await app.request('/api/decks', {cookie: first.cookie})).body.decks.filter((deck: any) => deck.imported).length, 1);
}));

test('staging directory creation failure releases the import slot and permits same-key retry', async () => using(async app => {
  const {cookie} = await app.register();
  const bytes = await app.packageBytes();
  const requestId = randomUUID();
  const root = join(app.directory, 'import-staging');
  await rm(root, {recursive: true, force: true});
  await writeFile(root, 'fixture: staging root temporarily unavailable');
  const failed = await app.request('/api/imports/uploads', {cookie, bytes,
    headers: {'X-Import-Request-Id': requestId, 'X-Import-Filename': 'retry.apkg'}});
  assert(failed.response.status >= 500, JSON.stringify(failed.body));
  const stage = await app.request(`/api/imports/current?requestId=${requestId}`, {cookie});
  assert.equal(stage.body.status, 'failed');
  await rm(root);
  await mkdir(root);
  const recovered = await app.upload(cookie, bytes, requestId);
  assert.equal(recovered.status, 'ready');
  assert.equal(recovered.uploadId, stage.body.uploadId);
}));

test('preview byte budget includes normalized per-word languages before accepting near-limit content', async () => using(async app => {
  const {cookie} = await app.register();
  const count = 1000;
  const language = 'en-Latn-US-variant';
  const words = (padding: number, languages: boolean) => Array.from({length: count}, (_, index) => ({
    id: '00000000-0000-4000-8000-000000000000', term: `term${index}-${'x'.repeat(padding)}`,
    meaning: `meaning${index}-${'y'.repeat(padding)}`, image: null, audio: null,
    ...(languages ? {termLang: language, meaningLang: language} : {}),
  }));
  const shape = (padding: number, languages: boolean) => ({id: '00000000-0000-4000-8000-000000000000', title: mapping.title,
    termLang: language, meaningLang: language, termDir: 'ltr', meaningDir: 'ltr', wordCount: count,
    revision: 1, imported: true, words: words(padding, languages)});
  let lower = 0;
  let upper = 1900;
  while (lower < upper) {
    const candidate = Math.ceil((lower + upper) / 2);
    if (Buffer.byteLength(JSON.stringify(shape(candidate, false))) <= 1024 * 1024) lower = candidate;
    else upper = candidate - 1;
  }
  const padding = lower - 10;
  assert(Buffer.byteLength(JSON.stringify(shape(padding, false))) < 1024 * 1024);
  assert(Buffer.byteLength(JSON.stringify(shape(padding, true))) > 1024 * 1024);
  const notes = words(padding, false).map((word, index) => ({guid: `budget-guid-${index}`, fields: [word.term, word.meaning, '']}));
  const stage = await app.upload(cookie, await app.packageBytes({notes, media: {}}));
  status(await app.request(`/api/imports/${stage.uploadId}/preview`, {cookie,
    body: {...mapping, termLang: language, meaningLang: language, mapping: {...mapping.mapping, image: null, audio: null}}}), 422);
  assert.equal((await app.request('/api/decks', {cookie})).body.decks.length, 1);
}));

test('more than two thousand selected notes fails preview before creating an imported deck', async () => using(async app => {
  const {cookie} = await app.register();
  const notes = Array.from({length: 2001}, (_, index) => ({guid: `selected-limit-${index}`, fields: [`word ${index}`, `meaning ${index}`, '']}));
  const stage = await app.upload(cookie, await app.packageBytes({notes, media: {}}));
  status(await app.request(`/api/imports/${stage.uploadId}/preview`, {cookie,
    body: {...mapping, mapping: {...mapping.mapping, image: null, audio: null}}}), 422);
  assert.equal((await app.request('/api/decks', {cookie})).body.decks.length, 1);
}));
