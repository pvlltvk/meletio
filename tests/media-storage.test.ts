import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {createApplication} from '../server/app';
import {openDatabase} from '../server/database';
import {MediaStorage} from '../server/media-storage';
import {makePackage, png, wav} from './helpers/anki-package';

const origin = 'http://127.0.0.1:4173';
const password = 'media storage fixture password';
const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function fixture(limits: {bytes: number; files: number}) {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-media-storage-'));
  const databasePath = join(directory, 'app.sqlite');
  const app = createApplication({databasePath, content: {uiLanguage: 'en', decks: []}, origin, registration: 'open',
    mediaLimits: limits} as Parameters<typeof createApplication>[0]);
  await new Promise<void>((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  const address = app.server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  async function request(path: string, options: {body?: unknown; cookie?: string; headers?: Record<string, string>} = {}) {
    const headers: Record<string, string> = {Origin: origin, 'Content-Type': 'application/json', ...options.headers};
    if (options.cookie) headers.Cookie = options.cookie;
    const response = await fetch(base + path, {method: options.body === undefined ? 'GET' : 'POST', headers,
      ...(options.body === undefined ? {} : {body: JSON.stringify(options.body)})});
    const text = await response.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = text; }
    return {response, body, text};
  }
  async function register(email: string) {
    const result = await request('/api/auth/register', {body: {email, password}});
    assert.equal(result.response.status, 201, result.text);
    return {cookie: result.response.headers.get('set-cookie')!.split(';')[0], user: result.body.user};
  }
  async function token(cookie: string) {
    const result = await request('/api/account/tokens', {cookie, body: {name: 'storage test', currentPassword: password}});
    assert.equal(result.response.status, 201, result.text);
    return result.body.token as string;
  }
  async function upload(b: Buffer, id: string, bearer: string) {
    const response = await fetch(base + '/api/authoring/media', {method: 'POST', headers: {Origin: origin,
      'Content-Type': 'application/octet-stream', 'X-Request-Id': id, 'X-Media-Filename': 'image.png',
      Authorization: `Bearer ${bearer}`}, body: new Uint8Array(b)});
    const text = await response.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = text; }
    return {response, body, text};
  }
  const database = () => new DatabaseSync(databasePath);
  return {request, register, token, upload, database, async close() { await app.close(); await rm(directory, {recursive: true, force: true}); }};
}

test('media admission counts unique retained blobs and allows deduplication and exact receipt replay at quota', async () => {
  const f = await fixture({bytes: image.length * 2 + 1, files: 2});
  try {
    const owner = await f.register('storage-owner@example.com');
    const other = await f.register('storage-other@example.com');
    const bearer = await f.token(owner.cookie);
    const otherBearer = await f.token(other.cookie);
    const first = await f.upload(image, 'storage-first', bearer);
    assert.equal(first.response.status, 201, first.text);
    const duplicate = await f.upload(image, 'storage-deduplicated', bearer);
    assert.equal(duplicate.response.status, 201, duplicate.text);
    assert.equal(duplicate.body.id, first.body.id);
    const secondBytes = Buffer.from([...image, 1]);
    const second = await f.upload(secondBytes, 'storage-second', bearer);
    assert.equal(second.response.status, 201, second.text);
    const replay = await f.upload(secondBytes, 'storage-second', bearer);
    assert.equal(replay.response.status, 201, replay.text);
    assert.equal(replay.body.id, second.body.id);
    const deduplicatedAtQuota = await f.upload(image, 'storage-deduplicated-at-quota', bearer);
    assert.equal(deduplicatedAtQuota.response.status, 201, deduplicatedAtQuota.text);
    assert.equal(deduplicatedAtQuota.body.id, first.body.id);
    const rejected = await f.upload(Buffer.from([...image, 2]), 'storage-over-quota', bearer);
    assert.equal(rejected.response.status, 422, rejected.text);
    assert.equal(rejected.body.error.code, 'storage_limit');
    const otherOwnerWrite = await f.upload(image, 'other-owner-independent-quota', otherBearer);
    assert.equal(otherOwnerWrite.response.status, 201, otherOwnerWrite.text);
    const db = f.database();
    try {
      const retained = db.prepare('SELECT count(*) AS files, sum(size) AS bytes FROM imported_media WHERE owner_id = ?').get(owner.user.id) as {files: number; bytes: number};
      const receipts = (db.prepare('SELECT count(*) AS n FROM content_mutations WHERE owner_id = ?').get(owner.user.id) as {n: number}).n;
      assert.equal(retained.files, 2);
      assert.equal(retained.bytes, image.length * 2 + 1);
      assert.equal(receipts, 4);
      assert.equal((db.prepare('SELECT count(*) AS n FROM imported_media WHERE owner_id = ?').get(other.user.id) as {n: number}).n, 1);
    } finally { db.close(); }
  } finally { await f.close(); }
});

