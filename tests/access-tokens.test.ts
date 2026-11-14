import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {createApplication} from '../server/app';

const origin = 'http://127.0.0.1:4173';
const password = 'account token test password';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-access-tokens-'));
  const databasePath = join(directory, 'app.sqlite');
  let instant = 1_700_000_000_000;
  const app = createApplication({databasePath, content: {uiLanguage: 'en', decks: []}, origin,
    registration: 'open', now: () => instant});
  await new Promise<void>((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  const address = app.server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  async function request(path: string, options: {method?: string; body?: unknown; cookie?: string; headers?: Record<string, string>} = {}) {
    const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
    const headers: Record<string, string> = {...(method === 'POST' ? {Origin: origin, 'Content-Type': 'application/json'} : {}), ...options.headers};
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
  const database = () => new DatabaseSync(databasePath);
  return {app, request, register, database, elapse(ms: number) { instant += ms; }, async close() {
    await app.close();
    await rm(directory, {recursive: true, force: true});
  }};
}

test('named access tokens are one-time secrets, owner scoped, hashed, and revocable', async () => {
  const f = await fixture();
  try {
    const owner = await f.register('owner@example.com');
    const other = await f.register('other@example.com');
    assert.equal((await f.request('/api/account/tokens')).response.status, 401);

    const created = await f.request('/api/account/tokens', {cookie: owner.cookie, body: {name: 'book importer'}});
    assert.equal(created.response.status, 201, created.text);
    assert.equal(created.body.name, 'book importer');
    assert.equal(created.body.createdAt, 1_700_000_000_000);
    assert.equal(created.body.expiresAt, 1_700_000_000_000 + 90 * 24 * 60 * 60 * 1000);
    assert.equal(typeof created.body.id, 'string');
    assert.equal(typeof created.body.token, 'string');
    assert(created.body.token.length >= 32);

    const listed = await f.request('/api/account/tokens', {cookie: owner.cookie});
    assert.equal(listed.response.status, 200, listed.text);
    assert.deepEqual(listed.body.tokens, [{id: created.body.id, name: 'book importer',
      createdAt: created.body.createdAt, expiresAt: created.body.expiresAt}]);
    assert(!listed.text.includes(created.body.token));
    assert.deepEqual((await f.request('/api/account/tokens', {cookie: other.cookie})).body.tokens, []);

    const db = f.database();
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name: string}[])
        .map(({name}) => name);
      const rows = tables.flatMap(name => db.prepare(`SELECT * FROM "${name}"`).all());
      const serialized = JSON.stringify(rows);
      assert(!serialized.includes(created.body.token));
      const hash = createHash('sha256').update(created.body.token).digest('hex');
      assert(serialized.includes(hash));
    } finally { db.close(); }

    const foreignRevoke = await f.request(`/api/account/tokens/${encodeURIComponent(created.body.id)}/revoke`, {cookie: other.cookie, body: {}});
    assert.equal(foreignRevoke.response.status, 200, foreignRevoke.text);
    assert.equal((await f.request('/api/account/tokens', {cookie: owner.cookie})).body.tokens.length, 1);
    const revoke = await f.request(`/api/account/tokens/${encodeURIComponent(created.body.id)}/revoke`, {cookie: owner.cookie, body: {}});
    assert.equal(revoke.response.status, 200, revoke.text);
    assert.deepEqual(revoke.body, {revoked: true});
    const replay = await f.request(`/api/account/tokens/${encodeURIComponent(created.body.id)}/revoke`, {cookie: owner.cookie, body: {}});
    assert.equal(replay.response.status, 200, replay.text);
    assert.deepEqual(replay.body, {revoked: true});
    assert.deepEqual((await f.request('/api/account/tokens', {cookie: owner.cookie})).body.tokens, []);
  } finally { await f.close(); }
});

