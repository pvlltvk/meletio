import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {createApplication} from '../server/app';

const origin = 'http://127.0.0.1:4173';
const password = 'authoring boundary fixture password';
type Options = {now?: () => number; decks?: {id: string; title: string; termLang: string; meaningLang: string; termDir: string; meaningDir: string; words: {id: string; term: string; meaning: string; image: null; audio: null}[]}[]};

async function fixture(options: Options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-authoring-boundaries-'));
  const databasePath = join(directory, 'app.sqlite');
  let app: ReturnType<typeof createApplication>;
  let base = '';
  async function start() {
    app = createApplication({databasePath, origin, content: {uiLanguage: 'en', decks: options.decks || []}, registration: 'open', ...(options.now ? {now: options.now} : {})});
    await new Promise<void>((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', resolve);
    });
    const address = app.server.address();
    assert(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
  }
  await start();
  async function request(path: string, settings: {method?: string; body?: unknown; cookie?: string; headers?: Record<string, string>; noOrigin?: boolean} = {}) {
    const method = settings.method ?? (settings.body === undefined ? 'GET' : 'POST');
    const headers: Record<string, string> = {...(method === 'POST' ? {Origin: origin, 'Content-Type': 'application/json'} : {}), ...settings.headers};
    if (settings.noOrigin) delete headers.Origin;
    if (settings.cookie) headers.Cookie = settings.cookie;
    const response = await fetch(base + path, {method, headers,
      ...(settings.body === undefined ? {} : {body: JSON.stringify(settings.body)})});
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
  async function token(cookie: string, name = 'boundary tool') {
    const result = await request('/api/account/tokens', {cookie, body: {name}});
    assert.equal(result.response.status, 201, result.text);
    return result.body as {id: string; token: string};
  }
  async function deck(cookie: string, bearer: string, requestId: string) {
    const result = await request('/api/authoring/decks', {cookie, headers: {Authorization: `Bearer ${bearer}`}, body: {
      requestId, title: 'Boundary words', termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr'}});
    assert.equal(result.response.status, 201, result.text);
    return result.body.deck as {id: string; revision: number};
  }
  async function upload(bytes: Buffer, bearer: string, requestId: string, filename: string) {
    const response = await fetch(`${base}/api/authoring/media`, {method: 'POST', headers: {'Content-Type': 'application/octet-stream',
      Authorization: `Bearer ${bearer}`, 'X-Request-Id': requestId, 'X-Media-Filename': filename}, body: new Uint8Array(bytes)});
    const text = await response.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = text; }
    return {response, body, text};
  }
  const database = () => new DatabaseSync(databasePath);
  return {request, register, token, deck, upload, database, async restart() { await app.close(); await start(); },
    async close() { await app.close(); await rm(directory, {recursive: true, force: true}); }};
}

test('native catalog filters before pagination when older Anki sets and default decks precede it', async () => {
  const decks = ['default-one', 'default-two'].map((id, index) => ({id, title: id, termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr',
    words: [{id: `${id}-word`, term: `term ${index}`, meaning: `meaning ${index}`, image: null as null, audio: null as null}]}));
  const f = await fixture({decks});
  try {
    const owner = await f.register('catalog@example.com');
    const token = await f.token(owner.cookie);
    const db = f.database();
    try {
      const insert = db.prepare('INSERT INTO imported_decks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
      for (let index = 0; index < 55; index++) {
        const id = `a-anki-${String(index).padStart(3, '0')}`;
        insert.run(id, owner.user.id, `Anki ${index}`, 'el', 'en', 'ltr', 'ltr', 1,
          JSON.stringify({sourceDeckId: String(index), noteTypeId: 'basic'}), '', 1, 1);
      }
      for (let index = 0; index < 55; index++) {
        const id = `z-native-${String(index).padStart(3, '0')}`;
        insert.run(id, owner.user.id, `Native ${index}`, 'el', 'en', 'ltr', 'ltr', 1, '{"kind":"authored"}', '', 1, 1);
      }
    } finally { db.close(); }

    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const result = await f.request(`/api/authoring/decks${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, {
        headers: {Authorization: `Bearer ${token.token}`}, noOrigin: true});
      assert.equal(result.response.status, 200, result.text);
      assert(result.body.decks.length <= 50);
      assert(result.body.decks.every((entry: {authored?: boolean; imported: boolean; id: string}) => entry.authored === true && entry.imported === false && entry.id.startsWith('z-native-')));
      ids.push(...result.body.decks.map((entry: {id: string}) => entry.id));
      cursor = result.body.nextCursor;
    } while (cursor);
    assert.equal(ids.length, 55);
    assert.equal(new Set(ids).size, 55);
  } finally { await f.close(); }
});

test('the 2000 visible-word boundary allows replacement after browser deletion but rejects updates to the deleted ID', async () => {
  const f = await fixture();
  try {
    const owner = await f.register('cap@example.com');
    const token = await f.token(owner.cookie);
    const headers = {Authorization: `Bearer ${token.token}`};
    const deck = await f.deck(owner.cookie, token.token, 'cap-set-creation-1');
    let revision = deck.revision;
    let firstWordId = '';
    for (let batch = 0; batch < 20; batch++) {
      const words = Array.from({length: 100}, (_, index) => ({term: `term-${batch}-${index}`, meaning: `meaning-${batch}-${index}`}));
      const result = await f.request(`/api/authoring/decks/${deck.id}/words`, {headers, body: {
        requestId: `fill-limit-${batch}`, revision, words}});
      assert.equal(result.response.status, 200, result.text);
      revision = result.body.revision;
      if (batch === 0) firstWordId = result.body.words[0].id;
    }
    const overflow = await f.request(`/api/authoring/decks/${deck.id}/words`, {headers, body: {
      requestId: 'visible-word-overflow-1', revision, words: [{term: 'overflow', meaning: 'overflow'}]}});
    assert.equal(overflow.response.status, 422, overflow.text);
    const full = await f.request(`/api/authoring/decks/${deck.id}`, {headers});
    assert.equal(full.body.deck.words.length, 2000);
    assert.equal(full.body.deck.revision, revision);

    const removed = await f.request(`/api/decks/${deck.id}/words/${encodeURIComponent(firstWordId)}/delete`, {cookie: owner.cookie,
      body: {revision, requestId: 'browser-delete-at-cap-1'}});
    assert.equal(removed.response.status, 200, removed.text);
    const replacement = await f.request(`/api/authoring/decks/${deck.id}/words`, {headers, body: {
      requestId: 'replacement-at-cap-1', revision: removed.body.revision, words: [{term: 'replacement', meaning: 'replacement'}]}});
    assert.equal(replacement.response.status, 200, replacement.text);
    const deletedUpdate = await f.request(`/api/authoring/decks/${deck.id}/words`, {headers, body: {
      requestId: 'update-deleted-word-1', revision: replacement.body.revision,
      words: [{id: firstWordId, term: 'revive', meaning: 'revive'}]}});
    assert.equal(deletedUpdate.response.status, 404, deletedUpdate.text);
    const after = await f.request(`/api/authoring/decks/${deck.id}`, {headers});
    assert.equal(after.body.deck.words.length, 2000);
    assert(!after.body.deck.words.some((word: {id: string}) => word.id === firstWordId));
    assert(after.body.deck.words.some((word: {term: string}) => word.term === 'replacement'));
  } finally { await f.close(); }
});

test('request IDs conflict across content operation and target namespaces without applying either write', async () => {
  const f = await fixture();
  try {
    const owner = await f.register('receipts@example.com');
    const token = await f.token(owner.cookie);
    const first = await f.deck(owner.cookie, token.token, 'shared-content-request-1');
    const second = await f.deck(owner.cookie, token.token, 'shared-other-request-1');
    const collision = await f.request(`/api/authoring/decks/${first.id}/words`, {headers: {Authorization: `Bearer ${token.token}`}, body: {
      requestId: 'shared-content-request-1', revision: first.revision, words: [{term: 'collision', meaning: 'collision'}]}});
    assert.equal(collision.response.status, 409, collision.text);
    const targetCollision = await f.request(`/api/authoring/decks/${second.id}/words`, {headers: {Authorization: `Bearer ${token.token}`}, body: {
      requestId: 'same-batch-target-1', revision: second.revision, words: [{term: 'second target', meaning: 'no write'}]}});
    assert.equal(targetCollision.response.status, 200, targetCollision.text);
    const conflictingTarget = await f.request(`/api/authoring/decks/${first.id}/words`, {headers: {Authorization: `Bearer ${token.token}`}, body: {
      requestId: 'same-batch-target-1', revision: first.revision, words: [{term: 'first target', meaning: 'no write'}]}});
    assert.equal(conflictingTarget.response.status, 409, conflictingTarget.text);
    const currentFirst = await f.request(`/api/authoring/decks/${first.id}`, {headers: {Authorization: `Bearer ${token.token}`}});
    assert.equal(currentFirst.body.deck.revision, first.revision);
    assert.deepEqual(currentFirst.body.deck.words, []);
    const deep = {requestId: 'overdeep-input-1', revision: first.revision, words: [{term: 'x', meaning: 'y', nested: {a: {b: {c: {d: {e: {f: {g: {h: 1}}}}}}}}}]};
    const invalid = await f.request(`/api/authoring/decks/${first.id}/words`, {headers: {Authorization: `Bearer ${token.token}`}, body: deep});
    assert.equal(invalid.response.status, 400, invalid.text);
  } finally { await f.close(); }
});

test('a long-lived bearer works after the browser session expires, then expires and is revoked on password change', async () => {
  let instant = 1_700_000_000_000;
  const f = await fixture({now: () => instant});
  try {
    const owner = await f.register('expiry@example.com');
    const token = await f.token(owner.cookie, 'long-lived');
    instant += 31 * 24 * 60 * 60 * 1000;
    const expiredCookie = await f.request('/api/authoring/decks');
    assert.equal(expiredCookie.response.status, 401);
    const bearerStillWorks = await f.request('/api/authoring/decks', {headers: {Authorization: `Bearer ${token.token}`}, noOrigin: true});
    assert.equal(bearerStillWorks.response.status, 200, bearerStillWorks.text);
    instant += 59 * 24 * 60 * 60 * 1000;
    const bearerExpired = await f.request('/api/authoring/decks', {headers: {Authorization: `Bearer ${token.token}`}, noOrigin: true});
    assert.equal(bearerExpired.response.status, 401, bearerExpired.text);

    const login = await f.request('/api/auth/login', {body: {email: owner.user.email, password}});
    assert.equal(login.response.status, 200, login.text);
    const cookie = login.response.headers.get('set-cookie')!.split(';')[0];
    const replacement = await f.token(cookie, 'revoke-on-password-change');
    const changed = await f.request('/api/account/password', {cookie, body: {currentPassword: password, newPassword: 'new password after expiry'}});
    assert.equal(changed.response.status, 200, changed.text);
    const afterPasswordChange = await f.request('/api/authoring/decks', {headers: {Authorization: `Bearer ${replacement.token}`}, noOrigin: true});
    assert.equal(afterPasswordChange.response.status, 401, afterPasswordChange.text);
  } finally { await f.close(); }
});

test('a 512 KiB upload replays after other writes and restart without duplicate media or receipts', async () => {
  const f = await fixture();
  try {
    const owner = await f.register('media-boundary@example.com');
    const other = await f.register('media-other@example.com');
    const token = await f.token(owner.cookie);
    const otherToken = await f.token(other.cookie);
    const prefix = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const bytes = Buffer.concat([prefix, Buffer.alloc(512 * 1024 - prefix.length)]);
    const requestId = 'same-owner-512k-upload-1';
    const stored = await f.upload(bytes, token.token, requestId, 'maximum.png');
    assert.equal(stored.response.status, 201, stored.text);
    assert.equal(stored.body.size, 512 * 1024);
    const replay = await f.upload(bytes, token.token, requestId, 'maximum.png');
    assert.equal(replay.response.status, 201, replay.text);
    assert.equal(replay.body.id, stored.body.id);

    const beforeFailures = f.database();
    let priorReceipts: number;
    try {
      assert.equal((beforeFailures.prepare('SELECT count(*) AS n FROM imported_media WHERE owner_id = ?').get(owner.user.id) as {n: number}).n, 1);
      priorReceipts = (beforeFailures.prepare('SELECT count(*) AS n FROM content_mutations WHERE owner_id = ?').get(owner.user.id) as {n: number}).n;
    } finally { beforeFailures.close(); }
    const changedFilename = await f.upload(bytes, token.token, requestId, 'renamed.png');
    assert.equal(changedFilename.response.status, 409, changedFilename.text);
    const wrongOperation = await f.request('/api/authoring/decks', {cookie: owner.cookie,
      headers: {Authorization: `Bearer ${token.token}`}, body: {requestId, title: 'Wrong operation', termLang: 'el',
        meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr'}});
    assert.equal(wrongOperation.response.status, 409, wrongOperation.text);
    const afterFailures = f.database();
    try {
      assert.equal((afterFailures.prepare('SELECT count(*) AS n FROM imported_media WHERE owner_id = ?').get(owner.user.id) as {n: number}).n, 1);
      assert.equal((afterFailures.prepare('SELECT count(*) AS n FROM content_mutations WHERE owner_id = ?').get(owner.user.id) as {n: number}).n, priorReceipts);
    } finally { afterFailures.close(); }

    const duplicateBytes = await f.upload(bytes, token.token, 'same-bytes-new-request-1', 'maximum.png');
    assert.equal(duplicateBytes.response.status, 201, duplicateBytes.text);
    assert.equal(duplicateBytes.body.id, stored.body.id);
    const otherOwner = await f.upload(bytes, otherToken.token, 'other-owner-same-bytes-1', 'maximum.png');
    assert.equal(otherOwner.response.status, 201, otherOwner.text);
    assert.notEqual(otherOwner.body.id, stored.body.id);
    const secondOwnerWrite = await f.deck(owner.cookie, token.token, 'unrelated-set-write-1');
    assert(secondOwnerWrite.id);
    const replayAfterOtherWrite = await f.upload(bytes, token.token, requestId, 'maximum.png');
    assert.equal(replayAfterOtherWrite.response.status, 201, replayAfterOtherWrite.text);
    assert.equal(replayAfterOtherWrite.body.id, stored.body.id);

    const beforeRestart = f.database();
    let receiptsBeforeRestart: number;
    try { receiptsBeforeRestart = (beforeRestart.prepare('SELECT count(*) AS n FROM content_mutations WHERE owner_id = ?').get(owner.user.id) as {n: number}).n; }
    finally { beforeRestart.close(); }
    await f.restart();
    const replayAfterRestart = await f.upload(bytes, token.token, requestId, 'maximum.png');
    assert.equal(replayAfterRestart.response.status, 201, replayAfterRestart.text);
    assert.equal(replayAfterRestart.body.id, stored.body.id);
    const afterRestart = f.database();
    try {
      assert.equal((afterRestart.prepare('SELECT count(*) AS n FROM imported_media WHERE owner_id = ?').get(owner.user.id) as {n: number}).n, 1);
      assert.equal((afterRestart.prepare('SELECT count(*) AS n FROM content_mutations WHERE owner_id = ?').get(owner.user.id) as {n: number}).n, receiptsBeforeRestart);
    } finally { afterRestart.close(); }
  } finally { await f.close(); }
});
