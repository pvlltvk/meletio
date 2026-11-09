import {randomBytes} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import sharp from 'sharp';
import {createApplication} from '../server/app';
import {makePackage, png, wav} from '../tests/helpers/anki-package';
import {prepare} from './prepare';

async function main() {
  const port = Number(process.argv[2] || '4194');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Provide a port between 1 and 65535.');
  const root = resolve(__dirname, '../..');
  const directory = await mkdtemp(join(tmpdir(), 'meletio-browser-'));
  const origin = `http://127.0.0.1:${port}`;
  let application: ReturnType<typeof createApplication> | undefined;
  let runnerDirectory: string | undefined;
  try {
    const packageDirectory = async (name: string) => {
      const path = join(directory, name);
      await mkdir(path);
      return path;
    };
    const notes = Array.from({length: 4}, (_, index) => ({guid: `browser-guid-${index}`, modified: 100,
      fields: [`λέξη ${index + 1}`, `<div>meaning &amp; ${index + 1}<img src="picture.png"></div>`, '[sound:voice.wav]']}));
    const base = await makePackage(await packageDirectory('base'), {notes, media: {'picture.png': png, 'voice.wav': wav()}});
    const update = await makePackage(await packageDirectory('update'), {notes: notes.map((note, index) => ({...note, modified: 200,
      fields: index === 0 ? ['replacement term', note.fields[1], note.fields[2]] : note.fields})), media: {'picture.png': png, 'voice.wav': wav()}});
    const image = await sharp(randomBytes(640 * 640 * 3), {raw: {width: 640, height: 640, channels: 3}}).png().toBuffer();
    const smart = await makePackage(await packageDirectory('smart'), {
      decks: {'1': {id: 1, name: 'Default', dyn: 0}, '2': {id: 2, name: 'Synthetic Greek', dyn: 0}, '3': {id: 3, name: 'Other', dyn: 0}},
      notes: notes.map((note, index) => ({...note, deckIds: ['2'], fields: [note.fields[0], `meaning ${index + 1}`, '', '<img src="picture.png">', index < 3 ? '[sound:voice.wav]' : '']})),
      noteTypes: {'100': {id: 100, name: 'Vocabulary', type: 0,
        flds: ['Term', 'Meaning', 'Pronunciation', 'Picture', 'Audio'].map((name, ord) => ({name, ord})),
        tmpls: [{name: 'Card 1', ord: 0, qfmt: '{{Term}}', afmt: '{{Meaning}}'}], css: ''}},
      media: {'picture.png': image, 'voice.wav': wav()}
    });
    const child = await makePackage(await packageDirectory('child'), {notes: notes.map(note => ({...note, deckIds: ['2']})), media: {'picture.png': png, 'voice.wav': wav()}});
    const suites: [string, Record<string, unknown>][] = [
      ['browser-check', {url: origin + '/preview.html'}],
      ['backend-browser-check', {url: origin + '/'}],
      ['import-browser-check', {url: origin + '/', packagePath: base.archivePath, updatePackagePath: update.archivePath}],
      ['media-import-browser-check', {url: origin + '/', packagePath: smart.archivePath}],
      ['polish-browser-check', {url: origin + '/', packagePath: base.archivePath, updatePackagePath: update.archivePath}],
      ['polish-recovery-browser-check', {url: origin + '/', packagePath: child.archivePath}],
      ['follow-up-browser-check', {url: origin + '/', packagePath: base.archivePath}]
    ];
    await mkdir(join(root, 'artifacts'), {recursive: true});
    runnerDirectory = await mkdtemp(join(root, 'artifacts/browser-'));
    const runners: Record<string, string> = {};
    for (const [name, options] of suites) {
      const source = await readFile(join(root, 'tests', name + '.js'), 'utf8');
      const filename = join(runnerDirectory, name + '.js');
      await writeFile(filename, `async page => (${source.trim()})(page, ${JSON.stringify(options)})\n`, {mode: 0o600});
      runners[name] = filename;
    }
    application = createApplication({databasePath: join(directory, 'app.sqlite'), content: prepare(root), origin});
    await new Promise<void>((done, reject) => {
      application!.server.once('error', reject);
      application!.server.listen(port, '127.0.0.1', done);
    });
    const manifest = {url: origin + '/', directory, runners};
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), {mode: 0o600});
    console.log(JSON.stringify(manifest, null, 2));
    const stop = async () => {
      await application!.close();
      await rm(directory, {recursive: true, force: true});
      await rm(runnerDirectory!, {recursive: true, force: true});
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void stop().catch(error => { console.error(error.message); process.exitCode = 1; }); });
  } catch (error) {
    if (application) await application.close();
    await rm(directory, {recursive: true, force: true});
    if (runnerDirectory) await rm(runnerDirectory, {recursive: true, force: true});
    throw error;
  }
}

void main().catch(error => { console.error(error instanceof Error ? error.message : 'Could not start browser checks.'); process.exitCode = 1; });
