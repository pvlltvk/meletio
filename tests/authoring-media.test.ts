import assert from 'node:assert/strict';
import {request as httpRequest, type IncomingHttpHeaders, type ClientRequest} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {createApplication} from '../server/app';

const origin = 'http://127.0.0.1:4173';
const password = 'authoring media fixture password';
const content = {uiLanguage: 'en', decks: []};
type Options = {now?: () => number};
type Uploaded = {response: Response; body: {id: string; kind: string; mime: string; size: number}; bytes: Buffer};
type StreamResult = {status: number; headers: IncomingHttpHeaders; bytes: Buffer};

async function fixture(options: Options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-authoring-media-'));
  const databasePath = join(directory, 'app.sqlite');
  let app: ReturnType<typeof createApplication>;
  let base = '';
  let instant = 1_700_000_000_000;
  async function start() {
    app = createApplication({databasePath, content, origin, registration: 'open', now: options.now || (() => instant)});
    await new Promise<void>((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', resolve);
    });
    const address = app.server.address();
    assert(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
  }
  await start();
  async function request(path: string, options: {method?: string; body?: unknown; cookie?: string; headers?: Record<string, string>; noOrigin?: boolean} = {}) {
    const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
    const headers: Record<string, string> = {...(method === 'POST' ? {Origin: origin, 'Content-Type': 'application/json'} : {}), ...options.headers};
    if (options.noOrigin) delete headers.Origin;
    if (options.cookie) headers.Cookie = options.cookie;
    const response = await fetch(base + path, {method, headers,
      ...(options.body === undefined ? {} : {body: JSON.stringify(options.body)})});
    const text = await response.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = text; }
    return {response, body, text};
  }
  async function requestBytes(path: string, options: {method?: string; cookie?: string; headers?: Record<string, string>; noOrigin?: boolean} = {}) {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = {...options.headers};
    if (options.noOrigin) delete headers.Origin;
    if (options.cookie) headers.Cookie = options.cookie;
    const response = await fetch(base + path, {method, headers});
    return {response, bytes: Buffer.from(await response.arrayBuffer())};
  }
  async function register(email: string) {
    const result = await request('/api/auth/register', {body: {email, password}});
    assert.equal(result.response.status, 201, result.text);
    return {cookie: result.response.headers.get('set-cookie')!.split(';')[0], user: result.body.user};
  }
  async function createToken(cookie: string, name = 'media uploader') {
    const result = await request('/api/account/tokens', {cookie, body: {name}});
    assert.equal(result.response.status, 201, result.text);
    return result.body as {id: string; token: string};
  }
  async function createDeck(cookie: string, token: string, requestId = 'create-media-set-1') {
    const result = await request('/api/authoring/decks', {cookie, headers: {Authorization: `Bearer ${token}`}, body: {
      requestId, title: 'Media words', termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr'}});
    assert.equal(result.response.status, 201, result.text);
    return result.body.deck as {id: string; revision: number};
  }
  async function upload(bytes: Buffer, requestId: string, filename: string, token?: string, originHeader?: string): Promise<Uploaded> {
    const response = await fetch(`${base}/api/authoring/media`, {method: 'POST', headers: {
      ...(originHeader ? {Origin: originHeader} : {}), 'Content-Type': 'application/octet-stream', 'X-Request-Id': requestId,
      'X-Media-Filename': filename, ...(token ? {Authorization: `Bearer ${token}`} : {})}, body: new Uint8Array(bytes)});
    const payload = await response.arrayBuffer();
    let body: Uploaded['body'];
    try { body = JSON.parse(Buffer.from(payload).toString('utf8')) as Uploaded['body']; }
    catch { body = {id: '', kind: '', mime: '', size: 0}; }
    return {response, body, bytes: Buffer.from(payload)};
  }
  function streamUpload(headers: Record<string, string>, prefix: Buffer) {
    let request!: ClientRequest;
    const result = new Promise<StreamResult>(resolve => {
      request = httpRequest(`${base}/api/authoring/media`, {method: 'POST', headers, agent: false, timeout: 20_000}, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => resolve({status: response.statusCode || 0, headers: response.headers, bytes: Buffer.concat(chunks)}));
      });
      request.on('error', () => resolve({status: 0, headers: {}, bytes: Buffer.alloc(0)}));
      request.on('timeout', () => request.destroy());
      request.write(prefix);
    });
    return {request, result};
  }
  const database = () => new DatabaseSync(databasePath);
  return {request, requestBytes, register, createToken, createDeck, upload, streamUpload, database, get base() { return base; },
    async restart() { await app.close(); await start(); },
    elapse(ms: number) { instant += ms; }, async close() { await app.close(); await rm(directory, {recursive: true, force: true}); }};
}

function samples() {
  return [
    {filename: 'picture.png', kind: 'image', mime: 'image/png', bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])},
    {filename: 'picture.jpg', kind: 'image', mime: 'image/jpeg', bytes: Buffer.from([255, 216, 255, 4])},
    {filename: 'picture.webp', kind: 'image', mime: 'image/webp', bytes: Buffer.from('RIFF1234WEBP')},
    {filename: 'word.mp3', kind: 'audio', mime: 'audio/mpeg', bytes: Buffer.from('ID3 fixture audio')},
    {filename: 'word.wav', kind: 'audio', mime: 'audio/wav', bytes: Buffer.from('RIFF1234WAVE')},
    {filename: 'word.ogg', kind: 'audio', mime: 'audio/ogg', bytes: Buffer.from('OggS fixture')},
    {filename: 'word.m4a', kind: 'audio', mime: 'audio/mp4', bytes: Buffer.from('0000ftypM4A ')},
    {filename: 'word.mp4', kind: 'audio', mime: 'audio/mp4', bytes: Buffer.from('0000ftypisom')}
  ];
}

