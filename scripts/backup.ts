import {chmodSync, closeSync, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, realpathSync, rmSync, statSync} from 'node:fs';
import {basename, dirname, isAbsolute, join, resolve, sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export function backupDatabase(sourcePath: string, destinationPath: string): void {
  if (!destinationPath || !isAbsolute(destinationPath)) throw new Error('Provide an absolute backup destination outside the project.');
  const source = realpathSync(sourcePath);
  if (!statSync(source).isFile()) throw new Error('The source database must be an existing file.');
  const project = realpathSync(resolve(__dirname, '../..'));
  const parent = realpathSync(dirname(destinationPath));
  if (!statSync(parent).isDirectory()) throw new Error('The backup destination directory must exist.');
  if (parent === project || parent.startsWith(project + sep)) throw new Error('The backup destination must be outside the project.');
  const destination = join(parent, basename(destinationPath));
  if (lstatSync(destination, {throwIfNoEntry: false})) throw new Error('The backup destination already exists.');
  const directory = mkdtempSync(join(parent, '.meletio-backup-'));
  try {
    chmodSync(directory, 0o700);
    const temporary = join(directory, 'snapshot.sqlite');
    const database = new DatabaseSync(source, {readOnly: true});
    try {
      database.exec('PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000;');
      database.prepare('VACUUM INTO ?').run(temporary);
    } finally { database.close(); }
    chmodSync(temporary, 0o600);
    const snapshot = new DatabaseSync(temporary);
    try {
      snapshot.exec('PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON;');
      const stages = snapshot.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'import_stages'").get();
      if (stages) snapshot.exec('DELETE FROM import_stages;');
      const integrity = snapshot.prepare('PRAGMA integrity_check').all();
      if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('The backup failed its integrity check.');
    } finally { snapshot.close(); }
    const file = openSync(temporary, 'r');
    try { fsyncSync(file); } finally { closeSync(file); }
    linkSync(temporary, destination);
  } finally { rmSync(directory, {recursive: true, force: true}); }
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node dist/scripts/backup.js /absolute/external/backup.sqlite');
    backupDatabase(resolve(process.env.DATABASE_PATH || 'data/meletio.sqlite'), process.argv[2]);
    console.log(`Backup saved: ${process.argv[2]}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Could not back up the database.');
    process.exitCode = 1;
  }
}