test('byte and file admission limits apply independently, including concurrent uploads', async () => {
  const byteFixture = await fixture({bytes: image.length * 2, files: 10});
  try {
    const owner = await byteFixture.register('storage-bytes@example.com');
    const bearer = await byteFixture.token(owner.cookie);
    assert.equal((await byteFixture.upload(image, 'bytes-first', bearer)).response.status, 201);
    const tooManyBytes = await byteFixture.upload(Buffer.from([...image, 1]), 'bytes-second', bearer);
    assert.equal(tooManyBytes.response.status, 422, tooManyBytes.text);
    assert.equal(tooManyBytes.body.error.code, 'storage_limit');
  } finally { await byteFixture.close(); }

  const fileFixture = await fixture({bytes: image.length * 10, files: 1});
  try {
    const owner = await fileFixture.register('storage-files@example.com');
    const bearer = await fileFixture.token(owner.cookie);
    const contenders = await Promise.all([
      fileFixture.upload(image, 'files-first', bearer),
      fileFixture.upload(Buffer.from([...image, 1]), 'files-second', bearer)
    ]);
    assert.deepEqual(contenders.map(result => result.response.status).sort(), [201, 422]);
    const rejected = contenders.find(result => result.response.status === 422)!;
    assert.equal(rejected.body.error.code, 'storage_limit');
    const db = fileFixture.database();
    try { assert.equal((db.prepare('SELECT count(*) AS n FROM imported_media').get() as {n: number}).n, 1); }
    finally { db.close(); }
  } finally { await fileFixture.close(); }
});

test('media admission validates positive safe integer limits before opening the database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-media-limits-validation-'));
  try {
    for (const mediaLimits of [{bytes: 0, files: 1}, {bytes: 1.5, files: 1}, {bytes: Number.MAX_SAFE_INTEGER + 1, files: 1}, {bytes: 1, files: -1}]) {
      const invalidPath = join(directory, 'must-not-exist.sqlite');
      assert.throws(() => createApplication({databasePath: invalidPath, content: {uiLanguage: 'en', decks: []}, origin,
        mediaLimits} as Parameters<typeof createApplication>[0]));
      assert.equal(existsSync(invalidPath), false);
    }
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('invalid environment media limits stop server startup before creating the database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-media-env-validation-'));
  const databasePath = join(directory, 'app.sqlite');
  try {
    const result = spawnSync(process.execPath, [join(process.cwd(), 'dist/server/index.js')], {encoding: 'utf8', timeout: 10_000,
      env: {...process.env, DATABASE_PATH: databasePath, MEDIA_MAX_BYTES: '0', MEDIA_MAX_FILES: '1'}});
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /MEDIA_MAX_BYTES/);
    assert.equal(existsSync(databasePath), false);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('an over-quota owner can still read existing media and replay a deduplicated upload', async () => {
  const f = await fixture({bytes: image.length, files: 1});
  try {
    const owner = await f.register('storage-overquota@example.com');
    const bearer = await f.token(owner.cookie);
    const db = f.database();
    try {
      const insert = db.prepare('INSERT INTO imported_media VALUES (?,?,?,?,?,?)');
      insert.run('retained-image-one', owner.user.id, createHash('sha256').update(image).digest('hex'), 'image/png', image.length, image);
      const otherImage = Buffer.from([...image, 9]);
      insert.run('retained-image-two', owner.user.id, createHash('sha256').update(otherImage).digest('hex'), 'image/png', otherImage.length, otherImage);
    } finally { db.close(); }
    const read = await f.request('/api/authoring/media/retained-image-one', {headers: {Authorization: `Bearer ${bearer}`}});
    assert.equal(read.response.status, 200, read.text);
    const deduplicated = await f.upload(image, 'overquota-dedup', bearer);
    assert.equal(deduplicated.response.status, 201, deduplicated.text);
    assert.equal(deduplicated.body.id, 'retained-image-one');
    const replay = await f.upload(image, 'overquota-dedup', bearer);
    assert.equal(replay.response.status, 201, replay.text);
    assert.equal(replay.body.id, 'retained-image-one');
    const check = f.database();
    try {
      assert.equal((check.prepare('SELECT count(*) AS n FROM imported_media WHERE owner_id = ?').get(owner.user.id) as {n: number}).n, 2);
      assert.equal((check.prepare('SELECT count(*) AS n FROM content_mutations WHERE owner_id = ?').get(owner.user.id) as {n: number}).n, 1);
    } finally { check.close(); }
  } finally { await f.close(); }
});

