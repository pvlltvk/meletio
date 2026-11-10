import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import {createApplication} from '../server/app';

test('invalid registration policy is rejected before creating a database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'meletio-account-config-'));
  try {
    const databasePath = join(directory, 'not-created.sqlite');
    const options = {databasePath, content: {uiLanguage: 'en', decks: []}, origin: 'http://127.0.0.1:4173', registration: 'invalid'};
    assert.throws(() => createApplication(options as Parameters<typeof createApplication>[0]), /REGISTRATION must be open or closed/);
    assert.equal(existsSync(databasePath), false);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('server entrypoint rejects invalid registration environment values without creating data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'meletio-account-env-'));
  try {
    for (const registration of ['invalid', 'OPEN', '']) {
      const databasePath = join(directory, 'not-created.sqlite');
      const result = spawnSync(process.execPath, [resolve('dist/server/index.js')], {
        env: {...process.env, HOST: '127.0.0.1', PORT: '4173', SECURE_COOKIES: 'false', REGISTRATION: registration, DATABASE_PATH: databasePath},
        encoding: 'utf8', timeout: 5000
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /REGISTRATION must be open or closed/);
      assert.equal(existsSync(databasePath), false);
    }
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
