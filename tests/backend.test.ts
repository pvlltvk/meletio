import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {createApplication} from '../server/app';

const origin = 'http://127.0.0.1:4173';
const password = 'a long test password';
const makeDeck = (id: string, termLang = 'el', termDir = 'ltr') => ({
  id, title: id, termLang, meaningLang: 'en', termDir, meaningDir: 'ltr',
  words: Array.from({length: 10}, (_, index) => ({
    id: String(index + 1), term: `term ${index + 1}`, meaning: `meaning ${index + 1}`,
    termLang, meaningLang: 'en', image: null, audio: null,
  })),
});
const content = {uiLanguage: 'en', decks: [makeDeck('greek'), makeDeck('arabic', 'ar', 'rtl')]};
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Attempt = {
  id: string; deckId: string; status: string; revision: number;
  deck: typeof content.decks[number];
  questions: {word: {id: string; term: string}; options: {id: string; term: string}[]}[];
  answers: {word: {id: string}; optionId: string; correct: boolean}[];
  position: number; selected: string | null; completedAt: number | string | null;
};

async function fixture(options: {secureCookies?: boolean} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-backend-'));
  const databasePath = join(directory, 'app.sqlite');
  let instant = Date.now();
  let app: ReturnType<typeof createApplication>;
  let base = '';
  async function open(nextContent = structuredClone(content)) {
    app = createApplication({databasePath, content: nextContent, origin, registration: 'open',
      secureCookies: options.secureCookies ?? false, now: () => instant});
    await new Promise<void>((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', resolve);
    });
    const address = app.server.address();
    assert(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
  }
  await open();
  async function request(path: string, options: {
    method?: string; body?: unknown; cookie?: string; headers?: Record<string, string>; raw?: string;
  } = {}) {
    const method = options.method ?? (options.body === undefined && options.raw === undefined ? 'GET' : 'POST');
    const headers: Record<string, string> = {};
    if (method !== 'GET') { headers.Origin = origin; headers['Content-Type'] = 'application/json'; }
    if (options.cookie) headers.Cookie = options.cookie;
    Object.assign(headers, options.headers);
    const response = await fetch(base + path, {method, headers,
      body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body))});
    const text = await response.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = text; }
    return {response, body, text};
  }
  async function register(email = 'learner@example.com') {
    const result = await request('/api/auth/register', {body: {email, password}});
    assert(result.response.ok, result.text);
    assert.equal(result.body.user.email, email.trim().toLowerCase());
    assert.equal(typeof result.body.user.id, 'string');
    const setCookie = result.response.headers.get('set-cookie');
    assert(setCookie);
    assert(setCookie.startsWith('meletio_session='));
    return {cookie: setCookie.split(';')[0], user: result.body.user, setCookie};
  }
  async function start(cookie: string, deckId = 'greek', requestId = randomUUID()) {
    const result = await request('/api/training', {cookie, body: {deckId, requestId}});
    assert(result.response.ok, result.text);
    return result.body.attempt as Attempt;
  }
  async function answer(cookie: string, attempt: Attempt, correct = true, requestId = randomUUID()) {
    const question = attempt.questions[attempt.position];
    const optionId = correct ? question.word.id : question.options.find(option => option.id !== question.word.id)!.id;
    const body = {position: attempt.position, optionId, revision: attempt.revision, requestId};
    const result = await request(`/api/training/${attempt.id}/answer`, {cookie, body});
    assert(result.response.ok, result.text);
    return result.body.attempt as Attempt;
  }
  async function advance(cookie: string, attempt: Attempt, requestId = randomUUID()) {
    const result = await request(`/api/training/${attempt.id}/advance`, {cookie,
      body: {position: attempt.position, revision: attempt.revision, requestId}});
    assert(result.response.ok, result.text);
    return result.body.attempt as Attempt;
  }
  async function complete(cookie: string, attempt: Attempt, missed = new Set<string>()) {
    while (attempt.position < attempt.questions.length) {
      const target = attempt.questions[attempt.position].word.id;
      attempt = await answer(cookie, attempt, !missed.has(target));
      attempt = await advance(cookie, attempt);
    }
    assert.equal(attempt.status, 'completed');
    return attempt;
  }
  return {databasePath, request, register, start, answer, advance, complete,
    elapse(milliseconds: number) { instant += milliseconds; },
    async restart(nextContent = structuredClone(content)) { await app.close(); await open(nextContent); },
    async close() { await app.close(); await rm(directory, {recursive: true, force: true}); }};
}