test('supported image and audio signatures upload once and remain private with byte-range reads', async () => {
  const f = await fixture();
  try {
    const owner = await f.register('owner@example.com');
    const other = await f.register('other@example.com');
    const token = await f.createToken(owner.cookie);
    const otherToken = await f.createToken(other.cookie);
    const saved: {id: string; bytes: Buffer; mime: string; filename: string}[] = [];
    for (const sample of samples()) {
      const uploaded = await f.upload(sample.bytes, `upload-${sample.filename}`, sample.filename, token.token);
      assert.equal(uploaded.response.status, 201, uploaded.bytes.toString());
      assert.equal(uploaded.body.kind, sample.kind);
      assert.equal(uploaded.body.mime, sample.mime);
      assert.equal(uploaded.body.size, sample.bytes.length);
      assert.equal(typeof uploaded.body.id, 'string');
      saved.push({id: uploaded.body.id, bytes: sample.bytes, mime: sample.mime, filename: sample.filename});
    }
    const sample = saved[0];
    const replay = await f.upload(sample.bytes, `upload-${sample.filename}`, sample.filename, token.token);
    assert.equal(replay.response.status, 201, replay.bytes.toString());
    assert.equal(replay.body.id, sample.id);
    const renamedReplay = await f.upload(sample.bytes, `upload-${sample.filename}`, 'renamed.png', token.token);
    assert.equal(renamedReplay.response.status, 409, renamedReplay.bytes.toString());
    const deduplicated = await f.upload(sample.bytes, `upload-same-${sample.filename}`, sample.filename, token.token);
    assert.equal(deduplicated.response.status, 201, deduplicated.bytes.toString());
    assert.equal(deduplicated.body.id, sample.id);
    const changedReplay = await f.upload(Buffer.concat([sample.bytes, Buffer.from([1])]), `upload-${sample.filename}`, sample.filename, token.token);
    assert.equal(changedReplay.response.status, 409, changedReplay.bytes.toString());

    for (const media of saved) {
      const path = `/api/authoring/media/${encodeURIComponent(media.id)}`;
      const read = await f.requestBytes(path, {headers: {Authorization: `Bearer ${token.token}`}, noOrigin: true});
      assert.equal(read.response.status, 200);
      assert.equal(read.response.headers.get('content-type'), media.mime);
      assert.deepEqual(read.bytes, media.bytes);
      const head = await f.requestBytes(path, {method: 'HEAD', headers: {Authorization: `Bearer ${token.token}`}, noOrigin: true});
      assert.equal(head.response.status, 200);
      assert.equal(Number(head.response.headers.get('content-length')), media.bytes.length);
      const range = await f.requestBytes(path, {method: 'GET', headers: {Authorization: `Bearer ${token.token}`, Range: 'bytes=0-2'}, noOrigin: true});
      assert.equal(range.response.status, 206);
      assert.equal(range.response.headers.get('content-range'), `bytes 0-2/${media.bytes.length}`);
      assert.deepEqual(range.bytes.subarray(0, 3), media.bytes.subarray(0, 3));
    }
    const hidden = await f.request(`/api/authoring/media/${encodeURIComponent(sample.id)}`, {headers: {Authorization: `Bearer ${otherToken.token}`}, noOrigin: true});
    assert.equal(hidden.response.status, 404);
    const noBearer = await f.request(`/api/authoring/media/${encodeURIComponent(sample.id)}`);
    assert.equal(noBearer.response.status, 401);

    await f.restart();
    const replayAfterRestart = await f.upload(sample.bytes, `upload-${sample.filename}`, sample.filename, token.token);
    assert.equal(replayAfterRestart.response.status, 201, replayAfterRestart.bytes.toString());
    assert.equal(replayAfterRestart.body.id, sample.id);
    const db = f.database();
    try { assert.equal((db.prepare('SELECT count(*) AS n FROM imported_media').get() as {n: number}).n, saved.length); }
    finally { db.close(); }
  } finally { await f.close(); }
});

