import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, relative, isAbsolute, sep} from 'node:path';
import {test} from 'node:test';
import {extractField} from '../server/import-html';
import {parsePackage} from '../server/import-package';
import {IMPORT_LIMITS} from '../server/import-types';
import {inspectPackageInChild} from '../server/import-worker';
import {ApiError} from '../server/types';
import {makePackage, png, wav, writeZip, type PackageOptions, type ZipEntry} from './helpers/anki-package';

async function temporary(run: (directory: string, stage: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'meletio-package-'));
  const stage = join(directory, 'stage');
  await mkdir(stage);
  try { await run(directory, stage); } finally { await rm(directory, {recursive: true, force: true}); }
}

async function rejectsPackage(options: PackageOptions, pattern = /package|archive|unsupported|invalid|limit|size|duplicate|schema|table|media|field|path|encrypted/i) {
  await temporary(async (directory, stage) => {
    const {archivePath} = await makePackage(directory, options);
    await assert.rejects(parsePackage(archivePath, stage), pattern);
  });
}

test('stored and deflated legacy exports preserve fields, source GUIDs, decks and bundled media', async () => {
  for (const method of [0, 8] as const) await temporary(async (directory, stage) => {
    const {archivePath, notes} = await makePackage(directory, {method, media: {'book.png': png, 'voice.wav': wav()}});
    const result = await parsePackage(archivePath, stage);
    assert.equal(result.notes.length, 4);
    assert.deepEqual(result.notes[0].fields, notes[0].fields);
    assert.equal(result.notes[0].guid, notes[0].guid);
    assert.equal(result.notes[0].modified, 100);
    assert.equal(result.notes[0].noteTypeId, '100');
    assert.deepEqual(result.notes[0].deckIds, ['1']);
    assert(result.decks.some(deck => deck.id === '2' && deck.name === 'Root::Child'));
    assert.deepEqual(result.noteTypes[0].fields, ['Term', 'Meaning', 'Audio']);
    for (const media of result.media) {
      assert(media.path);
      const within = relative(stage, media.path);
      assert(!isAbsolute(within) && within !== '..' && !within.startsWith('..' + sep));
      assert.equal(media.sha256?.length, 64);
      assert.equal((await readFile(media.path)).length, media.size);
      assert.equal(media.error, undefined);
    }
    assert.equal(result.media.find(media => media.name === 'book.png')?.mime, 'image/png');
    assert.equal(result.media.find(media => media.name === 'voice.wav')?.mime, 'audio/wav');
  });
});

test('64-bit source IDs remain exact and multiple card templates do not duplicate notes', async () => temporary(async (directory, stage) => {
  const sourceId = 9007199254740993n;
  const {archivePath} = await makePackage(directory, {notes: [{id: sourceId, guid: 'stable-guid', fields: ['word', 'meaning', ''], deckIds: ['1', '2']} ]});
  const result = await parsePackage(archivePath, stage);
  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0].id, String(sourceId));
  assert.deepEqual([...result.notes[0].deckIds].sort(), ['1', '2']);
}));

test('HTML fields become readable plain text while scripts styles templates and remote media stay inert', () => {
  const result = extractField('<div>Hello&nbsp;&amp; κόσμε</div><div>second<br>line</div><script>steal()</script><style>evil</style><template>secret</template><img src="https://bad.example/x.png"><img src="book.png"><audio src="https://bad.example/a.mp3"></audio>[sound:voice.wav]');
  assert.match(result.text, /Hello\s+& κόσμε/);
  assert.match(result.text, /second\s*\n\s*line/);
  assert(!/steal|evil|secret/.test(result.text));
  assert.deepEqual(result.images, ['book.png']);
  assert.deepEqual(result.audio, ['voice.wav']);
  assert(!result.text.includes('[sound:'));
});

test('preferred vocabulary illustration is selected first while all candidate names remain visible', () => {
  const result = extractField('<img src="other.png"><section data-vocab-image="v1"><img src="preferred.png"></section><img src="third.png">[sound:first.wav] [sound:second.mp3]');
  assert.equal(result.images[0], 'preferred.png');
  assert.deepEqual(new Set(result.images), new Set(['other.png', 'preferred.png', 'third.png']));
  assert.deepEqual(result.audio, ['first.wav', 'second.mp3']);
});