async function using(run: (fixture: Fixture) => Promise<void>, options: {secureCookies?: boolean} = {}) {
  const app = await fixture(options);
  try { await run(app); } finally { await app.close(); }
}

function error(result: Awaited<ReturnType<Fixture['request']>>, status: number) {
  assert.equal(result.response.status, status, result.text);
  assert.equal(typeof result.body.error.code, 'string');
  assert.equal(typeof result.body.error.message, 'string');
}

test('auth stores hashes, canonicalizes email, rotates and revokes session tokens', async () => using(async app => {
  const {cookie, user, setCookie} = await app.register('  Learner@EXAMPLE.COM ');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Path=\//i);
  const current = await app.request('/api/auth/me', {cookie});
  assert.equal(current.response.status, 200);
  assert.deepEqual(current.body.user, user);
  assert.match(current.response.headers.get('cache-control') ?? '', /no-store/);
  error(await app.request('/api/auth/register', {body: {email: user.email, password}}), 409);
  error(await app.request('/api/auth/login', {body: {email: user.email, password: 'wrong password'}}), 401);
  const login = await app.request('/api/auth/login', {body: {email: user.email, password}});
  assert(login.response.ok, login.text);
  const nextCookie = login.response.headers.get('set-cookie')!.split(';')[0];
  assert.notEqual(nextCookie, cookie);
  const database = new DatabaseSync(app.databasePath);
  try {
    const users = JSON.stringify(database.prepare('SELECT * FROM users').all());
    const sessions = JSON.stringify(database.prepare('SELECT * FROM auth_sessions').all());
    assert(!users.includes(password));
    assert(!sessions.includes(cookie.split('=')[1]));
    assert(!sessions.includes(nextCookie.split('=')[1]));
  } finally { database.close(); }
  const logout = await app.request('/api/auth/logout', {cookie: nextCookie, body: {}});
  assert(logout.response.ok, logout.text);
  error(await app.request('/api/auth/me', {cookie: nextCookie}), 401);
  error(await app.request('/api/auth/me', {cookie: 'meletio_session=invalid'}), 401);
}));

test('sessions expire and secure cookie configuration is honored', async () => using(async app => {
  const {cookie, setCookie} = await app.register();
  assert.match(setCookie, /;\s*Secure(?:;|$)/i);
  app.elapse(31 * 24 * 60 * 60 * 1000);
  error(await app.request('/api/auth/me', {cookie}), 401);
  error(await app.request('/api/training?deckId=greek', {cookie}), 401);
}, {secureCookies: true}));

test('private routes reject anonymous requests and account ownership covers read/write/retry', async () => using(async app => {
  const first = await app.register();
  const second = await app.register('second@example.com');
  const attempt = await app.start(first.cookie);
  for (const path of ['/api/auth/me', '/api/decks', '/api/training?deckId=greek', '/api/results?deckId=greek', `/api/training/${attempt.id}`]) {
    error(await app.request(path), 401);
  }
  error(await app.request(`/api/training/${attempt.id}`, {cookie: second.cookie}), 404);
  for (const operation of ['answer', 'advance', 'retry']) {
    const body: Record<string, unknown> = {requestId: randomUUID()};
    if (operation !== 'retry') Object.assign(body, {position: 0, revision: 0});
    if (operation === 'answer') body.optionId = attempt.questions[0].word.id;
    error(await app.request(`/api/training/${attempt.id}/${operation}`, {cookie: second.cookie, body}), 404);
  }
  const otherProgress = await app.request('/api/training?deckId=greek', {cookie: second.cookie});
  assert.equal(otherProgress.body.attempt, null);
  assert.equal(otherProgress.body.latestResult, null);
  const otherResults = await app.request('/api/results?deckId=greek', {cookie: second.cookie});
  assert.deepEqual(otherResults.body.results, []);
}));

test('unsafe origins, malformed JSON, invalid credentials and oversized bodies are rejected', async () => using(async app => {
  for (const hostileOrigin of ['https://evil.example', 'null', '']) {
    error(await app.request('/api/auth/register', {body: {email: 'test@example.com', password}, headers: {Origin: hostileOrigin}}), 403);
  }
  error(await app.request('/api/auth/register', {raw: '{'}), 400);
  error(await app.request('/api/auth/register', {raw: '{}', headers: {'Content-Type': 'text/plain'}}), 415);
  error(await app.request('/api/auth/register', {raw: JSON.stringify({padding: 'x'.repeat(1024 * 1024)})}), 413);
  for (const fields of [{email: 'invalid', password}, {email: 'x@y.example', password: 'short'},
    {email: 'x@y.example', password: 'x'.repeat(257)}, {email: 123, password}, {email: 'x@y.example', password: null}]) {
    error(await app.request('/api/auth/register', {body: fields}), 400);
  }
  const {cookie} = await app.register();
  error(await app.request('/api/training', {cookie, body: {deckId: 'greek', requestId: randomUUID()},
    headers: {Origin: 'https://evil.example', Host: 'evil.example'}}), 403);
}));

