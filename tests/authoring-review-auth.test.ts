import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {Auth} from '../server/auth';
import {createApplication} from '../server/app';

const origin = 'http://127.0.0.1:4173';
const password = 'authoring review fixture password';

async function fixture(options: {now?: () => number} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-authoring-review-auth-'));
  const databasePath = join(directory, 'app.sqlite');
  const app = createApplication({databasePath, content: {uiLanguage: 'en', decks: []}, origin, registration: 'open', ...options});
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
  return {request, register, database, async close() { await app.close(); await rm(directory, {recursive: true, force: true}); }};
}

test('token minting requires the current password and rejects wrong credentials without storing a secret receipt', async () => {
  const f = await fixture();
  try {
    const owner = await f.register('token-confirm@example.com');
    for (const body of [{name: 'missing confirmation'}, {name: 'wrong confirmation', currentPassword: 'incorrect password'}]) {
      const rejected = await f.request('/api/account/tokens', {cookie: owner.cookie, body});
      assert.equal(rejected.response.status, body.currentPassword ? 403 : 400, rejected.text);
    }
    const db = f.database();
    try {
      assert.equal((db.prepare('SELECT count(*) AS n FROM access_tokens').get() as {n: number}).n, 0);
      assert.equal((db.prepare('SELECT count(*) AS n FROM content_mutations').get() as {n: number}).n, 0);
    } finally { db.close(); }
    const created = await f.request('/api/account/tokens', {cookie: owner.cookie, body: {name: 'confirmed', currentPassword: password}});
    assert.equal(created.response.status, 201, created.text);
    assert.equal(typeof created.body.token, 'string');
    const after = f.database();
    try {
      const tables = (after.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name: string}[]).map(row => row.name);
      const serialized = tables.flatMap(name => after.prepare(`SELECT * FROM "${name}"`).all());
      assert(!JSON.stringify(serialized).includes(created.body.token));
      assert(!JSON.stringify(serialized).includes(password));
    } finally { after.close(); }
  } finally { await f.close(); }
});

test('expired session while current-password hashing is in flight prevents token minting', async () => {
  let instant = 1_700_000_000_000;
  const f = await fixture({now: () => instant});
  const authPrototype = Auth.prototype as unknown as {derive: (candidate: string, salt: string) => Promise<Buffer>};
  const derive = authPrototype.derive;
  let release!: () => void;
  let entered!: () => void;
  let blocked = false;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let mint: ReturnType<typeof f.request> | undefined;
  try {
    const owner = await f.register('session-race@example.com');
    authPrototype.derive = async function(candidate, salt) {
      const key = await derive.call(this, candidate, salt);
      if (candidate === password && !blocked) { blocked = true; entered(); await gate; }
      return key;
    };
    mint = f.request('/api/account/tokens', {cookie: owner.cookie, body: {name: 'must not mint', currentPassword: password}});
    await waiting;
    instant += 31 * 24 * 60 * 60 * 1000;
    release();
    const result = await mint;
    assert.notEqual(result.response.status, 201, result.text);
    assert.equal(result.body.token, undefined);
    const db = f.database();
    try { assert.equal((db.prepare('SELECT count(*) AS n FROM access_tokens').get() as {n: number}).n, 0); }
    finally { db.close(); }
  } finally {
    release();
    authPrototype.derive = derive;
    await mint?.catch(() => undefined);
    await f.close();
  }
});

test('logout while current-password hashing is in flight prevents token minting', async () => {
  const f = await fixture();
  const authPrototype = Auth.prototype as unknown as {derive: (candidate: string, salt: string) => Promise<Buffer>};
  const derive = authPrototype.derive;
  let release!: () => void;
  let entered!: () => void;
  let blocked = false;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let mint: ReturnType<typeof f.request> | undefined;
  try {
    const owner = await f.register('logout-race@example.com');
    authPrototype.derive = async function(candidate, salt) {
      const key = await derive.call(this, candidate, salt);
      if (candidate === password && !blocked) { blocked = true; entered(); await gate; }
      return key;
    };
    mint = f.request('/api/account/tokens', {cookie: owner.cookie, body: {name: 'must not mint', currentPassword: password}});
    await waiting;
    assert.equal((await f.request('/api/auth/logout', {cookie: owner.cookie, body: {}})).response.status, 200);
    release();
    const result = await mint;
    assert.notEqual(result.response.status, 201, result.text);
    assert.equal(result.body.token, undefined);
    const db = f.database();
    try { assert.equal((db.prepare('SELECT count(*) AS n FROM access_tokens').get() as {n: number}).n, 0); }
    finally { db.close(); }
  } finally {
    release();
    authPrototype.derive = derive;
    await mint?.catch(() => undefined);
    await f.close();
  }
});

