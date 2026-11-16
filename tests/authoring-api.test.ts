import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createApplication} from '../server/app';

const origin = 'http://127.0.0.1:4173';
const password = 'authoring API fixture password';
const content = {uiLanguage: 'en', decks: []};
type Options = {now?: () => number};

async function fixture(options: Options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-authoring-api-'));
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
  async function createToken(cookie: string, name: string) {
    const result = await request('/api/account/tokens', {cookie, body: {name, currentPassword: password}});
    assert.equal(result.response.status, 201, result.text);
    return result.body as {id: string; token: string};
  }
  return {request, register, createToken, async restart() { await app.close(); await start(); }, async close() {
    await app.close();
    await rm(directory, {recursive: true, force: true});
  }};
}

const createBody = (requestId: string, title = 'Book words') => ({requestId, title,
  termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr'});

test('an account can create and read only its native learning sets', async () => {
  const f = await fixture();
  try {
    const owner = await f.register('owner@example.com');
    const other = await f.register('other@example.com');
    const token = await f.createToken(owner.cookie, 'book importer');

    const anonymous = await f.request('/api/authoring/decks');
    assert.equal(anonymous.response.status, 401, anonymous.text);
    const empty = await f.request('/api/authoring/decks', {headers: {Authorization: `Bearer ${token.token}`}, noOrigin: true});
    assert.equal(empty.response.status, 200, empty.text);
    assert.deepEqual(empty.body.decks, []);
    assert.equal(empty.body.nextCursor, null);

    const body = createBody('create-book-set-1');
    const created = await f.request('/api/authoring/decks', {headers: {Authorization: `Bearer ${token.token}`}, body, noOrigin: true});
    assert.equal(created.response.status, 201, created.text);
    assert.equal(created.body.deck.title, body.title);
    assert.equal(created.body.deck.termLang, 'el');
    assert.equal(created.body.deck.meaningLang, 'en');
    assert.equal(created.body.deck.revision, 1);
    assert.equal(created.body.deck.authored, true);
    assert.equal(created.body.deck.imported, false);
    assert.equal(created.body.deck.editable, true);
    const deckId = created.body.deck.id as string;

    const replay = await f.request('/api/authoring/decks', {headers: {Authorization: `Bearer ${token.token}`}, body, noOrigin: true});
    assert.equal(replay.response.status, 201, replay.text);
    assert.deepEqual(replay.body, created.body);
    const changedReplay = await f.request('/api/authoring/decks', {
      headers: {Authorization: `Bearer ${token.token}`}, body: createBody(body.requestId, 'Changed title'), noOrigin: true});
    assert.equal(changedReplay.response.status, 409, changedReplay.text);

    const listed = await f.request('/api/authoring/decks', {headers: {Authorization: `Bearer ${token.token}`}, noOrigin: true});
    assert.equal(listed.response.status, 200, listed.text);
    assert.deepEqual(listed.body.decks.map((deck: {id: string}) => deck.id), [deckId]);
    const read = await f.request(`/api/authoring/decks/${encodeURIComponent(deckId)}`, {headers: {Authorization: `Bearer ${token.token}`}, noOrigin: true});
    assert.equal(read.response.status, 200, read.text);
    assert.equal(read.body.deck.id, deckId);
    assert.deepEqual(read.body.deck.words, []);

    const catalog = await f.request('/api/decks', {cookie: owner.cookie});
    assert.equal(catalog.response.status, 200, catalog.text);
    assert.equal(catalog.body.decks.find((deck: {id: string}) => deck.id === deckId).authored, true);
    const browserRead = await f.request(`/api/decks/${encodeURIComponent(deckId)}`, {cookie: owner.cookie});
    assert.equal(browserRead.response.status, 200, browserRead.text);
    assert.equal(browserRead.body.source, null);

    const ownerBearerWins = await f.request(`/api/authoring/decks/${encodeURIComponent(deckId)}`, {
      headers: {Authorization: `Bearer ${token.token}`}, cookie: other.cookie, noOrigin: true});
    assert.equal(ownerBearerWins.response.status, 200, ownerBearerWins.text);
    assert.equal(ownerBearerWins.body.deck.id, deckId);
    const otherToken = await f.createToken(other.cookie, 'other automation');
    const ownerCookieDoesNotOverride = await f.request(`/api/authoring/decks/${encodeURIComponent(deckId)}`, {
      headers: {Authorization: `Bearer ${otherToken.token}`}, cookie: owner.cookie, noOrigin: true});
    assert.equal(ownerCookieDoesNotOverride.response.status, 404, ownerCookieDoesNotOverride.text);
    const hidden = await f.request(`/api/authoring/decks/${encodeURIComponent(deckId)}`, {headers: {Authorization: `Bearer ${otherToken.token}`}, noOrigin: true});
    assert.equal(hidden.response.status, 404, hidden.text);

    await f.restart();
    const afterRestart = await f.request('/api/authoring/decks', {headers: {Authorization: `Bearer ${token.token}`}, noOrigin: true});
    assert.equal(afterRestart.response.status, 200, afterRestart.text);
    assert.deepEqual(afterRestart.body.decks.map((deck: {id: string}) => deck.id), [deckId]);
    const replayAfterRestart = await f.request('/api/authoring/decks', {
      headers: {Authorization: `Bearer ${token.token}`}, body, noOrigin: true});
    assert.equal(replayAfterRestart.response.status, 201, replayAfterRestart.text);
    assert.deepEqual(replayAfterRestart.body, created.body);
  } finally { await f.close(); }
});

test('authoring routes enforce bearer precedence and retain browser session safeguards', async () => {
  const f = await fixture();
  try {
    const owner = await f.register('owner@example.com');
    const token = await f.createToken(owner.cookie, 'book importer');
    const body = createBody('create-book-set-guard');

    const invalidWithCookie = await f.request('/api/authoring/decks', {
      headers: {Authorization: 'Bearer invalid-token'}, cookie: owner.cookie, body});
    assert.equal(invalidWithCookie.response.status, 401, invalidWithCookie.text);
    const foreignOrigin = await f.request('/api/authoring/decks', {
      headers: {Authorization: `Bearer ${token.token}`, Origin: 'https://attacker.example'}, body});
    assert.equal(foreignOrigin.response.status, 403, foreignOrigin.text);

    const missingOrigin = await f.request('/api/authoring/decks', {cookie: owner.cookie, noOrigin: true, body});
    assert.equal(missingOrigin.response.status, 403, missingOrigin.text);
    const wrongAccount = await f.request('/api/authoring/decks', {cookie: owner.cookie,
      headers: {'X-Meletio-User': 'another-account'}, body});
    assert.equal(wrongAccount.response.status, 401, wrongAccount.text);

    const cookieCreate = await f.request('/api/authoring/decks', {cookie: owner.cookie, body});
    assert.equal(cookieCreate.response.status, 201, cookieCreate.text);
    const bearer = {Authorization: `Bearer ${token.token}`};
    assert.equal((await f.request('/api/account/tokens', {headers: bearer})).response.status, 401);
    assert.equal((await f.request('/api/auth/me', {headers: bearer})).response.status, 401);
    assert.equal((await f.request('/api/training?deckId=unrelated', {headers: bearer})).response.status, 401);

    const revoked = await f.request(`/api/account/tokens/${encodeURIComponent(token.id)}/revoke`, {cookie: owner.cookie, body: {}});
    assert.equal(revoked.response.status, 200, revoked.text);
    const denied = await f.request('/api/authoring/decks', {headers: bearer, noOrigin: true});
    assert.equal(denied.response.status, 401, denied.text);
    const ownerCookieStillWorks = await f.request('/api/authoring/decks', {cookie: owner.cookie});
    assert.equal(ownerCookieStillWorks.response.status, 200, ownerCookieStillWorks.text);
  } finally { await f.close(); }
});