test('media upload validates signatures and limits and attachments reject wrong-kind or foreign IDs', async () => {
  const f = await fixture();
  try {
    const owner = await f.register('owner@example.com');
    const other = await f.register('other@example.com');
    const token = await f.createToken(owner.cookie);
    const otherToken = await f.createToken(other.cookie);
    const count = () => {
      const db = f.database();
      try { return (db.prepare('SELECT count(*) AS n FROM imported_media').get() as {n: number}).n; }
      finally { db.close(); }
    };
    const before = count();
    const mismatched = await f.upload(Buffer.from('not a png'), 'invalid-signature-1', 'bad.png', token.token);
    assert(mismatched.response.status >= 400, mismatched.bytes.toString());
    const unsupported = await f.upload(Buffer.from('anything'), 'unsupported-type-1', 'word.pdf', token.token);
    assert(unsupported.response.status >= 400, unsupported.bytes.toString());
    const oversized = await f.upload(Buffer.concat([samples()[0].bytes, Buffer.alloc(512 * 1024 - samples()[0].bytes.length + 1)]),
      'oversized-image-1', 'large.png', token.token);
    assert.equal(oversized.response.status, 413, oversized.bytes.toString());
    const unauthorized = await f.upload(samples()[0].bytes, 'anonymous-media-1', 'image.png');
    assert.equal(unauthorized.response.status, 401, unauthorized.bytes.toString());
    const wrongOrigin = await f.upload(samples()[0].bytes, 'foreign-origin-media-1', 'image.png', token.token, 'https://attacker.example');
    assert.equal(wrongOrigin.response.status, 403, wrongOrigin.bytes.toString());
    assert.equal(count(), before);
    const maxSize = await f.upload(Buffer.concat([samples()[0].bytes, Buffer.alloc(512 * 1024 - samples()[0].bytes.length)]),
      'maximum-size-image-1', 'max.png', token.token);
    assert.equal(maxSize.response.status, 201, maxSize.bytes.toString());
    assert.equal(maxSize.body.size, 512 * 1024);

    const image = await f.upload(samples()[0].bytes, 'owner-image-1', 'image.png', token.token);
    assert.equal(image.response.status, 201, image.bytes.toString());
    const audio = await f.upload(samples()[3].bytes, 'owner-audio-1', 'audio.mp3', token.token);
    assert.equal(audio.response.status, 201, audio.bytes.toString());
    const otherImage = await f.upload(samples()[0].bytes, 'other-image-1', 'image.png', otherToken.token);
    assert.equal(otherImage.response.status, 201, otherImage.bytes.toString());
    const deck = await f.createDeck(owner.cookie, token.token);
    const crossOperation = await f.upload(samples()[0].bytes, 'create-media-set-1', 'image.png', token.token);
    assert.equal(crossOperation.response.status, 409, crossOperation.bytes.toString());
    const created = await f.request(`/api/authoring/decks/${deck.id}/words`, {headers: {Authorization: `Bearer ${token.token}`}, body: {
      requestId: 'media-attachment-word-1', revision: deck.revision, words: [{term: 'book', meaning: 'libro', imageMediaId: image.body.id}]}});
    assert.equal(created.response.status, 200, created.text);
    const word = created.body.words[0];
    assert(word.image.endsWith(`/${image.body.id}`));
    assert.equal(word.audio, null);
    const wrongKind = await f.request(`/api/authoring/decks/${deck.id}/words`, {headers: {Authorization: `Bearer ${token.token}`}, body: {
      requestId: 'media-wrong-kind-1', revision: created.body.revision, words: [{id: word.id, term: word.term, meaning: word.meaning, audioMediaId: image.body.id}]}});
    assert(wrongKind.response.status >= 400, wrongKind.text);
    const foreignMedia = await f.request(`/api/authoring/decks/${deck.id}/words`, {headers: {Authorization: `Bearer ${token.token}`}, body: {
      requestId: 'media-foreign-owner-1', revision: created.body.revision, words: [{id: word.id, term: word.term, meaning: word.meaning, imageMediaId: otherImage.body.id}]}});
    assert.equal(foreignMedia.response.status, 404, foreignMedia.text);
    const unchanged = await f.request(`/api/authoring/decks/${deck.id}`, {headers: {Authorization: `Bearer ${token.token}`}});
    assert.equal(unchanged.body.deck.revision, created.body.revision);
    assert.equal(unchanged.body.deck.words[0].image, word.image);
    assert.equal(unchanged.body.deck.words[0].audio, null);
  } finally { await f.close(); }
});