test('password replacement while current-password hashing is in flight prevents token minting', async () => {
  const f = await fixture();
  const authPrototype = Auth.prototype as unknown as {derive: (candidate: string, salt: string) => Promise<Buffer>};
  const derive = authPrototype.derive;
  let release!: () => void;
  let entered!: () => void;
  let blocked = false;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let mint: ReturnType<typeof f.request> | undefined;
  try {
    const owner = await f.register('credential-race@example.com');
    authPrototype.derive = async function(candidate, salt) {
      const key = await derive.call(this, candidate, salt);
      if (candidate === password && !blocked) { blocked = true; entered(); await gate; }
      return key;
    };
    mint = f.request('/api/account/tokens', {cookie: owner.cookie, body: {name: 'must not mint', currentPassword: password}});
    await waiting;
    const changed = await f.request('/api/account/password', {cookie: owner.cookie,
      body: {currentPassword: password, newPassword: 'replacement credential password'}});
    assert.equal(changed.response.status, 200, changed.text);
    release();
    const result = await mint;
    assert.notEqual(result.response.status, 201, result.text);
    assert.equal(result.body.token, undefined);
    const db = f.database();
    try { assert.equal((db.prepare('SELECT count(*) AS n FROM access_tokens').get() as {n: number}).n, 0); }
    finally { db.close(); }
  } finally {
    release();
    authPrototype.derive = derive;
    await mint?.catch(() => undefined);
    await f.close();
  }
});

test('only Bearer authorization overrides cookie authentication; malformed bearer never falls back', async () => {
  const f = await fixture();
  try {
    const owner = await f.register('scheme@example.com');
    const token = await f.request('/api/account/tokens', {cookie: owner.cookie, body: {name: 'scheme checks', currentPassword: password}});
    assert.equal(token.response.status, 201, token.text);
    const basic = await f.request('/api/auth/me', {cookie: owner.cookie, headers: {Authorization: 'Basic dXNlcjpwYXNz'}});
    assert.equal(basic.response.status, 200, basic.text);
    const nonBearer = await f.request('/api/auth/me', {cookie: owner.cookie, headers: {Authorization: 'Digest opaque'}});
    assert.equal(nonBearer.response.status, 200, nonBearer.text);
    const basicAuthoring = await f.request('/api/authoring/decks', {cookie: owner.cookie,
      headers: {Authorization: 'Basic dXNlcjpwYXNz'}});
    assert.equal(basicAuthoring.response.status, 200, basicAuthoring.text);
    const malformed = await f.request('/api/auth/me', {cookie: owner.cookie, headers: {Authorization: 'Bearer malformed'}});
    assert.equal(malformed.response.status, 401, malformed.text);
    const changedSecret = token.body.token.replace(/[a-f]/, (letter: string) => letter.toUpperCase());
    assert.notEqual(changedSecret, token.body.token);
    const uppercaseSecret = await f.request('/api/authoring/decks', {cookie: owner.cookie,
      headers: {Authorization: `bearer ${changedSecret}`}});
    assert.equal(uppercaseSecret.response.status, 401, uppercaseSecret.text);
    const missingOrigin = await f.request('/api/authoring/decks', {body: {requestId: 'anonymous-origin', title: 'x'},
      headers: {Origin: 'https://foreign.example'}});
    assert.equal(missingOrigin.response.status, 403, missingOrigin.text);
  } finally { await f.close(); }
});