test('a partially admitted Anki import rolls back its whole commit and receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-media-import-quota-'));
  const databasePath = join(directory, 'app.sqlite');
  const app = createApplication({databasePath, content: {uiLanguage: 'en', decks: []}, origin, registration: 'open',
    mediaLimits: {bytes: png.length + 1, files: 1}} as Parameters<typeof createApplication>[0]);
  try {
    await new Promise<void>((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', resolve);
    });
    const address = app.server.address();
    assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    async function request(path: string, options: {cookie?: string; body?: unknown; bytes?: Buffer; headers?: Record<string, string>} = {}) {
      const headers: Record<string, string> = {Origin: origin, ...options.headers};
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (options.bytes) headers['Content-Type'] = 'application/octet-stream';
      if (options.cookie) headers.Cookie = options.cookie;
      const response = await fetch(base + path, {method: options.body === undefined && options.bytes === undefined ? 'GET' : 'POST', headers,
        body: options.bytes ? new Uint8Array(options.bytes) : options.body === undefined ? undefined : JSON.stringify(options.body)});
      const text = await response.text();
      let body: any;
      try { body = JSON.parse(text); } catch { body = text; }
      return {response, body, text};
    }
    const registered = await request('/api/auth/register', {body: {email: 'import-quota@example.com', password}});
    assert.equal(registered.response.status, 201, registered.text);
    const cookie = registered.response.headers.get('set-cookie')!.split(';')[0];
    const source = await mkdtemp(join(directory, 'package-'));
    const archive = (await makePackage(source, {notes: [{guid: 'import-with-two-media', fields: [
      'book', '<div>libro <img src="photo.png"></div>', '[sound:voice.wav]']}], media: {'photo.png': png, 'voice.wav': wav()}})).bytes;
    const uploaded = await request('/api/imports/uploads', {cookie, bytes: archive, headers: {
      'X-Import-Request-Id': 'quota-stage-upload', 'X-Import-Filename': 'quota.apkg'}});
    assert.equal(uploaded.response.status, 201, uploaded.text);
    const preview = await request(`/api/imports/${uploaded.body.uploadId}/preview`, {cookie, body: {sourceDeckId: '1',
      noteTypeId: '100', includeChildren: false, mapping: {term: 'Term', meaning: 'Meaning', image: 'Meaning', audio: 'Audio'},
      title: 'Quota import', termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr'}});
    assert.equal(preview.response.status, 200, preview.text);
    const commit = await request(`/api/imports/${uploaded.body.uploadId}/commit`, {cookie, body: {previewId: preview.body.previewId,
      requestId: 'quota-import-commit', acceptSkipped: false}});
    assert.equal(commit.response.status, 422, commit.text);
    assert.equal(commit.body.error.code, 'storage_limit');
    const db = new DatabaseSync(databasePath);
    try {
      assert.equal((db.prepare('SELECT count(*) AS n FROM imported_media').get() as {n: number}).n, 0);
      assert.equal((db.prepare('SELECT count(*) AS n FROM imported_decks').get() as {n: number}).n, 0);
      assert.equal((db.prepare('SELECT count(*) AS n FROM imported_words').get() as {n: number}).n, 0);
      assert.equal((db.prepare('SELECT count(*) AS n FROM import_commits').get() as {n: number}).n, 0);
    } finally { db.close(); }
  } finally {
    await app.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('bulk admission reads owner usage once per transaction instead of once per file', () => {
  const db = openDatabase(':memory:');
  try {
    const userId = randomUUID();
    db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(userId, 'bulk-admission@example.com', 'hash', 0);
    const retained = db.prepare('INSERT INTO imported_media VALUES (?,?,?,?,?,?)');
    for (let index = 0; index < 50; index++) {
      retained.run(`retained-${index}`, userId, createHash('sha256').update(`retained-${index}`).digest('hex'), 'image/png', image.length, image);
    }
    let usageScans = 0;
    const counted = new Proxy(db, {
      get: (target, property) => {
        const value = Reflect.get(target, property) as unknown;
        if (property === 'prepare') {
          return (sql: string) => {
            if (sql.includes('sum(size)')) usageScans += 1;
            return target.prepare(sql);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      }
    }) as DatabaseSync;
    const storage = new MediaStorage(counted, {bytes: image.length * 100, files: 100});
    db.exec('BEGIN IMMEDIATE');
    const admit = storage.admitter(userId);
    for (let index = 0; index < 20; index++) admit(createHash('sha256').update(`added-${index}`).digest('hex'), 'image/png', image);
    db.exec('COMMIT');
    assert.equal(usageScans, 1);
    assert.equal((db.prepare('SELECT count(*) AS n FROM imported_media WHERE owner_id = ?').get(userId) as {n: number}).n, 70);
  } finally { db.close(); }
});

test('an Anki import commit reads owner usage once for all new media and not at all without new media', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-media-import-usage-'));
  const databasePath = join(directory, 'app.sqlite');
  const app = createApplication({databasePath, content: {uiLanguage: 'en', decks: []}, origin, registration: 'open',
    mediaLimits: {bytes: 1_000_000, files: 100}} as Parameters<typeof createApplication>[0]);
  const prepare = DatabaseSync.prototype.prepare;
  let usageScans = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', resolve);
    });
    const address = app.server.address();
    assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    async function request(path: string, options: {cookie?: string; body?: unknown; bytes?: Buffer; headers?: Record<string, string>} = {}) {
      const headers: Record<string, string> = {Origin: origin, ...options.headers};
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (options.bytes) headers['Content-Type'] = 'application/octet-stream';
      if (options.cookie) headers.Cookie = options.cookie;
      const response = await fetch(base + path, {method: options.body === undefined && options.bytes === undefined ? 'GET' : 'POST', headers,
        body: options.bytes ? new Uint8Array(options.bytes) : options.body === undefined ? undefined : JSON.stringify(options.body)});
      const text = await response.text();
      let body: any;
      try { body = JSON.parse(text); } catch { body = text; }
      return {response, body, text};
    }
    const registered = await request('/api/auth/register', {body: {email: 'import-usage@example.com', password}});
    assert.equal(registered.response.status, 201, registered.text);
    const cookie = registered.response.headers.get('set-cookie')!.split(';')[0];
    const retained = new DatabaseSync(databasePath);
    try {
      const insert = retained.prepare('INSERT INTO imported_media VALUES (?,?,?,?,?,?)');
      for (let index = 0; index < 3; index++) {
        insert.run(`retained-${index}`, registered.body.user.id, createHash('sha256').update(`retained-${index}`).digest('hex'), 'image/png', image.length, image);
      }
    } finally { retained.close(); }
    const audio = (index: number) => { const bytes = wav(); bytes.writeInt16LE(index + 1, 44); return bytes; };
    const withMedia = Array.from({length: 6}, (_, index) => ({guid: `usage-media-${index}`, fields: [`word ${index}`,
      `<div>meaning ${index} <img src="photo-${index}.png"></div>`, `[sound:voice-${index}.wav]`]}));
    const plain = [{guid: 'usage-plain', deckIds: ['3'], fields: ['plain', 'plain meaning', '']}];
    const source = await mkdtemp(join(directory, 'package-'));
    const archive = (await makePackage(source, {notes: [...withMedia, ...plain], media: Object.fromEntries(withMedia.flatMap((_, index) => [
      [`photo-${index}.png`, Buffer.concat([png, Buffer.from([index])])], [`voice-${index}.wav`, audio(index)]]))})).bytes;
    async function commit(sourceDeckId: string, requestId: string) {
      const uploaded = await request('/api/imports/uploads', {cookie, bytes: archive, headers: {
        'X-Import-Request-Id': `${requestId}-upload`, 'X-Import-Filename': 'usage.apkg'}});
      assert.equal(uploaded.response.status, 201, uploaded.text);
      const preview = await request(`/api/imports/${uploaded.body.uploadId}/preview`, {cookie, body: {sourceDeckId,
        noteTypeId: '100', includeChildren: false, mapping: {term: 'Term', meaning: 'Meaning', image: 'Meaning', audio: 'Audio'},
        title: `Usage ${requestId}`, termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr'}});
      assert.equal(preview.response.status, 200, preview.text);
      DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
        if (sql.includes('sum(size)')) usageScans += 1;
        return prepare.call(this, sql);
      };
      try {
        const result = await request(`/api/imports/${uploaded.body.uploadId}/commit`, {cookie, body: {previewId: preview.body.previewId,
          requestId, acceptSkipped: true}});
        assert.equal(result.response.status, 200, result.text);
      } finally { DatabaseSync.prototype.prepare = prepare; }
    }
    const count = () => {
      const db = new DatabaseSync(databasePath);
      try { return (db.prepare('SELECT count(*) AS n FROM imported_media WHERE owner_id = ?').get(registered.body.user.id) as {n: number}).n; } finally { db.close(); }
    };
    await commit('3', 'usage-plain-commit');
    assert.equal(usageScans, 0);
    assert.equal(count(), 3);
    await commit('1', 'usage-media-commit');
    assert.equal(usageScans, 1);
    assert.equal(count(), 15);
  } finally {
    DatabaseSync.prototype.prepare = prepare;
    await app.close();
    await rm(directory, {recursive: true, force: true});
  }
});