test('token routes retain session Origin and account guards, expiry, and active-account limits', async () => {
  const f = await fixture();
  try {
    const owner = await f.register('guard@example.com');
    const missingOrigin = await f.request('/api/account/tokens', {cookie: owner.cookie, headers: {Origin: 'https://evil.example'}, body: {name: 'blocked'}});
    assert.equal(missingOrigin.response.status, 403, missingOrigin.text);
    const wrongAccount = await f.request('/api/account/tokens', {cookie: owner.cookie, headers: {'X-Meletio-User': 'other-user'}, body: {name: 'blocked'}});
    assert.equal(wrongAccount.response.status, 401, wrongAccount.text);
    const invalid = await f.request('/api/account/tokens', {cookie: owner.cookie, body: {name: '', extra: true}});
    assert.equal(invalid.response.status, 400, invalid.text);

    for (let index = 0; index < 20; index++) {
      const result = await f.request('/api/account/tokens', {cookie: owner.cookie, body: {name: `token ${index}`}});
      assert.equal(result.response.status, 201, result.text);
    }
    const capped = await f.request('/api/account/tokens', {cookie: owner.cookie, body: {name: 'over limit'}});
    assert.notEqual(capped.response.status, 201, capped.text);
    assert.equal((await f.request('/api/account/tokens', {cookie: owner.cookie})).body.tokens.length, 20);

    f.elapse(90 * 24 * 60 * 60 * 1000);
    const renewed = await f.request('/api/auth/login', {body: {email: owner.user.email, password}});
    assert.equal(renewed.response.status, 200, renewed.text);
    const cookie = renewed.response.headers.get('set-cookie')!.split(';')[0];
    assert.deepEqual((await f.request('/api/account/tokens', {cookie})).body.tokens, []);
    const afterExpiry = await f.request('/api/account/tokens', {cookie, body: {name: 'replacement'}});
    assert.equal(afterExpiry.response.status, 201, afterExpiry.text);
  } finally { await f.close(); }
});

test('password change revokes personal tokens while logout preserves them', async () => {
  const f = await fixture();
  try {
    const owner = await f.register('owner@example.com');
    const created = await f.request('/api/account/tokens', {cookie: owner.cookie, body: {name: 'automation'}});
    assert.equal(created.response.status, 201, created.text);
    const logout = await f.request('/api/auth/logout', {cookie: owner.cookie, body: {}});
    assert.equal(logout.response.status, 200, logout.text);
    const login = await f.request('/api/auth/login', {body: {email: owner.user.email, password}});
    assert.equal(login.response.status, 200, login.text);
    const cookie = login.response.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await f.request('/api/account/tokens', {cookie})).body.tokens.length, 1);

    const changed = await f.request('/api/account/password', {cookie, body: {currentPassword: password, newPassword: 'replacement token password'}});
    assert.equal(changed.response.status, 200, changed.text);
    assert.deepEqual((await f.request('/api/account/tokens', {cookie})).body.tokens, []);
  } finally { await f.close(); }
});

test('personal bearer tokens do not authorize account, training, or import APIs', async () => {
  const f = await fixture();
  try {
    const owner = await f.register('owner@example.com');
    const created = await f.request('/api/account/tokens', {cookie: owner.cookie, body: {name: 'automation'}});
    assert.equal(created.response.status, 201, created.text);
    const bearer = {Authorization: `Bearer ${created.body.token}`};
    assert.equal((await f.request('/api/auth/me', {headers: bearer})).response.status, 401);
    assert.equal((await f.request('/api/account/tokens', {headers: bearer})).response.status, 401);
    assert.equal((await f.request('/api/imports/current', {headers: bearer})).response.status, 401);
    assert.equal((await f.request('/api/training?deckId=demo', {headers: bearer})).response.status, 401);
    const passwordChange = await f.request('/api/account/password', {headers: bearer,
      body: {currentPassword: password, newPassword: 'replacement token password'}});
    assert.equal(passwordChange.response.status, 401, passwordChange.text);
  } finally { await f.close(); }
});