test('bearer scheme is case insensitive, token secret is lowercase hex, and revocation reports actual deletion', async () => {
  const f = await fixture();
  try {
    const owner = await f.register('revoke-owner@example.com');
    const other = await f.register('revoke-other@example.com');
    const created = await f.request('/api/account/tokens', {cookie: owner.cookie, body: {name: 'format', currentPassword: password}});
    assert.equal(created.response.status, 201, created.text);
    assert.match(created.body.token, /^mlt_[a-f0-9]{64}$/);
    const lowerScheme = await f.request('/api/authoring/decks', {headers: {Authorization: `bearer ${created.body.token}`}});
    assert.equal(lowerScheme.response.status, 200, lowerScheme.text);
    const path = `/api/account/tokens/${encodeURIComponent(created.body.id)}/revoke`;
    const foreign = await f.request(path, {cookie: other.cookie, body: {}});
    assert.equal(foreign.response.status, 200, foreign.text);
    assert.deepEqual(foreign.body, {revoked: false});
    const revoked = await f.request(path, {cookie: owner.cookie, body: {}});
    assert.equal(revoked.response.status, 200, revoked.text);
    assert.deepEqual(revoked.body, {revoked: true});
    const repeated = await f.request(path, {cookie: owner.cookie, body: {}});
    assert.equal(repeated.response.status, 200, repeated.text);
    assert.deepEqual(repeated.body, {revoked: false});
    const missing = await f.request('/api/account/tokens/missing-id/revoke', {cookie: owner.cookie, body: {}});
    assert.equal(missing.response.status, 200, missing.text);
    assert.deepEqual(missing.body, {revoked: false});
  } finally { await f.close(); }
});

test('an invalid token name is rejected before the current password is checked or counted', async () => {
  const f = await fixture();
  try {
    const owner = await f.register('token-name-order@example.com');
    for (let index = 0; index < 5; index++) {
      const rejected = await f.request('/api/account/tokens', {cookie: owner.cookie,
        body: {name: '   ', currentPassword: 'incorrect password'}});
      assert.equal(rejected.response.status, 400, rejected.text);
      assert.match(rejected.body.error.message, /token name/);
    }
    const wrongPassword = await f.request('/api/account/tokens', {cookie: owner.cookie,
      body: {name: 'after rejected names', currentPassword: 'incorrect password'}});
    assert.equal(wrongPassword.response.status, 403, wrongPassword.text);
    const db = f.database();
    try { assert.equal((db.prepare('SELECT count(*) AS n FROM access_tokens').get() as {n: number}).n, 0); }
    finally { db.close(); }
  } finally { await f.close(); }
});

test('token confirmation shares failed-password limits and the two-hash concurrency cap', async () => {
  const f = await fixture();
  try {
    const owner = await f.register('token-limits@example.com');
    for (let index = 0; index < 5; index++) {
      const rejected = await f.request('/api/account/tokens', {cookie: owner.cookie,
        body: {name: `wrong ${index}`, currentPassword: 'incorrect password'}});
      assert.equal(rejected.response.status, 403, rejected.text);
    }
    const limited = await f.request('/api/account/tokens', {cookie: owner.cookie,
      body: {name: 'blocked by failures', currentPassword: password}});
    assert.equal(limited.response.status, 429, limited.text);
    const db = f.database();
    try { assert.equal((db.prepare('SELECT count(*) AS n FROM access_tokens').get() as {n: number}).n, 0); }
    finally { db.close(); }
  } finally { await f.close(); }

  const concurrency = await fixture();
  try {
    const owner = await concurrency.register('token-concurrency@example.com');
    const results = await Promise.all(Array.from({length: 3}, (_, index) => concurrency.request('/api/account/tokens', {
      cookie: owner.cookie, body: {name: `concurrent ${index}`, currentPassword: password}})));
    assert.deepEqual(results.map(result => result.response.status).sort(), [201, 201, 429]);
    const db = concurrency.database();
    try { assert.equal((db.prepare('SELECT count(*) AS n FROM access_tokens').get() as {n: number}).n, 2); }
    finally { db.close(); }
  } finally { await concurrency.close(); }
});
