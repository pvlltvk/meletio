const {mkdtemp, cp, rm} = require('node:fs/promises');
const {spawnSync} = require('node:child_process');
const {tmpdir} = require('node:os');
const {join, basename, resolve} = require('node:path');

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-source-'));
  const root = resolve(__dirname, '..');
  try {
    for (const name of ['server', 'scripts', 'web', 'tests', 'assets', 'docs', 'package.json', 'package-lock.json', 'tsconfig.json', 'Makefile', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.gitignore', '.env.example']) {
      await cp(join(root, name), join(directory, name), {recursive: true, filter: path => !['__pycache__', 'data.js', 'preview.html', 'provenance.json'].includes(basename(path))});
    }
    for (const [command, args] of [['npm', ['ci', '--no-audit', '--no-fund']], ['make', ['check', 'build']], [process.execPath, ['tests/restart-smoke.js']]]) {
      const result = spawnSync(command, args, {cwd: directory, stdio: 'inherit'});
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
    }
    console.log('PASS: source-only npm ci, checks, build and server restart smoke');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
