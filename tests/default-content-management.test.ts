import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createApplication} from '../server/app';

const origin = 'http://127.0.0.1:4173';
const content = {uiLanguage: 'en', decks: [
  {id: 'everyday-el', title: 'Everyday Greek', termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr', words: Array.from({length: 10}, (_, i) => ({id: String(i + 1), term: `Greek ${i + 1}`, meaning: `Meaning ${i + 1}`, image: null, audio: null}))},
  {id: 'demo-ar', title: 'Arabic demo', termLang: 'ar', meaningLang: 'en', termDir: 'rtl', meaningDir: 'ltr', words: Array.from({length: 6}, (_, i) => ({id: String(i + 1), term: `Arabic ${i + 1}`, meaning: `Meaning ${i + 1}`, image: null, audio: null}))},
]};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-default-content-'));
  const databasePath = join(directory, 'app.sqlite');
  let app: ReturnType<typeof createApplication>;
  let base = '';
  async function open() {
    app = createApplication({databasePath, content, origin, registration: 'open'});
    await new Promise<void>((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
    const address = app.server.address(); assert(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
  }
  await open();
  async function request(path: string, body?: unknown, cookie?: string, method = body === undefined ? 'GET' : 'POST', extraHeaders: Record<string, string> = {}) {
    const response = await fetch(base + path, {method, headers: {Origin: origin, ...(cookie ? {Cookie: cookie} : {}), ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...extraHeaders}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    let result: any; try { result = await response.json(); } catch { result = {}; }
    return {response, body: result};
  }
  async function register(email = 'owner@example.com') {
    const result = await request('/api/auth/register', {email, password: 'private fixture password'});
    assert(result.response.ok, JSON.stringify(result.body));
    return result.response.headers.get('set-cookie')!.split(';')[0];
  }
  return {
    databasePath, request, register,
    async restart() { await app.close(); await open(); },
    async close() { await app.close(); await rm(directory, {recursive: true, force: true}); },
  };
}

test('default sets are editable per account and retain stable IDs and saved snapshots', async () => {
  const f = await fixture();
  try {
    const owner = await f.register();
    const other = await f.register('other@example.com');
    const ownerCatalog = (await f.request('/api/decks', undefined, owner)).body.decks;
    const otherCatalog = (await f.request('/api/decks', undefined, other)).body.decks;
    assert.deepEqual(otherCatalog, ownerCatalog);
    const greekMeta = ownerCatalog.find((deck: any) => deck.id === 'everyday-el');
    const arabicMeta = ownerCatalog.find((deck: any) => deck.id === 'demo-ar');
    assert.equal(greekMeta.editable, true);
    assert.equal(greekMeta.imported, false);
    assert.equal(arabicMeta.editable, true);
    assert.equal(arabicMeta.imported, false);

    const original = (await f.request('/api/decks/everyday-el', undefined, owner)).body.deck;
    const originalSnapshot = await f.request('/api/training', {deckId: original.id, requestId: randomUUID()}, owner);
    assert.equal(originalSnapshot.response.status, 201);
    const snapshotId = originalSnapshot.body.attempt.id;
    const beforeSnapshot = (await f.request(`/api/training/${snapshotId}/snapshot`, undefined, owner)).body.snapshot;
    const sharedRequestId = randomUUID();
    const edited = await f.request(`/api/decks/${original.id}/words/${original.words[0].id}/edit`, {
      term: 'my private Greek', meaning: 'my private meaning', revision: original.revision, requestId: sharedRequestId,
    }, owner);
    assert.equal(edited.response.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.word.id, original.words[0].id);
    const replay = await f.request(`/api/decks/${original.id}/words/${original.words[0].id}/edit`, {
      term: 'my private Greek', meaning: 'my private meaning', revision: original.revision, requestId: sharedRequestId,
    }, owner);
    assert.deepEqual(replay.body, edited.body);
    const otherEdit = await f.request(`/api/decks/${original.id}/words/${original.words[0].id}/edit`, {
      term: 'their Greek', meaning: 'their meaning', revision: original.revision, requestId: sharedRequestId,
    }, other);
    assert.equal(otherEdit.response.status, 200, JSON.stringify(otherEdit.body));
    assert.equal(otherEdit.body.word.term, 'their Greek');
    const stale = await f.request(`/api/decks/${original.id}/words/${original.words[1].id}/delete`, {
      revision: original.revision, requestId: randomUUID(),
    }, owner);
    assert.equal(stale.response.status, 409);

    const renamed = await f.request(`/api/decks/${original.id}/rename`, {
      title: 'My Greek', revision: edited.body.revision, requestId: randomUUID(),
    }, owner);
    assert.equal(renamed.response.status, 200, JSON.stringify(renamed.body));
    const wordDeleted = await f.request(`/api/decks/${original.id}/words/${original.words[1].id}/delete`, {
      revision: renamed.body.revision, requestId: randomUUID(),
    }, owner);
    assert.equal(wordDeleted.response.status, 200, JSON.stringify(wordDeleted.body));

    await f.restart();
    const restored = (await f.request(`/api/decks/${original.id}`, undefined, owner)).body.deck;
    const restoredOther = (await f.request(`/api/decks/${original.id}`, undefined, other)).body.deck;
    assert.equal(restored.id, original.id);
    assert.equal(restored.title, 'My Greek');
    assert.equal(restored.words.find((word: any) => word.id === original.words[0].id).term, 'my private Greek');
    assert(!restored.words.some((word: any) => word.id === original.words[1].id));
    assert.equal(restoredOther.title, original.title);
    assert.equal(restoredOther.words[0].term, 'their Greek');
    assert.deepEqual((await f.request(`/api/training/${snapshotId}/snapshot`, undefined, owner)).body.snapshot, beforeSnapshot);

    const hidden = await f.request(`/api/decks/${original.id}/delete`, {
      revision: restored.revision, requestId: randomUUID(),
    }, owner);
    assert.equal(hidden.response.status, 200, JSON.stringify(hidden.body));
    assert.equal((await f.request(`/api/decks/${original.id}`, undefined, owner)).response.status, 404);
    assert.equal((await f.request(`/api/decks/${original.id}`, undefined, other)).response.status, 200);
    assert.equal((await f.request('/api/decks', undefined, owner)).body.decks.some((deck: any) => deck.id === original.id), false);
    assert.equal((await f.request('/api/decks', undefined, other)).body.decks.some((deck: any) => deck.id === original.id), true);
  } finally { await f.close(); }
});

test('default set mutations reject hostile origins and a changed cached account', async () => {
  const f = await fixture();
  try {
    const owner = await f.register();
    const other = await f.register('other@example.com');
    const deck = (await f.request('/api/decks/everyday-el', undefined, owner)).body.deck;
    const body = {title: 'Blocked', revision: deck.revision, requestId: randomUUID()};
    assert.equal((await f.request(`/api/decks/${deck.id}/rename`, body, owner, 'POST', {Origin: 'https://attacker.example'})).response.status, 403);
    assert.equal((await f.request(`/api/decks/${deck.id}/rename`, body, owner, 'POST', {'X-Meletio-User': 'a-different-user'})).response.status, 401);
    const preserved = (await f.request(`/api/decks/${deck.id}`, undefined, owner)).body.deck;
    assert.equal(preserved.title, deck.title);
    assert.equal(preserved.revision, deck.revision);
    assert.equal((await f.request(`/api/decks/${deck.id}`, undefined, other)).body.deck.title, deck.title);
  } finally { await f.close(); }
});

test('owner can hide the last default set and continue using the account and import entry points', async () => {
  const f = await fixture();
  try {
    const owner = await f.register();
    for (const id of ['everyday-el', 'demo-ar']) {
      const deck = (await f.request(`/api/decks/${id}`, undefined, owner)).body.deck;
      const removed = await f.request(`/api/decks/${id}/delete`, {revision: deck.revision, requestId: randomUUID()}, owner);
      assert.equal(removed.response.status, 200, JSON.stringify(removed.body));
    }
    assert.deepEqual((await f.request('/api/decks', undefined, owner)).body.decks, []);
    assert.equal((await f.request('/api/auth/me', undefined, owner)).response.status, 200);
    assert.equal((await f.request('/api/imports/current', undefined, owner)).response.status, 200);
    assert.equal((await f.request('/api/training', {deckId: 'everyday-el', requestId: randomUUID()}, owner)).response.status, 404);
  } finally { await f.close(); }
});
