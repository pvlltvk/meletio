const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const {mkdtemp, mkdir, rm} = require('node:fs/promises');
const {makePackage, png, wav} = require('../dist/tests/helpers/anki-package.js');
const {createServer} = require('node:net');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const {once} = require('node:events');

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-restart-'));
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let child;
  let cookie;
  async function start(registration = 'closed') {
    child = spawn(process.execPath, [resolve('dist/server/index.js')], {
      env: {...process.env, HOST: '127.0.0.1', PORT: String(port), APP_ORIGIN: origin,
        DATABASE_PATH: join(directory, 'app.sqlite'), SECURE_COOKIES: 'false', REGISTRATION: registration},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server did not become ready')), 10000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('Server exited before becoming ready')); });
      child.stdout.on('data', data => {
        if (String(data).includes('Meletio:')) { clearTimeout(timeout); resolve(); }
      });
    });
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(timeout); child = undefined; }
  }
  async function request(path, body) {
    const response = await fetch(origin + path, {method: body === undefined ? 'GET' : 'POST',
      headers: {Origin: origin, 'Content-Type': 'application/json', ...(cookie ? {Cookie: cookie} : {})},
      body: body === undefined ? undefined : JSON.stringify(body)});
    const result = await response.json();
    assert(response.ok, `HTTP ${response.status}: ${result.error?.code || 'request failed'}`);
    const session = response.headers.get('set-cookie');
    if (session) cookie = session.split(';')[0];
    return result;
  }
  try {
    await start('open');
    const index = await fetch(origin);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /data-server="true"/);
    await request('/api/auth/register', {email: 'restart@example.com', password: 'a process restart password'});
    const {attempt} = await request('/api/training', {deckId: 'everyday-el', requestId: randomUUID()});
    const body = {position: 0, revision: attempt.revision, optionId: attempt.questions[0].word.id, requestId: randomUUID()};
    const {attempt: answered} = await request(`/api/training/${attempt.id}/answer`, body);
    const previousCookie = cookie;
    assert.deepEqual(await request('/api/account/password', {
      currentPassword: 'a process restart password', newPassword: 'a replaced process password'
    }), {changed: true});
    assert.equal(cookie, previousCookie);
    await stop();
    await start();
    assert.deepEqual(await request('/api/auth/config'), {registrationOpen: false});
    await request('/api/auth/me');
    const oldLogin = await fetch(origin + '/api/auth/login', {method: 'POST',
      headers: {Origin: origin, 'Content-Type': 'application/json'},
      body: JSON.stringify({email: 'restart@example.com', password: 'a process restart password'})});
    assert.equal(oldLogin.status, 401);
    await request('/api/auth/login', {email: 'restart@example.com', password: 'a replaced process password'});
    const resumed = await request('/api/training?deckId=everyday-el');
    assert.deepEqual(resumed.attempt, answered);
    const replay = await request(`/api/training/${attempt.id}/answer`, body);
    assert.deepEqual(replay.attempt, answered);
    const advanced = await request(`/api/training/${attempt.id}/advance`, {
      position: 0, revision: answered.revision, requestId: randomUUID(),
    });
    assert.equal(advanced.attempt.position, 1);
    assert.equal(advanced.attempt.answers.length, 1);
    console.log('PASS: spawned server restart preserves SQLite session, question order, feedback and mutation receipts');
    console.log('PASS: changed password and retained session survive restart with registration closed');
    const sourceDirectory = join(directory, 'source-package');
    await mkdir(sourceDirectory);
    const archive = await makePackage(sourceDirectory, {
      notes: Array.from({length: 4}, (_, index) => ({guid: `restart-guid-${index}`,
        fields: [`word ${index}`, `meaning ${index}<img src="book.png">`, '[sound:voice.wav]']})),
      media: {'book.png': png, 'voice.wav': wav()},
    });
    const uploadResponse = await fetch(origin + '/api/imports/uploads', {method: 'POST',
      headers: {Origin: origin, Cookie: cookie, 'Content-Type': 'application/octet-stream',
        'X-Import-Request-Id': randomUUID(), 'X-Import-Filename': 'restart.apkg'}, body: archive.bytes});
    assert(uploadResponse.ok, 'Import upload failed during process smoke');
    const staged = await uploadResponse.json();
    const preview = await request(`/api/imports/${staged.uploadId}/preview`, {
      sourceDeckId: '1', noteTypeId: '100', includeChildren: false, title: 'Restart private vocabulary',
      mapping: {term: 'Term', meaning: 'Meaning', image: 'Meaning', audio: 'Audio'},
      termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr',
    });
    const commitBody = {previewId: preview.previewId, requestId: randomUUID(), acceptSkipped: false};
    const committed = await request(`/api/imports/${staged.uploadId}/commit`, commitBody);
    const importedDeck = (await request(`/api/decks/${committed.deckId}`)).deck;
    const importedAttempt = (await request('/api/training?format=compact', {deckId: committed.deckId, requestId: randomUUID()})).attempt;
    const importedSnapshot = (await request(`/api/training/${importedAttempt.id}/snapshot`)).snapshot;
    await stop();
    await start();
    assert.deepEqual((await request(`/api/decks/${committed.deckId}`)).deck, importedDeck);
    assert.deepEqual((await request(`/api/training/${importedAttempt.id}/snapshot`)).snapshot, importedSnapshot);
    const committedReplay = await request(`/api/imports/${staged.uploadId}/commit`, commitBody);
    assert.deepEqual(committedReplay, committed);
    for (const [mediaPath, expected] of [[importedDeck.words[0].image, png], [importedDeck.words[0].audio, wav()]]) {
      const response = await fetch(origin + mediaPath, {headers: {Cookie: cookie}});
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
    }
    console.log('PASS: private imported deck, media, training snapshot and commit receipt survive a real process restart');

  } finally { await stop(); await rm(directory, {recursive: true, force: true}); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
