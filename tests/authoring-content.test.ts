import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {createApplication} from '../server/app';

const origin = 'http://127.0.0.1:4173';
const password = 'authoring content fixture password';
const content = {uiLanguage: 'en', decks: []};

async function fixture(options: {now?: () => number} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-authoring-content-'));
  const databasePath = join(directory, 'app.sqlite');
  let app: ReturnType<typeof createApplication>;
  let base = '';
  async function start() {
    app = createApplication({databasePath, content, origin, registration: 'open', ...(options.now ? {now: options.now} : {})});
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
  async function register(email: string) {
    const result = await request('/api/auth/register', {body: {email, password}});
    assert.equal(result.response.status, 201, result.text);
    return {cookie: result.response.headers.get('set-cookie')!.split(';')[0], user: result.body.user};
  }
  async function createToken(cookie: string, name = 'authoring fixture') {
    const result = await request('/api/account/tokens', {cookie, body: {name, currentPassword: password}});
    assert.equal(result.response.status, 201, result.text);
    return result.body as {id: string; token: string};
  }
  async function createDeck(cookie: string, token: string, requestId = 'create-content-set-1') {
    const body = {requestId, title: 'Content fixture', termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr'};
    const result = await request('/api/authoring/decks', {cookie, headers: {Authorization: `Bearer ${token}`}, body});
    assert.equal(result.response.status, 201, result.text);
    return result.body.deck as {id: string; revision: number};
  }
  const database = () => new DatabaseSync(databasePath);
  return {request, register, createToken, createDeck, database, async restart() { await app.close(); await start(); }, async close() {
    await app.close();
    await rm(directory, {recursive: true, force: true});
  }};
}

function seedMedia(db: DatabaseSync, ownerId: string) {
  const insert = db.prepare('INSERT INTO imported_media VALUES (?,?,?,?,?,?)');
  insert.run('image-one', ownerId, 'image-hash-one', 'image/png', 8, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  insert.run('image-two', ownerId, 'image-hash-two', 'image/jpeg', 4, Buffer.from([255, 216, 255, 0]));
  insert.run('audio-one', ownerId, 'audio-hash-one', 'audio/mpeg', 4, Buffer.from('ID3\0'));
}

function fourWords() {
  return [
    {term: 'book', meaning: 'livre', imageMediaId: 'image-one', audioMediaId: 'audio-one'},
    {term: 'water', meaning: 'agua', imageMediaId: 'image-one', audioMediaId: 'audio-one'},
    {term: 'bread', meaning: 'pan', imageMediaId: 'image-one', audioMediaId: 'audio-one'},
    {term: 'flower', meaning: 'flor', imageMediaId: 'image-one', audioMediaId: 'audio-one'}
  ];
}

test('word batches add and update stable words atomically while omitted media is preserved and null clears it', async () => {
  const f = await fixture();
  try {
    const owner = await f.register('owner@example.com');
    const other = await f.register('other@example.com');
    const token = await f.createToken(owner.cookie);
    const otherToken = await f.createToken(other.cookie);
    const deck = await f.createDeck(owner.cookie, token.token);
    const otherDeck = await f.createDeck(other.cookie, otherToken.token, 'create-other-content-set');
    const seedDb = f.database();
    try { seedMedia(seedDb, owner.user.id); } finally { seedDb.close(); }

    const created = await f.request(`/api/authoring/decks/${deck.id}/words`, {
      headers: {Authorization: `Bearer ${token.token}`}, body: {requestId: 'batch-add-content-1', revision: deck.revision, words: fourWords()}});
    assert.equal(created.response.status, 200, created.text);
    assert.equal(created.body.deckId, deck.id);
    assert.equal(created.body.revision, deck.revision + 1);
    assert.equal(created.body.words.length, 4);
    const ids = created.body.words.map((word: {id: string}) => word.id);
    assert.equal(new Set(ids).size, 4);
    assert(created.body.words.every((word: {image: string | null; audio: string | null}) => word.image?.endsWith('/image-one') && word.audio?.endsWith('/audio-one')));

    const secondSet = await f.request(`/api/authoring/decks/${otherDeck.id}/words`, {
      headers: {Authorization: `Bearer ${otherToken.token}`}, body: {requestId: 'batch-add-other-1', revision: otherDeck.revision, words: [{term: 'one', meaning: 'uno'}]}});
    assert.equal(secondSet.response.status, 200, secondSet.text);
    const foreignId = secondSet.body.words[0].id as string;

    const updateBody = {requestId: 'batch-update-content-1', revision: created.body.revision, words: [
      {id: ids[0], term: 'the book', meaning: 'le livre'},
      {id: ids[1], term: 'fresh water', meaning: 'agua fresca', imageMediaId: null}
    ]};
    const updated = await f.request(`/api/authoring/decks/${deck.id}/words`, {
      headers: {Authorization: `Bearer ${token.token}`}, body: updateBody});
    assert.equal(updated.response.status, 200, updated.text);
    assert.equal(updated.body.revision, created.body.revision + 1);
    assert.equal(updated.body.words.length, 2);
    assert.equal(updated.body.words[0].id, ids[0]);
    assert.equal(updated.body.words[0].term, 'the book');
    assert(updated.body.words[0].image.endsWith('/image-one'));
    assert(updated.body.words[0].audio.endsWith('/audio-one'));
    assert.equal(updated.body.words[1].image, null);
    assert(updated.body.words[1].audio.endsWith('/audio-one'));

    const reordered = {words: [{meaning: 'le livre', id: ids[0], term: 'the book'}, {imageMediaId: null, meaning: 'agua fresca', id: ids[1], term: 'fresh water'}],
      revision: updateBody.revision, requestId: updateBody.requestId};
    const replay = await f.request(`/api/authoring/decks/${deck.id}/words`, {
      headers: {Authorization: `Bearer ${token.token}`}, body: reordered});
    assert.equal(replay.response.status, 200, replay.text);
    assert.deepEqual(replay.body, updated.body);
    const changed = await f.request(`/api/authoring/decks/${deck.id}/words`, {
      headers: {Authorization: `Bearer ${token.token}`}, body: {...updateBody, words: [{...updateBody.words[0], meaning: 'changed'}]}});
    assert.equal(changed.response.status, 409, changed.text);

    const foreign = await f.request(`/api/authoring/decks/${deck.id}/words`, {
      headers: {Authorization: `Bearer ${token.token}`}, body: {requestId: 'batch-foreign-content-1', revision: updated.body.revision,
        words: [{id: foreignId, term: 'intruder', meaning: 'intruder'}]}});
    assert.equal(foreign.response.status, 404, foreign.text);
    const unknown = await f.request(`/api/authoring/decks/${deck.id}/words`, {
      headers: {Authorization: `Bearer ${token.token}`}, body: {requestId: 'batch-unknown-content-1', revision: updated.body.revision,
        words: [{id: 'missing-word-id', term: 'unknown', meaning: 'unknown'}]}});
    assert.equal(unknown.response.status, 404, unknown.text);
    const duplicate = await f.request(`/api/authoring/decks/${deck.id}/words`, {
      headers: {Authorization: `Bearer ${token.token}`}, body: {requestId: 'batch-duplicate-content-1', revision: updated.body.revision,
        words: [{id: ids[2], term: 'changed once', meaning: 'first'}, {id: ids[2], term: 'changed twice', meaning: 'second'}]}});
    assert.equal(duplicate.response.status, 400, duplicate.text);
    const missingText = await f.request(`/api/authoring/decks/${deck.id}/words`, {
      headers: {Authorization: `Bearer ${token.token}`}, body: {requestId: 'batch-missing-text-1', revision: updated.body.revision,
        words: [{id: ids[2], term: 'translation missing'}]}});
    assert.equal(missingText.response.status, 400, missingText.text);
    const current = await f.request(`/api/authoring/decks/${deck.id}`, {headers: {Authorization: `Bearer ${token.token}`}});
    assert.equal(current.body.deck.revision, updated.body.revision);
    assert.deepEqual(current.body.deck.words.map((word: {id: string}) => word.id), ids);
    assert.equal(current.body.deck.words[2].term, 'bread');
    assert.equal(current.body.deck.words[2].meaning, 'pan');
  } finally { await f.close(); }
});

test('batches reject stale revisions and fail without partial writes, including competing writers', async () => {
  const f = await fixture();
  try {
    const owner = await f.register('owner@example.com');
    const token = await f.createToken(owner.cookie);
    const deck = await f.createDeck(owner.cookie, token.token);
    const headers = {Authorization: `Bearer ${token.token}`};
    const initial = await f.request(`/api/authoring/decks/${deck.id}/words`, {headers, body: {
      requestId: 'batch-add-atomic-1', revision: 1, words: [{term: 'first', meaning: 'uno'}, {term: 'second', meaning: 'dos'}]}});
    assert.equal(initial.response.status, 200, initial.text);
    const before = initial.body.revision;

    const partial = await f.request(`/api/authoring/decks/${deck.id}/words`, {headers, body: {
      requestId: 'batch-partial-rollback-1', revision: before, words: [{term: 'must roll back', meaning: 'no write'}, {id: 'unknown-word', term: 'bad', meaning: 'bad'}]}});
    assert.equal(partial.response.status, 404, partial.text);
    const duplicate = await f.request(`/api/authoring/decks/${deck.id}/words`, {headers, body: {
      requestId: 'batch-add-atomic-1', revision: before, words: [{term: 'same request id', meaning: 'one'}, {term: 'later', meaning: 'two'}]}});
    assert.equal(duplicate.response.status, 409, duplicate.text);
    const stale = await f.request(`/api/authoring/decks/${deck.id}/words`, {headers, body: {
      requestId: 'batch-stale-revision-1', revision: before - 1, words: [{term: 'stale', meaning: 'no write'}]}});
    assert.equal(stale.response.status, 409, stale.text);

    const current = await f.request(`/api/authoring/decks/${deck.id}`, {headers});
    assert.equal(current.body.deck.revision, before);
    assert.equal(current.body.deck.words.length, 2);
    assert(!current.body.deck.words.some((word: {term: string}) => ['must roll back', 'same request id', 'stale'].includes(word.term)));

    const competing = await Promise.all(['a', 'b'].map(suffix => f.request(`/api/authoring/decks/${deck.id}/words`, {headers, body: {
      requestId: `batch-competing-${suffix}`, revision: before, words: [{term: `winner ${suffix}`, meaning: 'uno'}]}})));
    assert.deepEqual(competing.map(result => result.response.status).sort(), [200, 409]);
    const afterRace = await f.request(`/api/authoring/decks/${deck.id}`, {headers});
    assert.equal(afterRace.body.deck.words.length, 3);
    assert.equal(afterRace.body.deck.revision, before + 1);
  } finally { await f.close(); }
});

test('batch and effective deck limits reject the whole write', async () => {
  const f = await fixture();
  try {
    const owner = await f.register('limits@example.com');
    const token = await f.createToken(owner.cookie);
    const deck = await f.createDeck(owner.cookie, token.token);
    const headers = {Authorization: `Bearer ${token.token}`};
    const oversizedBatch = Array.from({length: 101}, (_, index) => ({term: `${index}-` + 't'.repeat(1990), meaning: 'm'.repeat(1990)}));
    const tooMany = await f.request(`/api/authoring/decks/${deck.id}/words`, {headers, body: {
      requestId: 'batch-too-many-1', revision: deck.revision, words: oversizedBatch}});
    assert(tooMany.response.status >= 400, tooMany.text);
    let current = await f.request(`/api/authoring/decks/${deck.id}`, {headers});
    assert.equal(current.body.deck.revision, deck.revision);
    assert.equal(current.body.deck.words.length, 0);

    const largeWords = (start: number) => Array.from({length: 100}, (_, index) => ({term: `${start + index}-` + 't'.repeat(1990), meaning: 'm'.repeat(1990)}));
    const first = await f.request(`/api/authoring/decks/${deck.id}/words`, {headers, body: {
      requestId: 'batch-large-a', revision: current.body.deck.revision, words: largeWords(0)}});
    assert.equal(first.response.status, 200, first.text);
    const second = await f.request(`/api/authoring/decks/${deck.id}/words`, {headers, body: {
      requestId: 'batch-large-b', revision: first.body.revision, words: largeWords(100)}});
    assert.equal(second.response.status, 200, second.text);
    const tooLarge = await f.request(`/api/authoring/decks/${deck.id}/words`, {headers, body: {
      requestId: 'batch-large-c', revision: second.body.revision, words: largeWords(200)}});
    assert(tooLarge.response.status >= 400, tooLarge.text);
    current = await f.request(`/api/authoring/decks/${deck.id}`, {headers});
    assert.equal(current.body.deck.revision, second.body.revision);
    assert.equal(current.body.deck.words.length, 200);
  } finally { await f.close(); }
});

test('word text changes are visible after browser and API edits and old lesson answers do not reschedule changed words', async () => {
  const instant = 1_700_000_000_000;
  const f = await fixture({now: () => instant});
  try {
    const owner = await f.register('review@example.com');
    const token = await f.createToken(owner.cookie);
    const deck = await f.createDeck(owner.cookie, token.token);
    const headers = {Authorization: `Bearer ${token.token}`};
    const seedDb = f.database();
    try { seedMedia(seedDb, owner.user.id); } finally { seedDb.close(); }
    const added = await f.request(`/api/authoring/decks/${deck.id}/words`, {headers, body: {
      requestId: 'batch-review-add-1', revision: deck.revision, words: fourWords()}});
    assert.equal(added.response.status, 200, added.text);

    const browserEdit = await f.request(`/api/decks/${deck.id}/words/${added.body.words[0].id}/edit`, {cookie: owner.cookie, body: {
      term: 'browser edit', meaning: 'browser meaning', revision: added.body.revision, requestId: 'browser-edit-authored-word'}});
    assert.equal(browserEdit.response.status, 200, browserEdit.text);
    const apiEdit = await f.request(`/api/authoring/decks/${deck.id}/words`, {headers, body: {
      requestId: 'batch-after-browser-edit', revision: browserEdit.body.revision,
      words: [{id: added.body.words[0].id, term: 'api edit', meaning: 'api meaning'}]}});
    assert.equal(apiEdit.response.status, 200, apiEdit.text);
    const visible = await f.request(`/api/authoring/decks/${deck.id}`, {headers});
    assert.equal(visible.body.deck.words[0].term, 'api edit');
    assert.equal(visible.body.deck.words[0].meaning, 'api meaning');

    const lesson = await f.request('/api/training', {cookie: owner.cookie, body: {deckId: deck.id, mode: 'lesson', requestId: 'lesson-authored-content-1'}});
    assert.equal(lesson.response.status, 201, lesson.text);
    const attemptId = lesson.body.attempt.id as string;
    const snapshot = (await f.request(`/api/training/${attemptId}/snapshot`, {cookie: owner.cookie})).body.snapshot;
    const firstQuestion = snapshot.questions[0];
    const answered = await f.request(`/api/training/${attemptId}/answer`, {cookie: owner.cookie, body: {
      position: 0, optionId: firstQuestion.wordId, revision: lesson.body.attempt.revision, requestId: 'lesson-answer-before-authoring-1'}});
    assert.equal(answered.response.status, 200, answered.text);
    const advanced = await f.request(`/api/training/${attemptId}/advance`, {cookie: owner.cookie, body: {
      position: answered.body.attempt.position, revision: answered.body.attempt.revision, requestId: 'lesson-advance-before-authoring-1'}});
    assert.equal(advanced.response.status, 200, advanced.text);

    const db = f.database();
    const secondQuestionId = snapshot.questions[1].wordId as string;
    try {
      const scheduled = db.prepare('SELECT fingerprint, step, due_at, answered_at FROM word_reviews WHERE owner_id = ? AND deck_id = ? AND word_id = ?')
        .get(owner.user.id, deck.id, firstQuestion.wordId) as {fingerprint: string; step: number; due_at: number; answered_at: number};
      assert.equal(scheduled.step, 1);
      assert.equal(scheduled.due_at, instant + 24 * 60 * 60 * 1000);

      const firstSnapshotWord = snapshot.words.find((word: {id: string}) => word.id === firstQuestion.wordId);
      const editMedia = await f.request(`/api/authoring/decks/${deck.id}/words`, {headers, body: {
        requestId: 'batch-media-only-review-1', revision: apiEdit.body.revision,
        words: [{id: firstQuestion.wordId, term: firstSnapshotWord.term, meaning: firstSnapshotWord.meaning, imageMediaId: null}]}});
      assert.equal(editMedia.response.status, 200, editMedia.text);
      assert.deepEqual(db.prepare('SELECT fingerprint, step, due_at, answered_at FROM word_reviews WHERE owner_id = ? AND deck_id = ? AND word_id = ?')
        .get(owner.user.id, deck.id, firstQuestion.wordId), scheduled);

      const editSecond = await f.request(`/api/authoring/decks/${deck.id}/words`, {headers, body: {
        requestId: 'batch-change-text-with-old-lesson-1', revision: editMedia.body.revision,
        words: [{id: secondQuestionId, term: 'changed after snapshot', meaning: 'changed meaning'}]}});
      assert.equal(editSecond.response.status, 200, editSecond.text);
      const oldAnswer = await f.request(`/api/training/${attemptId}/answer`, {cookie: owner.cookie, body: {
        position: advanced.body.attempt.position, optionId: secondQuestionId, revision: advanced.body.attempt.revision,
        requestId: 'lesson-old-snapshot-answer-1'}});
      assert.equal(oldAnswer.response.status, 200, oldAnswer.text);
      assert.equal(db.prepare('SELECT 1 FROM word_reviews WHERE owner_id = ? AND deck_id = ? AND word_id = ?')
        .get(owner.user.id, deck.id, secondQuestionId), undefined);
      const after = (await f.request(`/api/training?deckId=${encodeURIComponent(deck.id)}`, {cookie: owner.cookie})).body.review;
      assert.equal(after.new, 3);
    } finally { db.close(); }
  } finally { await f.close(); }
});
