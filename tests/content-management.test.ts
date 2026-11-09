import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createApplication} from '../server/app';
import {makePackage, type SourceNote} from './helpers/anki-package';

const origin = 'http://127.0.0.1:4173';
const content = {uiLanguage: 'en', decks: [{id: 'demo', title: 'Demo', termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr',
  words: Array.from({length: 4}, (_, i) => ({id: String(i), term: `demo ${i}`, meaning: `sample ${i}`, image: null, audio: null}))}]};
const notes = (modified = 100): SourceNote[] => Array.from({length: 4}, (_, i) => ({guid: `source-${i}`, modified, fields: [`term ${i}`, `meaning ${i}`, '']}));

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-content-'));
  const databasePath = join(directory, 'app.sqlite');
  let app: ReturnType<typeof createApplication>; let base = '';
  async function open() {
    app = createApplication({databasePath, content, origin});
    await new Promise<void>((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
    const address = app.server.address(); assert(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
  }
  await open();
  async function request(path: string, body?: unknown, cookie?: string, method = body === undefined ? 'GET' : 'POST', extraHeaders: Record<string, string> = {}) {
    const response = await fetch(base + path, {method, headers: {Origin: origin, ...(cookie ? {Cookie: cookie} : {}), ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...extraHeaders},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    let result: any; try { result = await response.json(); } catch { result = {}; }
    return {response, body: result};
  }
  async function register(email = 'owner@example.com') {
    const result = await request('/api/auth/register', {email, password: 'private fixture password'});
    assert(result.response.ok, JSON.stringify(result.body));
    return result.response.headers.get('set-cookie')!.split(';')[0];
  }
  async function importNotes(cookie: string, sourceNotes: SourceNote[], destinationDeckId?: string, replaceLocalChanges?: boolean, acceptSkipped = false) {
    const source = await mkdtemp(join(directory, 'source-'));
    const bytes = (await makePackage(source, {notes: sourceNotes, media: {}})).bytes;
    const upload = await fetch(base + '/api/imports/uploads', {method: 'POST', headers: {Origin: origin, Cookie: cookie, 'Content-Type': 'application/octet-stream', 'X-Import-Request-Id': randomUUID(), 'X-Import-Filename': 'synthetic.apkg'}, body: new Uint8Array(bytes)});
    const stage: any = await upload.json(); assert(upload.ok, JSON.stringify(stage));
    const previewResponse = await request(`/api/imports/${stage.uploadId}/preview`, {sourceDeckId: '1', noteTypeId: '100', includeChildren: false,
      mapping: {term: 'Term', meaning: 'Meaning', image: null, audio: null}, title: 'Synthetic', termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr',
      ...(destinationDeckId ? {destinationDeckId} : {}), ...(replaceLocalChanges === undefined ? {} : {replaceLocalChanges})}, cookie);
    assert(previewResponse.response.ok, JSON.stringify(previewResponse.body));
    const preview = previewResponse.body;
    const commit = await request(`/api/imports/${stage.uploadId}/commit`, {previewId: previewResponse.body.previewId, requestId: randomUUID(), acceptSkipped}, cookie);
    assert(commit.response.ok, JSON.stringify(commit.body));
    return {deckId: commit.body.deckId as string, preview};
  }
  async function imported(cookie: string) { return (await importNotes(cookie, notes())).deckId; }
  return {directory, get app() { return app; }, request, register, imported, importNotes, async restart() { await app.close(); await open(); }, async close() { await app.close(); await rm(directory, {recursive: true, force: true}); }};
}

test('word edit and delete are owner scoped, revision checked, idempotent, and survive restart', async () => {
  const f = await fixture();
  try {
    const cookie = await f.register(); const deckId = await f.imported(cookie);
    const initial = (await f.request(`/api/decks/${deckId}`, undefined, cookie)).body.deck;
    const word = initial.words[0]; const requestId = randomUUID();
    const edited = await f.request(`/api/decks/${deckId}/words/${word.id}/edit`, {term: 'local term', meaning: 'local meaning', revision: initial.revision, requestId}, cookie);
    assert.equal(edited.response.status, 200); assert.equal(edited.body.word.term, 'local term');
    const replay = await f.request(`/api/decks/${deckId}/words/${word.id}/edit`, {term: 'local term', meaning: 'local meaning', revision: initial.revision, requestId}, cookie);
    assert.deepEqual(replay.body, edited.body);
    assert.equal((await f.request(`/api/decks/${deckId}/words/${word.id}/edit`, {term: 'other', meaning: 'local meaning', revision: initial.revision, requestId}, cookie)).response.status, 409);
    const stale = await f.request(`/api/decks/${deckId}/words/${word.id}/delete`, {revision: initial.revision, requestId: randomUUID()}, cookie);
    assert.equal(stale.response.status, 409);
    const deletion = {revision: edited.body.revision, requestId: randomUUID()};
    const deleted = await f.request(`/api/decks/${deckId}/words/${word.id}/delete`, deletion, cookie);
    assert.equal(deleted.response.status, 200); assert.equal(deleted.body.deleted, true);
    await f.restart();
    const restarted = await f.request(`/api/decks/${deckId}`, undefined, cookie);
    assert(!restarted.body.deck.words.some((entry: any) => entry.id === word.id));
    assert.equal(restarted.body.deck.words.find((entry: any) => entry.id === initial.words[1].id).term, initial.words[1].term);
  } finally { await f.close(); }
});

test('renamed and deleted imported sets are owner checked while default renames stay private', async () => {
  const f = await fixture();
  try {
    const cookie = await f.register(); const other = await f.register('other@example.com'); const deckId = await f.imported(cookie);
    const initial = (await f.request(`/api/decks/${deckId}`, undefined, cookie)).body.deck;
    const wordId = initial.words[0].id;
    for (const [path, body] of [
      [`/api/decks/${deckId}/rename`, {title: 'Intruder name', revision: initial.revision, requestId: randomUUID()}],
      [`/api/decks/${deckId}/delete`, {revision: initial.revision, requestId: randomUUID()}],
      [`/api/decks/${deckId}/words/${wordId}/edit`, {term: 'intruder', meaning: 'intruder', revision: initial.revision, requestId: randomUUID()}],
      [`/api/decks/${deckId}/words/${wordId}/delete`, {revision: initial.revision, requestId: randomUUID()}],
    ] as const) assert.equal((await f.request(path, body, other)).response.status, 404);
    const crossOrigin = await f.request(`/api/decks/${deckId}/words/${wordId}/edit`,
      {term: 'cross origin', meaning: 'blocked', revision: initial.revision, requestId: randomUUID()}, cookie, 'POST', {Origin: 'https://attacker.example'});
    assert.notEqual(crossOrigin.response.status, 200);
    const renamed = await f.request(`/api/decks/${deckId}/rename`, {title: 'My words', revision: initial.revision, requestId: randomUUID()}, cookie);
    assert.equal(renamed.response.status, 200); assert.equal(renamed.body.deckId, deckId); assert.equal(renamed.body.revision, initial.revision + 1);
    const removed = await f.request(`/api/decks/${deckId}/delete`, {revision: renamed.body.revision, requestId: randomUUID()}, cookie);
    assert.equal(removed.response.status, 200); assert.equal(removed.body.deleted, true);
    assert.equal((await f.request(`/api/decks/${deckId}`, undefined, cookie)).response.status, 404);
    const demo = await f.request('/api/decks/demo/rename', {title: 'Changed', revision: 1, requestId: randomUUID()}, cookie);
    assert.equal(demo.response.status, 200);
    assert.equal((await f.request('/api/decks/demo', undefined, cookie)).body.deck.title, 'Changed');
    assert.notEqual((await f.request('/api/decks/demo', undefined, other)).body.deck.title, 'Changed');
  } finally { await f.close(); }
});

test('local word edits and deletions survive a newer import unless replacement is explicitly selected', async () => {
  const f = await fixture();
  try {
    const owner = await f.register(); const other = await f.register('other@example.com'); const deckId = await f.imported(owner);
    let deck = (await f.request(`/api/decks/${deckId}`, undefined, owner)).body.deck;
    const editedWord = deck.words[0]; const deletedWord = deck.words[1];
    const edit = await f.request(`/api/decks/${deckId}/words/${editedWord.id}/edit`, {term: 'local term', meaning: 'local meaning', revision: deck.revision, requestId: randomUUID()}, owner);
    assert.equal(edit.response.status, 200);
    const removed = await f.request(`/api/decks/${deckId}/words/${deletedWord.id}/delete`, {revision: edit.body.revision, requestId: randomUUID()}, owner);
    assert.equal(removed.response.status, 200);
    const forbidden = await f.request(`/api/decks/${deckId}/words/${editedWord.id}/edit`, {term: 'intruder', meaning: 'intruder', revision: removed.body.revision, requestId: randomUUID()}, other);
    assert.equal(forbidden.response.status, 404);

    const newer = notes(200); newer[0].fields[0] = 'new source term'; newer[0].fields[1] = 'new source meaning';
    const updated = await f.importNotes(owner, newer, deckId);
    assert(updated.preview.report.localEdits >= 1); assert(updated.preview.report.locallyDeleted >= 1);
    deck = (await f.request(`/api/decks/${deckId}`, undefined, owner)).body.deck;
    assert.equal(deck.words.find((word: any) => word.id === editedWord.id).term, 'local term');
    assert(!deck.words.some((word: any) => word.id === deletedWord.id));

    const replacement = await f.importNotes(owner, notes(300).map((note, index) => index === 0 ? {...note, fields: ['replacement source', 'replacement meaning', '']} : note), deckId, true);
    assert(replacement.preview.report.restored >= 1);
    deck = (await f.request(`/api/decks/${deckId}`, undefined, owner)).body.deck;
    assert.equal(deck.words.find((word: any) => word.id === editedWord.id).term, 'replacement source');
    assert(deck.words.some((word: any) => word.id === deletedWord.id));

    deck = (await f.request(`/api/decks/${deckId}`, undefined, owner)).body.deck;
    const localAfterReplace = await f.request(`/api/decks/${deckId}/words/${editedWord.id}/edit`,
      {term: 'local after replace', meaning: 'local meaning', revision: deck.revision, requestId: randomUUID()}, owner);
    assert.equal(localAfterReplace.response.status, 200);
    const conflictSource = notes(300); conflictSource[0].fields[0] = 'conflicting source at same revision';
    const conflict = await f.importNotes(owner, conflictSource, deckId, true, true);
    assert(conflict.preview.report.conflicting >= 1);
    deck = (await f.request(`/api/decks/${deckId}`, undefined, owner)).body.deck;
    assert.equal(deck.words.find((word: any) => word.id === editedWord.id).term, 'local after replace');

    const oldSource = await f.importNotes(owner, notes(100), deckId, true, true);
    assert(oldSource.preview.report.older >= 1);
    deck = (await f.request(`/api/decks/${deckId}`, undefined, owner)).body.deck;
    assert.equal(deck.words.find((word: any) => word.id === editedWord.id).term, 'local after replace');
    assert(deck.words.some((word: any) => word.id === deletedWord.id));
  } finally { await f.close(); }
});

test('deleting a set removes it from current selection while preserving its saved snapshot', async () => {
  const f = await fixture();
  try {
    const cookie = await f.register(); const deckId = await f.imported(cookie);
    const started = await f.request('/api/training', {deckId, requestId: randomUUID()}, cookie);
    assert.equal(started.response.status, 201);
    const attemptId = started.body.attempt.id;
    const snapshot = (await f.request(`/api/training/${attemptId}/snapshot`, undefined, cookie)).body.snapshot;
    const deck = (await f.request(`/api/decks/${deckId}`, undefined, cookie)).body.deck;
    const deleted = await f.request(`/api/decks/${deckId}/delete`, {revision: deck.revision, requestId: randomUUID()}, cookie);
    assert.equal(deleted.response.status, 200);
    assert.equal((await f.request(`/api/decks/${deckId}`, undefined, cookie)).response.status, 404);
    assert.equal((await f.request('/api/training', {deckId, requestId: randomUUID()}, cookie)).response.status, 404);
    const preserved = (await f.request(`/api/training/${attemptId}/snapshot`, undefined, cookie)).body.snapshot;
    assert.deepEqual(preserved, snapshot);
    assert.equal((await f.request(`/api/training/${attemptId}/retry`, {requestId: randomUUID()}, cookie)).response.ok, false);
  } finally { await f.close(); }
});

test('retry snapshots filter deleted words while retained saved answers keep their original snapshot', async () => {
  const f = await fixture();
  try {
    const cookie = await f.register();
    const sourceNotes = notes().concat([{guid: 'retry-extra-note', modified: 100, fields: ['extra term', 'extra meaning', '']}]);
    const deckId = (await f.importNotes(cookie, sourceNotes)).deckId;
    const started = await f.request('/api/training', {deckId, requestId: randomUUID()}, cookie);
    const attemptId = started.body.attempt.id;
    const snapshot = (await f.request(`/api/training/${attemptId}/snapshot`, undefined, cookie)).body.snapshot;
    let attempt = started.body.attempt;
    const wrongTargets = snapshot.questions.slice(0, 2).map((question: any) => question.wordId);
    for (let position = 0; position < snapshot.questions.length; position++) {
      const question = snapshot.questions[position];
      if (attempt.selected === null) {
        const optionId = wrongTargets.includes(question.wordId)
          ? question.optionIds.find((id: string) => id !== question.wordId) : question.wordId;
        const answered = await f.request(`/api/training/${attemptId}/answer?format=compact`, {position: attempt.position, revision: attempt.revision, optionId, requestId: randomUUID()}, cookie);
        assert.equal(answered.response.status, 200); attempt = answered.body.attempt;
      }
      const advanced = await f.request(`/api/training/${attemptId}/advance?format=compact`, {position: attempt.position, revision: attempt.revision, requestId: randomUUID()}, cookie);
      assert.equal(advanced.response.status, 200); attempt = advanced.body.attempt;
    }
    const deck = (await f.request(`/api/decks/${deckId}`, undefined, cookie)).body.deck;
    const deleted = await f.request(`/api/decks/${deckId}/words/${wrongTargets[0]}/delete`, {revision: deck.revision, requestId: randomUUID()}, cookie);
    assert.equal(deleted.response.status, 200);
    const retry = await f.request(`/api/training/${attemptId}/retry`, {requestId: randomUUID()}, cookie);
    assert.equal(retry.response.status, 200);
    const retrySnapshot = (await f.request(`/api/training/${retry.body.attempt.id}/snapshot`, undefined, cookie)).body.snapshot;
    assert.deepEqual(retrySnapshot.questions.map((question: any) => question.wordId), [wrongTargets[1]]);
    assert(!retrySnapshot.words.some((word: any) => word.id === wrongTargets[0]));
    assert.deepEqual((await f.request(`/api/training/${attemptId}/snapshot`, undefined, cookie)).body.snapshot, snapshot);
  } finally { await f.close(); }
});