test('server serves only explicit public files and does not leak sources or SQLite', async () => using(async app => {
  const index = await app.request('/');
  assert.equal(index.response.status, 200);
  assert.match(index.response.headers.get('content-type') ?? '', /text\/html/);
  for (const path of ['/server/app.ts', '/web/decks.json', '/data/meletio.sqlite', '/.env', '/package.json',
    '/%2e%2e%2fserver/app.ts', '/assets/../../server/app.ts', '/.git/config']) {
    const result = await app.request(path);
    assert([400, 403, 404].includes(result.response.status), `${path}: ${result.response.status}`);
  }
}));

test('attempt creation uses shared multiple-choice rules and per-deck state', async () => using(async app => {
  const {cookie} = await app.register();
  const decks = await app.request('/api/decks', {cookie});
  assert.equal(decks.response.status, 200);
  const first = await app.start(cookie);
  assert.equal(first.revision, 0);
  assert.equal(first.status, 'active');
  assert.equal(first.position, 0);
  assert.equal(first.selected, null);
  assert.deepEqual(first.answers, []);
  assert.equal(first.questions.length, 10);
  for (const question of first.questions) {
    assert.equal(question.options.length, 4);
    assert.equal(new Set(question.options.map(option => option.id)).size, 4);
    assert(question.options.some(option => option.id === question.word.id));
  }
  const arabic = await app.start(cookie, 'arabic');
  assert.equal(arabic.deck.termDir, 'rtl');
  const resume = await app.request('/api/training?deckId=greek', {cookie});
  assert.equal(resume.body.attempt.id, first.id);
}));

test('answers are authoritative, first-choice only, and separate from advance', async () => using(async app => {
  const {cookie} = await app.register();
  const first = await app.start(cookie);
  const root = `/api/training/${first.id}`;
  error(await app.request(root + '/advance', {cookie,
    body: {position: 0, revision: 0, requestId: randomUUID()}}), 409);
  error(await app.request(root + '/answer', {cookie,
    body: {position: 0, optionId: 'forged-option', revision: 0, requestId: randomUUID()}}), 400);
  error(await app.request(root + '/answer', {cookie,
    body: {position: 1, optionId: first.questions[0].word.id, revision: 0, requestId: randomUUID()}}), 409);
  const answered = await app.answer(cookie, first, false);
  assert.equal(answered.answers.length, 1);
  assert.equal(answered.answers[0].correct, false);
  assert.equal(answered.position, 0);
  assert.equal(answered.revision, 1);
  assert.notEqual(answered.selected, first.questions[0].word.id);
  error(await app.request(root + '/answer', {cookie,
    body: {position: 0, optionId: first.questions[0].word.id, revision: answered.revision, requestId: randomUUID()}}), 409);
  const advanced = await app.advance(cookie, answered);
  assert.equal(advanced.position, 1);
  assert.equal(advanced.selected, null);
  assert.equal(advanced.answers.length, 1);
  assert.equal(advanced.revision, 2);
  error(await app.request(root + '/advance', {cookie,
    body: {position: 0, revision: answered.revision, requestId: randomUUID()}}), 409);
}));

test('mutation receipts replay lost responses and reject key reuse with changed input', async () => using(async app => {
  const {cookie} = await app.register();
  const createId = randomUUID();
  const first = await app.start(cookie, 'greek', createId);
  assert.deepEqual(await app.start(cookie, 'greek', createId), first);
  error(await app.request('/api/training', {cookie, body: {deckId: 'arabic', requestId: createId}}), 409);
  const requestId = randomUUID();
  const body = {position: 0, optionId: first.questions[0].word.id, revision: 0, requestId};
  const initial = await app.request(`/api/training/${first.id}/answer`, {cookie, body});
  assert(initial.response.ok, initial.text);
  const replay = await app.request(`/api/training/${first.id}/answer`, {cookie, body});
  assert(replay.response.ok, replay.text);
  assert.deepEqual(replay.body, initial.body);
  const alternate = first.questions[0].options.find(option => option.id !== body.optionId)!.id;
  error(await app.request(`/api/training/${first.id}/answer`, {cookie, body: {...body, optionId: alternate}}), 409);
  const advanceId = randomUUID();
  const advanced = await app.advance(cookie, initial.body.attempt, advanceId);
  assert.deepEqual(await app.advance(cookie, initial.body.attempt, advanceId), advanced);
  const fresh = await app.request(`/api/training/${first.id}`, {cookie});
  assert.equal(fresh.body.attempt.answers.length, 1);
  assert.equal(fresh.body.attempt.position, 1);
}));