test('modern archives are refused even if a legacy compatibility-warning collection exists', async () => {
  await rejectsPackage({extraEntries: [{name: 'collection.anki21b', data: 'modern compressed payload'}, {name: 'meta', data: Buffer.from([8, 3])}]}, /older|compatible|modern|export/i);
});

test('ambiguous duplicate collections are rejected rather than importing an arbitrary database', async () => {
  await rejectsPackage({extraEntries: [{name: 'collection.anki21', data: 'another database'}]});
});

test('ZIP traversal, absolute, drive, UNC, duplicate and symlink entries are rejected', async () => {
  for (const name of ['../outside', '/absolute', 'C:/drive', '\\\\host\\share', 'folder/../../outside']) {
    await rejectsPackage({extraEntries: [{name, data: 'unsafe'}]});
  }
  await rejectsPackage({extraEntries: [{name: 'media', data: '{}'}]});
  await rejectsPackage({extraEntries: [{name: 'link', data: '../outside', externalAttributes: (0o120777 << 16) >>> 0}]});
});

test('encrypted archives and invalid CRC or declared entry sizes are rejected', async () => {
  for (const entry of [
    {name: 'payload', data: 'abc', flags: 0x801},
    {name: 'payload', data: 'abc', crcOverride: 1},
    {name: 'payload', data: 'abc', declaredSize: 1},
  ]) await rejectsPackage({extraEntries: [entry]});
});

test('invalid or duplicate media-map keys and missing archive entries are rejected', async () => {
  for (const mediaMap of ['[]', '{', '{"0":"first.png","0":"second.png"}', '{"0":"missing.png"}', '{"../outside":"bad.png"}']) {
    await rejectsPackage({mediaMap});
  }
});

test('active and signature-mismatched media are reported without retaining unsafe payloads', async () => temporary(async (directory, stage) => {
  const {archivePath} = await makePackage(directory, {media: {
    'unsafe.svg': Buffer.from('<svg onload="steal()"></svg>'),
    'fake.png': Buffer.from('<html>not an image</html>'),
    'bad.mp3': Buffer.from('not audio'),
  }});
  const result = await parsePackage(archivePath, stage);
  assert.equal(result.media.length, 3);
  for (const media of result.media) {
    assert.equal(media.path, null);
    assert.equal(typeof media.error, 'string');
  }
}));

test('oversized individual media is reported and skipped while valid vocabulary remains inspectable', async () => temporary(async (directory, stage) => {
  const {archivePath} = await makePackage(directory, {method: 8,
    media: {'large.wav': Buffer.concat([wav(), Buffer.alloc(IMPORT_LIMITS.mediaBytes)])}});
  const result = await parsePackage(archivePath, stage);
  assert.equal(result.notes.length, 4);
  const media = result.media.find(media => media.name === 'large.wav');
  assert(media);
  assert.equal(media.path, null);
  assert.match(media.error ?? '', /large|size|limit|512/i);
  const files = await readdir(stage);
  assert(!files.some(name => name === 'large.wav'));
}));

test('SQLite views, triggers and missing required tables are rejected before content queries', async () => {
  await rejectsPackage({mutate: database => database.exec('ALTER TABLE notes RENAME TO real_notes; CREATE VIEW notes AS SELECT * FROM real_notes;')});
  await rejectsPackage({mutate: database => database.exec('CREATE TRIGGER hostile AFTER INSERT ON notes BEGIN DELETE FROM cards; END;')});
  await rejectsPackage({mutate: database => database.exec('DROP TABLE notes;')});
});

test('field and archive entry limits reject the whole package without silently truncating', async () => {
  await rejectsPackage({notes: [{guid: 'large-field', fields: ['x'.repeat(IMPORT_LIMITS.fieldBytes + 1), 'meaning', '']}]});
  await rejectsPackage({extraEntries: Array.from({length: IMPORT_LIMITS.entries}, (_, index) => ({name: `entry-${index}`, data: ''}))});
});

