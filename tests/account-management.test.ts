import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {Auth} from '../server/auth';
import {AuthLimitError, AuthLimits} from '../server/auth-limits';
import {createApplication} from '../server/app';

const origin = 'http://127.0.0.1:4173';
const password = 'account test password';
const content = {uiLanguage: 'en', decks: []};
type Options = {registration?: 'open' | 'closed'; now?: () => number};

async function fixture(options: Options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-account-'));
  const databasePath = join(directory, 'app.sqlite');
  let instant = Date.now();
  const app = createApplication({databasePath, content, origin, now: options.now ?? (() => instant),
    ...(options.registration ? {registration: options.registration} : {})} as Parameters<typeof createApplication>[0]);
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

function status(result: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['request']>>, code: number) {
  assert.equal(result.response.status, code, result.text);
}

function limited(run: () => void, seconds: number) {
  assert.throws(run, error => error instanceof AuthLimitError && error.retryAfter === seconds);
}

test('authentication limits distinguish failures, normalize accounts, expire, and evict oldest keys', () => {
  let instant = 1000;
  const limits = new AuthLimits(() => instant);
  for (let index = 0; index < 5; index++) limits.failure(' Learner@Example.com ', '127.0.0.1');
  limited(() => limits.check('learner@example.COM', '127.0.0.1'), 900);
  limits.success('LEARNER@example.com');
  limits.check('learner@example.com', '127.0.0.1');
  for (let index = 0; index < 20; index++) limits.failure(`person${index}@example.com`, '127.0.0.2');
  limited(() => limits.check('fresh@example.com', '127.0.0.2'), 900);
  instant += 15 * 60 * 1000;
  limits.check('learner@example.com', '127.0.0.1');

  const admissions = new AuthLimits(() => instant);
  for (let index = 0; index < 60; index++) admissions.admit('address-a');
  limited(() => admissions.admit('address-a'), 60);
  for (let index = 1; index < 60; index++) admissions.admit(`address-${index}`);
  admissions.admit('address-new');
  limited(() => admissions.admit('address-over-global'), 60);
  instant += 60000;
  admissions.admit('address-new');

  const bounded = new AuthLimits(() => instant) as unknown as {accounts: Map<string, unknown>; addresses: Map<string, unknown>; failure(account: string, address: string): void};
  for (let index = 0; index < 1001; index++) bounded.failure(`unique-${index}@example.com`, `unique-${index}`);
  assert.equal(bounded.addresses.size, 1000);
  assert.equal(bounded.accounts.size, 1000);
  assert(!bounded.addresses.has('unique-0'));
  assert(!bounded.accounts.has('unique-0@example.com'));
});

test('registration configuration is public, no-store, closed by default, and explicitly open', async () => {
  const closed = await fixture();
  try {
    const config = await closed.request('/api/auth/config');
    status(config, 200);
    assert.deepEqual(config.body, {registrationOpen: false});
    assert.match(config.response.headers.get('cache-control') ?? '', /no-store/i);
    status(await closed.request('/api/auth/register', {body: {email: 'closed@example.com', password}}), 403);
    status(await closed.request('/api/auth/login', {body: {email: 'existing@example.com', password}}), 401);
  } finally { await closed.close(); }
  const open = await fixture({registration: 'open'});
  try {
    assert.deepEqual((await open.request('/api/auth/config')).body, {registrationOpen: true});
    assert.equal((await open.register('open@example.com')).user.email, 'open@example.com');
  } finally { await open.close(); }
});

test('password change retains caller, revokes other sessions, and preserves other accounts and learning rows', async () => {
  const f = await fixture({registration: 'open'});
  try {
    const first = await f.register('first@example.com');
    const second = await f.register('second@example.com');
    const firstOtherSession = await f.request('/api/auth/login', {body: {email: first.user.email, password}});
    const otherCookie = firstOtherSession.response.headers.get('set-cookie')!.split(';')[0];
    const db = f.database();
    try {
      db.prepare("INSERT INTO training_attempts VALUES ('practice-1', ?, 'custom', 'active', '{}', 1, NULL)").run(first.user.id);
      const beforeOther = JSON.stringify(db.prepare('SELECT * FROM users WHERE id = ?').get(second.user.id));
      const beforePractice = JSON.stringify(db.prepare('SELECT * FROM training_attempts').all());
      const changed = await f.request('/api/account/password', {cookie: first.cookie,
        body: {currentPassword: password, newPassword: 'new account test password'}});
      status(changed, 200);
      assert.equal((await f.request('/api/auth/me', {cookie: first.cookie})).response.status, 200);
      status(await f.request('/api/auth/me', {cookie: otherCookie}), 401);
      status(await f.request('/api/auth/me', {cookie: second.cookie}), 200);
      status(await f.request('/api/auth/login', {body: {email: first.user.email, password}}), 401);
      const newLogin = await f.request('/api/auth/login', {body: {email: first.user.email, password: 'new account test password'}});
      status(newLogin, 200);
      assert.equal(JSON.stringify(db.prepare('SELECT * FROM users WHERE id = ?').get(second.user.id)), beforeOther);
      assert.equal(JSON.stringify(db.prepare('SELECT * FROM training_attempts').all()), beforePractice);
      assert(!JSON.stringify(changed.body).includes('password_hash'));
      assert(!JSON.stringify(changed.body).includes('new account test password'));
    } finally { db.close(); }
  } finally { await f.close(); }
});

test('password change guards current password, origin, account header, and invalid fields without logging caller out', async () => {
  const f = await fixture({registration: 'open'});
  try {
    const user = await f.register('guard@example.com');
    const wrong = await f.request('/api/account/password', {cookie: user.cookie,
      body: {currentPassword: 'incorrect current password', newPassword: 'new account test password'}});
    status(wrong, 403);
    status(await f.request('/api/auth/me', {cookie: user.cookie}), 200);
    status(await f.request('/api/account/password', {cookie: user.cookie,
      headers: {Origin: 'https://evil.example'}, body: {currentPassword: password, newPassword: 'new account test password'}}), 403);
    status(await f.request('/api/account/password', {cookie: user.cookie,
      headers: {'X-Meletio-User': 'different-user'}, body: {currentPassword: password, newPassword: 'new account test password'}}), 401);
    for (const body of [{currentPassword: password, newPassword: 'short'},
      {currentPassword: password, newPassword: 'new account test password', extra: true}]) {
      status(await f.request('/api/account/password', {cookie: user.cookie, body}), 400);
    }
    status(await f.request('/api/auth/me', {cookie: user.cookie}), 200);
    status(await f.request('/api/account/password', {body: {currentPassword: password, newPassword: 'new account test password'}}), 401);
  } finally { await f.close(); }
});

test('a login already deriving an old password cannot mint a session after password replacement', async () => {
  const f = await fixture({registration: 'open'});
  const authPrototype = Auth.prototype as unknown as {derive: (password: string, salt: string) => Promise<Buffer>};
  const derive = authPrototype.derive;
  let release!: () => void;
  let entered!: () => void;
  let blockedOnce = false;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let loginPromise: ReturnType<typeof f.request> | undefined;
  try {
    const user = await f.register('race@example.com');
    authPrototype.derive = async function(candidate, salt) {
      const key = await derive.call(this, candidate, salt);
      if (candidate === password && !blockedOnce) { blockedOnce = true; entered(); await blocked; }
      return key;
    };
    loginPromise = f.request('/api/auth/login', {body: {email: user.user.email, password}});
    await reached;
    status(await f.request('/api/account/password', {cookie: user.cookie,
      body: {currentPassword: password, newPassword: 'replacement password'}}), 200);
    release();
    const staleLogin = await loginPromise;
    assert.notEqual(staleLogin.response.status, 200, staleLogin.text);
    assert.equal(staleLogin.response.headers.get('set-cookie'), null);
    const sessions = f.database();
    try {
      assert.equal((sessions.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get() as {count: number}).count, 1);
    } finally { sessions.close(); }
  } finally {
    release();
    authPrototype.derive = derive;
    await loginPromise?.catch(() => undefined);
    await f.close();
  }
});

test('concurrent password replacements have one compare-and-swap winner', async () => {
  const f = await fixture({registration: 'open'});
  const authPrototype = Auth.prototype as unknown as {derive: (password: string, salt: string) => Promise<Buffer>};
  const derive = authPrototype.derive;
  let release!: () => void;
  let bothVerified!: () => void;
  let currentVerifications = 0;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const bothReached = new Promise<void>(resolve => { bothVerified = resolve; });
  let changes: Promise<Awaited<ReturnType<typeof f.request>>[]> | undefined;
  try {
    const user = await f.register('parallel-change@example.com');
    authPrototype.derive = async function(candidate, salt) {
      const key = await derive.call(this, candidate, salt);
      if (candidate === password && ++currentVerifications === 2) { bothVerified(); }
      if (candidate === password) await blocked;
      return key;
    };
    changes = Promise.all(['first replacement password', 'second replacement password'].map(newPassword =>
      f.request('/api/account/password', {cookie: user.cookie, body: {currentPassword: password, newPassword}})));
    await bothReached;
    release();
    const results = await changes;
    assert.deepEqual(results.map(result => result.response.status).sort(), [200, 409]);
    assert.deepEqual(results.find(result => result.response.status === 200)?.body, {changed: true});
    assert.equal((await f.request('/api/auth/me', {cookie: user.cookie})).response.status, 200);
    const winner = (await f.request('/api/auth/login', {body: {email: user.user.email, password: 'first replacement password'}})).response.status === 200
      ? 'first replacement password' : 'second replacement password';
    status(await f.request('/api/auth/login', {body: {email: user.user.email, password: winner}}), 200);
    const loser = winner === 'first replacement password' ? 'second replacement password' : 'first replacement password';
    status(await f.request('/api/auth/login', {body: {email: user.user.email, password: loser}}), 401);
  } finally {
    release();
    authPrototype.derive = derive;
    await changes?.catch(() => undefined);
    await f.close();
  }
});

test('logout while replacement hashing is in flight prevents the replacement', async () => {
  const f = await fixture({registration: 'open'});
  const authPrototype = Auth.prototype as unknown as {derive: (password: string, salt: string) => Promise<Buffer>};
  const derive = authPrototype.derive;
  let release!: () => void;
  let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let changing: ReturnType<typeof f.request> | undefined;
  try {
    const user = await f.register('logout-race@example.com');
    authPrototype.derive = async function(candidate, salt) {
      if (candidate === password) { entered(); await blocked; }
      return derive.call(this, candidate, salt);
    };
    changing = f.request('/api/account/password', {cookie: user.cookie,
      body: {currentPassword: password, newPassword: 'after logout password'}});
    await reached;
    status(await f.request('/api/auth/logout', {cookie: user.cookie, body: {}}), 200);
    release();
    status(await changing, 401);
    status(await f.request('/api/auth/login', {body: {email: user.user.email, password}}), 200);
  } finally {
    release();
    authPrototype.derive = derive;
    await changing?.catch(() => undefined);
    await f.close();
  }
});

test('session expiry while replacement hashing is in flight prevents mutation', async () => {
  const f = await fixture({registration: 'open'});
  const authPrototype = Auth.prototype as unknown as {derive: (password: string, salt: string) => Promise<Buffer>};
  const derive = authPrototype.derive;
  let release!: () => void;
  let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let changing: ReturnType<typeof f.request> | undefined;
  try {
    const user = await f.register('expiry-race@example.com');
    authPrototype.derive = async function(candidate, salt) {
      if (candidate === password) { entered(); await blocked; }
      return derive.call(this, candidate, salt);
    };
    changing = f.request('/api/account/password', {cookie: user.cookie,
      body: {currentPassword: password, newPassword: 'after expiry password'}});
    await reached;
    f.elapse(31 * 24 * 60 * 60 * 1000);
    release();
    status(await changing, 401);
    status(await f.request('/api/auth/login', {body: {email: user.user.email, password}}), 200);
  } finally {
    release();
    authPrototype.derive = derive;
    await changing?.catch(() => undefined);
    await f.close();
  }
});

test('password hashing cap rejects excess derivations and releases capacity after completion', async () => {
  const database = new DatabaseSync(':memory:');
  const auth = new Auth(database, Date.now);
  const derive = auth as unknown as {derive: (password: string, salt: string) => Promise<Buffer>};
  try {
    const first = derive.derive('parallel password one', 'a'.repeat(32));
    const second = derive.derive('parallel password two', 'b'.repeat(32));
    await assert.rejects(derive.derive('parallel password three', 'c'.repeat(32)), {code: 'busy'});
    await Promise.all([first, second]);
    assert.equal((await derive.derive('after release password', 'd'.repeat(32))).length, 64);
  } finally { database.close(); }
});

test('successful logins do not consume failed-login allowance and forwarded addresses are ignored', async () => {
  const f = await fixture({registration: 'open'});
  const authPrototype = Auth.prototype as unknown as {derive: (password: string, salt: string) => Promise<Buffer>};
  try {
    const user = await f.register('limits@example.com');
    const derive = authPrototype.derive;
    authPrototype.derive = async function(candidate, salt) {
      const {scryptSync} = await import('node:crypto');
      return scryptSync(candidate, salt, 64, {N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024});
    };
    try {
      for (let index = 0; index < 21; index++) {
        const login = await f.request('/api/auth/login', {body: {email: user.user.email, password},
          headers: {'X-Forwarded-For': `198.51.100.${index + 1}`}});
        status(login, 200);
      }
    } finally { authPrototype.derive = derive; }

    for (let index = 0; index < 20; index++) {
      const failure = await f.request('/api/auth/login', {body: {email: `unknown-${index}@example.com`, password: 'unknown account password'},
        headers: {'X-Forwarded-For': `198.51.100.${index + 1}`}});
      status(failure, 401);
    }
    const socketLimited = await f.request('/api/auth/login', {body: {email: 'unknown-20@example.com', password: 'unknown account password'},
      headers: {'X-Forwarded-For': '203.0.113.8'}});
    status(socketLimited, 429);
  } finally { await f.close(); }
});