test('SQLite restart retains feedback, question order, content snapshot, cookies and receipts', async () => using(async app => {
  const {cookie} = await app.register();
  const first = await app.start(cookie);
  const requestId = randomUUID();
  const answered = await app.answer(cookie, first, false, requestId);
  const modified = structuredClone(content);
  modified.decks[0].words[0].term = 'edited after attempt creation';
  await app.restart(modified);
  const resumed = await app.request('/api/training?deckId=greek', {cookie});
  assert.equal(resumed.response.status, 200);
  assert.deepEqual(resumed.body.attempt, answered);
  const replay = await app.answer(cookie, first, false, requestId);
  assert.deepEqual(replay, answered);
  const next = await app.advance(cookie, answered);
  assert.equal(next.position, 1);
}));

test('completed results persist and missed-word retry has full-deck distractors', async () => using(async app => {
  const {cookie} = await app.register();
  const initial = await app.start(cookie);
  const missedId = initial.questions[0].word.id;
  const completed = await app.complete(cookie, initial, new Set([missedId]));
  assert.equal(completed.answers.filter(answer => answer.correct).length, 9);
  assert.equal(completed.position, 10);
  assert(completed.completedAt);
  const results = await app.request('/api/results?deckId=greek', {cookie});
  assert.equal(results.body.results.length, 1);
  assert.equal(results.body.results[0].id, completed.id);
  assert.equal(results.body.results[0].correct, 9);
  assert.equal(results.body.results[0].total, 10);
  const resume = await app.request('/api/training?deckId=greek', {cookie});
  assert.equal(resume.body.attempt, null);
  assert.equal(resume.body.latestResult.id, completed.id);
  const requestId = randomUUID();
  const retry = await app.request(`/api/training/${completed.id}/retry`, {cookie, body: {requestId}});
  assert(retry.response.ok, retry.text);
  assert.equal(retry.body.attempt.questions.length, 1);
  assert.equal(retry.body.attempt.questions[0].word.id, missedId);
  assert.equal(retry.body.attempt.questions[0].options.length, 4);
  const replay = await app.request(`/api/training/${completed.id}/retry`, {cookie, body: {requestId}});
  assert.deepEqual(replay.body, retry.body);
  const perfectRetry = await app.complete(cookie, retry.body.attempt);
  error(await app.request(`/api/training/${perfectRetry.id}/retry`, {cookie, body: {requestId: randomUUID()}}), 400);
  await app.restart();
  const persisted = await app.request(`/api/training/${completed.id}`, {cookie});
  assert.deepEqual(persisted.body.attempt, completed);
}));

test('new attempts supersede only the same user/deck and old writes cannot mutate them', async () => using(async app => {
  const {cookie} = await app.register();
  const old = await app.start(cookie);
  const arabic = await app.start(cookie, 'arabic');
  const fresh = await app.start(cookie);
  assert.notEqual(fresh.id, old.id);
  error(await app.request(`/api/training/${old.id}/answer`, {cookie,
    body: {position: 0, optionId: old.questions[0].word.id, revision: 0, requestId: randomUUID()}}), 409);
  const prior = await app.request(`/api/training/${old.id}`, {cookie});
  assert.equal(prior.body.attempt.status, 'superseded');
  const unaffected = await app.request('/api/training?deckId=arabic', {cookie});
  assert.equal(unaffected.body.attempt.id, arabic.id);
}));

test('parallel conflicting answers accept one first choice with one revision', async () => using(async app => {
  const {cookie} = await app.register();
  const first = await app.start(cookie);
  const question = first.questions[0];
  const alternatives = [question.word.id, question.options.find(option => option.id !== question.word.id)!.id];
  const responses = await Promise.all(alternatives.map(optionId => app.request(`/api/training/${first.id}/answer`, {cookie,
    body: {position: 0, optionId, revision: 0, requestId: randomUUID()}})));
  assert.equal(responses.filter(result => result.response.ok).length, 1);
  assert.equal(responses.filter(result => result.response.status === 409).length, 1);
  const current = await app.request(`/api/training/${first.id}`, {cookie});
  assert.equal(current.body.attempt.answers.length, 1);
  assert.equal(current.body.attempt.revision, 1);
}));

