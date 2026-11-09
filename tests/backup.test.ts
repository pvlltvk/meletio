import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {openDatabase} from '../server/database';
import {createApplication} from '../server/app';
import {makePackage} from './helpers/anki-package';

type BackupModule = {backupDatabase(sourcePath: string, destinationPath: string): void | Promise<void>};
function backupModule(): BackupModule {
  try { return require('../scripts/backup.js') as BackupModule; }
  catch (error) { assert.fail(`Backup command is not built: ${error instanceof Error ? error.message : 'module unavailable'}`); }
}
const backupDatabase = async (sourcePath: string, destinationPath: string) => backupModule().backupDatabase(sourcePath, destinationPath);

async function sourceFixture(root: string) {
  const databasePath = join(root, 'source.sqlite');
  const db = openDatabase(databasePath);
  db.exec('PRAGMA wal_autocheckpoint = 0');
  const owners = ['ready', 'uploading', 'inspecting'].map(kind => ({
    id: randomUUID(), email: `${kind}@example.test`, token: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64), kind,
  }));
  const sessionExpiry = Date.now() + 60 * 60 * 1000;
  const mediaBytes = Buffer.from('synthetic-private-media');
  const answerWord = 'word-one';
  const attemptId = randomUUID();
  const snapshotId = randomUUID();
  const commitRequestId = randomUUID();
  for (const owner of owners) {
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(owner.id, owner.email, 'test-only-hash', 100);
    db.prepare('INSERT INTO auth_sessions VALUES (?, ?, ?, ?)').run(createHash('sha256').update(owner.token).digest('hex'), owner.id, sessionExpiry, 100);
  }
  const readyOwner = owners[0];
  db.prepare('INSERT INTO imported_media VALUES (?, ?, ?, ?, ?, ?)').run(
    'media-one', readyOwner.id, createHash('sha256').update(mediaBytes).digest('hex'), 'audio/mpeg', mediaBytes.length, mediaBytes,
  );
  db.prepare('INSERT INTO training_attempts VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    attemptId, readyOwner.id, 'everyday-el', 'completed', JSON.stringify({status: 'completed', correct: 1}), 101, 102,
  );
  db.prepare('INSERT INTO training_snapshots VALUES (?, ?, ?)').run(snapshotId, readyOwner.id, JSON.stringify({words: [{id: answerWord, term: 'saved term'}]}));
  db.prepare('INSERT INTO training_answers VALUES (?, ?, ?, ?, ?)').run(attemptId, 0, answerWord, 'choice-one', 1);
  db.prepare('INSERT INTO import_commits VALUES (?, ?, ?, ?, ?)').run(readyOwner.id, commitRequestId, 'fingerprint', JSON.stringify({deckId: 'private-set'}), 103);
  const stages: {id: string; directory: string; ownerId: string; status: string}[] = [];
  for (const owner of owners) {
    const directory = join(root, `stage-${owner.kind}`);
    await mkdir(directory, {mode: 0o700});
    await writeFile(join(directory, 'source-sentinel'), owner.kind, {mode: 0o600});
    const id = randomUUID();
    stages.push({id, directory, ownerId: owner.id, status: owner.kind});
    db.prepare('INSERT INTO import_stages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, owner.id, `request-${owner.kind}`, null, directory, owner.kind, 999999, 104, owner.kind === 'ready' ? '{}' : null, null,
    );
  }
  const sourceRows = {
    users: db.prepare('SELECT id,email,password_hash,created_at FROM users ORDER BY id').all(),
    auth_sessions: db.prepare('SELECT token_hash,user_id,expires_at,created_at FROM auth_sessions ORDER BY user_id').all(),
    media: db.prepare('SELECT id,owner_id,sha256,mime,size,bytes FROM imported_media').get(),
    attempts: db.prepare('SELECT id,user_id,deck_id,status,state,created_at,completed_at FROM training_attempts').get(),
    snapshots: db.prepare('SELECT id,owner_id,content FROM training_snapshots').get(),
    answers: db.prepare('SELECT attempt_id,position,word_id,option_id,correct FROM training_answers').all(),
    commits: db.prepare('SELECT owner_id,request_id,fingerprint,response,created_at FROM import_commits').all(),
  };
  const wal = `${databasePath}-wal`;
  assert((await stat(wal)).size > 0, 'Fixture must contain committed WAL writes before taking a backup.');
  return {db, databasePath, owners, stages, sourceRows, wal};
}