test('interrupted, expired-token, revoked-token, and timed-out streams do not commit media', async () => {
  const f = await fixture();
  try {
    const owner = await f.register('owner@example.com');
    const token = await f.createToken(owner.cookie);
    const image = samples()[0];
    const count = () => {
      const db = f.database();
      try { return (db.prepare('SELECT count(*) AS n FROM imported_media').get() as {n: number}).n; }
      finally { db.close(); }
    };
    const before = count();
    const streamHeaders = (requestId: string, bearer: string) => ({Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/octet-stream', 'X-Request-Id': requestId, 'X-Media-Filename': image.filename || 'image.png'});

    const interrupted = f.streamUpload(streamHeaders('interrupted-media-1', token.token), image.bytes.subarray(0, 4));
    await new Promise(resolve => setTimeout(resolve, 50));
    interrupted.request.destroy();
    await interrupted.result;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(count(), before);

    const revoked = f.streamUpload(streamHeaders('revoked-during-media-1', token.token), image.bytes.subarray(0, 4));
    await new Promise(resolve => setTimeout(resolve, 50));
    const revoke = await f.request(`/api/account/tokens/${encodeURIComponent(token.id)}/revoke`, {cookie: owner.cookie, body: {}});
    assert.equal(revoke.response.status, 200, revoke.text);
    revoked.request.end(image.bytes.subarray(4));
    const revokedResult = await revoked.result;
    assert.equal(revokedResult.status, 401, revokedResult.bytes.toString());
    assert.equal(count(), before);

    const expiring = await f.createToken(owner.cookie, 'expiring uploader');
    const expired = f.streamUpload(streamHeaders('expired-during-media-1', expiring.token), image.bytes.subarray(0, 4));
    await new Promise(resolve => setTimeout(resolve, 50));
    f.elapse(90 * 24 * 60 * 60 * 1000);
    expired.request.end(image.bytes.subarray(4));
    const expiredResult = await expired.result;
    assert.equal(expiredResult.status, 401, expiredResult.bytes.toString());
    assert.equal(count(), before);

    const login = await f.request('/api/auth/login', {body: {email: owner.user.email, password}});
    assert.equal(login.response.status, 200, login.text);
    const cookie = login.response.headers.get('set-cookie')!.split(';')[0];
    const slowToken = await f.createToken(cookie, 'slow uploader');
    const slow = f.streamUpload(streamHeaders('slow-media-1', slowToken.token), image.bytes.subarray(0, 4));
    const timeout = await slow.result;
    assert(timeout.status === 408 || timeout.status === 413, timeout.bytes.toString());
    slow.request.destroy();
    assert.equal(count(), before);
  } finally { await f.close(); }
});