test('mutation input validation rejects malformed state instead of coercing it', async () => using(async app => {
  const {cookie} = await app.register();
  const first = await app.start(cookie);
  for (const body of [null, [], {}, {deckId: 'greek', requestId: ''}, {deckId: 'greek', requestId: 'x'.repeat(1000)}]) {
    error(await app.request('/api/training', {cookie, body}), 400);
  }
  for (const patch of [{position: '0'}, {position: -1}, {revision: '0'}, {revision: 0.5}, {optionId: 1}, {requestId: ''}]) {
    error(await app.request(`/api/training/${first.id}/answer`, {cookie,
      body: {position: 0, revision: 0, optionId: first.questions[0].word.id, requestId: randomUUID(), ...patch}}), 400);
  }
}));

test('repeated wrong logins are throttled without trusting forwarded addresses', async () => using(async app => {
  let throttled = false;
  for (let index = 0; index < 40; index++) {
    const result = await app.request('/api/auth/login', {body: {email: 'absent@example.com', password},
      headers: {'X-Forwarded-For': `192.0.2.${index}`}});
    if (result.response.status === 429) { throttled = true; break; }
    assert.equal(result.response.status, 401, result.text);
  }
  assert(throttled, 'login attempts should hit a bounded per-socket-address limit');
}));

test('unknown future SQLite schema is rejected instead of being overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-schema-'));
  const databasePath = join(directory, 'future.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA user_version = 999');
  database.close();
  try {
    assert.throws(() => createApplication({databasePath, content: structuredClone(content), origin}), /schema|version/i);
    const reopened = new DatabaseSync(databasePath);
    try { assert.equal(reopened.prepare('PRAGMA user_version').get()!.user_version, 999); }
    finally { reopened.close(); }
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('idempotency keys are scoped per learner and forged client scores are rejected', async () => using(async app => {
  const first = await app.register();
  const second = await app.register('other@example.com');
  const requestId = randomUUID();
  const attempt = await app.start(first.cookie, 'greek', requestId);
  const other = await app.start(second.cookie, 'greek', requestId);
  assert.notEqual(attempt.id, other.id);
  const wrongId = attempt.questions[0].options.find(option => option.id !== attempt.questions[0].word.id)!.id;
  const result = await app.request(`/api/training/${attempt.id}/answer`, {cookie: first.cookie,
    body: {position: 0, revision: 0, optionId: wrongId, correct: true, requestId: randomUUID()}});
  if (result.response.ok) assert.equal(result.body.attempt.answers[0].correct, false);
  else error(result, 400);
}));

test('logging in with an existing session rotates and invalidates its cookie', async () => using(async app => {
  const {cookie, user} = await app.register();
  const login = await app.request('/api/auth/login', {cookie, body: {email: user.email, password}});
  assert(login.response.ok, login.text);
  const replacement = login.response.headers.get('set-cookie')!.split(';')[0];
  assert.notEqual(cookie, replacement);
  error(await app.request('/api/auth/me', {cookie}), 401);
  assert.equal((await app.request('/api/auth/me', {cookie: replacement})).response.status, 200);
}));

test('stale account headers cannot create practice or revoke a different learner session', async () => using(async app => {
  const first = await app.register();
  const second = await app.register('switched@example.com');
  const headers = {'X-Meletio-User': first.user.id};
  error(await app.request('/api/training', {cookie: second.cookie, headers,
    body: {deckId: 'greek', requestId: randomUUID()}}), 401);
  const untouched = await app.request('/api/training?deckId=greek', {cookie: second.cookie});
  assert.equal(untouched.body.attempt, null);
  error(await app.request('/api/auth/logout', {cookie: second.cookie, headers, body: {}}), 401);
  const current = await app.request('/api/auth/me', {cookie: second.cookie});
  assert.equal(current.response.status, 200);
  assert.equal(current.body.user.id, second.user.id);
  const created = await app.request('/api/training', {cookie: second.cookie,
    headers: {'X-Meletio-User': second.user.id}, body: {deckId: 'greek', requestId: randomUUID()}});
  assert(created.response.ok, created.text);
  assert.equal(created.body.attempt.deckId, 'greek');
  const logout = await app.request('/api/auth/logout', {cookie: second.cookie,
    headers: {'X-Meletio-User': second.user.id}, body: {}});
  assert(logout.response.ok, logout.text);
  error(await app.request('/api/auth/me', {cookie: second.cookie}), 401);
}));