test('backup restores committed WAL data and media while clearing ephemeral stage references only in the snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'meletio-backup-'));
  const output = await mkdtemp(join(tmpdir(), 'meletio-backup-output-'));
  const backupPath = join(output, 'meletio.sqlite');
  let fixture: Awaited<ReturnType<typeof sourceFixture>> | undefined;
  let restored: DatabaseSync | undefined;
  let restoredApplication: ReturnType<typeof createApplication> | undefined;
  try {
    fixture = await sourceFixture(root);
    await backupDatabase(fixture.databasePath, backupPath);
    const mode = (await stat(backupPath)).mode & 0o777;
    assert.equal(mode, 0o600);
    assert((await stat(fixture.wal)).size > 0, 'Backing up must leave the source WAL in place.');
    for (const stage of fixture.stages) {
      assert.equal(await readFile(join(stage.directory, 'source-sentinel'), 'utf8'), stage.status);
    }
    restored = new DatabaseSync(backupPath);
    assert.equal((restored.prepare('PRAGMA integrity_check').get() as any).integrity_check, 'ok');
    assert.deepEqual(restored.prepare('SELECT id,email,password_hash,created_at FROM users ORDER BY id').all(), fixture.sourceRows.users);
    assert.deepEqual(restored.prepare('SELECT token_hash,user_id,expires_at,created_at FROM auth_sessions ORDER BY user_id').all(), fixture.sourceRows.auth_sessions);
    assert.deepEqual(restored.prepare('SELECT id,owner_id,sha256,mime,size,bytes FROM imported_media').get(), fixture.sourceRows.media);
    assert.deepEqual(restored.prepare('SELECT id,user_id,deck_id,status,state,created_at,completed_at FROM training_attempts').get(), fixture.sourceRows.attempts);
    assert.deepEqual(restored.prepare('SELECT id,owner_id,content FROM training_snapshots').get(), fixture.sourceRows.snapshots);
    assert.deepEqual(restored.prepare('SELECT attempt_id,position,word_id,option_id,correct FROM training_answers').all(), fixture.sourceRows.answers);
    assert.deepEqual(restored.prepare('SELECT owner_id,request_id,fingerprint,response,created_at FROM import_commits').all(), fixture.sourceRows.commits);
    assert.deepEqual(restored.prepare('SELECT status FROM import_stages').all(), []);
    restored.close(); restored = undefined;
    restoredApplication = createApplication({databasePath: backupPath, content: {uiLanguage: 'en', decks: []}, origin: 'http://127.0.0.1:4173'});
    await new Promise<void>((resolve, reject) => { restoredApplication!.server.once('error', reject); restoredApplication!.server.listen(0, '127.0.0.1', resolve); });
    const address = restoredApplication.server.address(); assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const sessionCookie = `meletio_session=${fixture.owners[0].token}`;
    const recovered = await fetch(`${base}/api/imports/current`, {headers: {Cookie: sessionCookie}});
    assert.deepEqual(await recovered.json(), {stage: null});
    const packageDirectory = await mkdtemp(join(root, 'package-'));
    const packageBytes = (await makePackage(packageDirectory)).bytes;
    const upload = await fetch(`${base}/api/imports/uploads`, {method: 'POST', headers: {
      Origin: 'http://127.0.0.1:4173', Cookie: sessionCookie, 'Content-Type': 'application/octet-stream',
      'X-Import-Request-Id': randomUUID(), 'X-Import-Filename': 'test.apkg',
    }, body: new Uint8Array(packageBytes)});
    assert.equal(upload.status, 201, await upload.text());
  } finally {
    if (restoredApplication) await restoredApplication.close();
    restored?.close();
    fixture?.db.close();
    await rm(root, {recursive: true, force: true});
    await rm(output, {recursive: true, force: true});
  }
});

test('backup requires a missing external destination and rejects missing sources, project paths, and symlink paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'meletio-backup-rules-'));
  let fixture: Awaited<ReturnType<typeof sourceFixture>> | undefined;
  try {
    fixture = await sourceFixture(root);
    backupModule();
    const existing = join(root, 'existing.sqlite');
    await writeFile(existing, 'preserve-existing-file');
    await assert.rejects(backupDatabase(fixture.databasePath, existing));
    assert.equal(await readFile(existing, 'utf8'), 'preserve-existing-file');
    const inProject = join(process.cwd(), `.meletio-backup-test-${randomUUID()}.sqlite`);
    await assert.rejects(backupDatabase(fixture.databasePath, inProject));
    const alias = join(root, 'project-alias');
    await symlink(resolve(process.cwd()), alias);
    await assert.rejects(backupDatabase(fixture.databasePath, join(alias, 'nested.sqlite')));
    await assert.rejects(backupDatabase(join(root, 'missing.sqlite'), join(root, 'missing-source-output.sqlite')));
    await assert.rejects(backupDatabase(fixture.databasePath, join(root, 'missing-parent', 'backup.sqlite')));
  } finally {
    fixture?.db.close();
    await rm(root, {recursive: true, force: true});
  }
});