test('arbitrary malformed archive bytes are not mistaken for an empty supported package', async () => temporary(async (directory, stage) => {
  const archivePath = join(directory, 'broken.apkg');
  await writeFile(archivePath, 'SQLite format 3\0not a zip archive');
  await assert.rejects(parsePackage(archivePath, stage), /archive|zip|package|invalid/i);
}));

test('Anki legacy2 metadata selects collection.anki21 and never imports compatibility stub', async () => temporary(async (directory, stage) => {
  const {archivePath} = await makePackage(directory, {collectionName: 'collection.anki21', extraEntries: [
    {name: 'meta', data: Buffer.from([8, 2])},
    {name: 'collection.anki2', data: 'compatibility-warning stub must not be queried'},
  ]});
  const result = await parsePackage(archivePath, stage);
  assert.equal(result.notes.length, 4);
  assert.equal(result.notes[0].guid, 'note-guid-1');
}));

test('supported mapped media CRC is checked on the stream that is actually consumed', async () => temporary(async (directory, stage) => {
  const prepared = await makePackage(directory, {media: {'book.png': png}});
  const entries = prepared.entries.map(entry => entry.name === '0' ? {...entry, crcOverride: 1} : entry);
  await writeFile(prepared.archivePath, writeZip(entries));
  await assert.rejects(parsePackage(prepared.archivePath, stage), /crc|checksum|archive|invalid|integrity/i);
}));

test('HTML entity decoding preserves a sound filename as one exact bundled reference', () => {
  assert.deepEqual(extractField('word [sound:a&amp;b.wav]').audio, ['a&b.wav']);
});

test('parser subprocess serializes work, cancels and reaps before allowing a new parse', async () => temporary(async (directory, stage) => {
  const archive = await makePackage(directory);
  const secondStage = join(directory, 'second-stage');
  const finalStage = join(directory, 'final-stage');
  await mkdir(secondStage); await mkdir(finalStage);
  const controller = new AbortController();
  const parsing = inspectPackageInChild(archive.archivePath, stage, controller.signal);
  const cancelled = assert.rejects(parsing, (error: unknown) => error instanceof ApiError && error.status === 410);
  await assert.rejects(inspectPackageInChild(archive.archivePath, secondStage),
    (error: unknown) => error instanceof ApiError && error.status === 429);
  controller.abort();
  await cancelled;
  const recovered = await inspectPackageInChild(archive.archivePath, finalStage);
  assert.equal(recovered.notes.length, 4);
}));

test('declared database and aggregate unpacked limits reject compressed entries before extraction', async () => {
  await temporary(async (directory, stage) => {
    const archive = await makePackage(directory);
    const entries = archive.entries.map(entry => entry.name === 'collection.anki2'
      ? {...entry, method: 8 as const, declaredSize: IMPORT_LIMITS.databaseBytes + 1} : entry);
    await writeFile(archive.archivePath, writeZip(entries));
    await assert.rejects(parsePackage(archive.archivePath, stage), /entry size limit/i);
  });
  await temporary(async (directory, stage) => {
    const archive = await makePackage(directory);
    const media = Object.fromEntries(Array.from({length: 129}, (_, index) => [String(index), `large-${index}.wav`]));
    const entries = archive.entries.filter(entry => entry.name !== 'media');
    entries.push({name: 'media', data: JSON.stringify(media)});
    for (const name of Object.keys(media)) entries.push({name, data: 'x', method: 8, declaredSize: 1024 * 1024});
    await writeFile(archive.archivePath, writeZip(entries));
    await assert.rejects(parsePackage(archive.archivePath, stage), /unpacked size limit/i);
  });
});

test('media-map and inspected-note-count limits reject whole packages', async () => {
  await rejectsPackage({mediaMap: ' '.repeat(IMPORT_LIMITS.mediaMapBytes + 1) + '{}', method: 8}, /entry size limit/i);
  await rejectsPackage({mutate: database => {
    database.exec(`WITH RECURSIVE extra(i) AS (SELECT 5 UNION ALL SELECT i+1 FROM extra WHERE i<10001)
      INSERT INTO notes SELECT i,'extra-guid-'||i,100,100,0,'','word'||char(31)||'meaning'||char(31),0,0,0,'' FROM extra`);
  }}, /note\/card limit/i);
});
