import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {buildData, portableHtml, scriptJson} from '../scripts/prepare';

function config(image = 'book.png', audio: string | null = null) {
  return {uiLanguage: 'en', decks: [{
    id: 'arabic', title: 'Everyday Arabic', termLang: 'ar',
    meaningLang: 'en', termDir: 'rtl', meaningDir: 'ltr',
    words: [{id: 'book', term: 'كتاب', meaning: 'book', imagePath: image, audioPath: audio}]
  }]};
}

function temporary(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'meletio-prepare-'));
  try { run(root); }
  finally { rmSync(root, {recursive: true, force: true}); }
}

test('RTL deck embeds images and supports missing recordings', () => temporary(root => {
  writeFileSync(join(root, 'book.png'), 'example image');
  const deck = buildData(config(), root).decks[0];
  assert.equal(deck.termDir, 'rtl');
  assert.equal(deck.words[0].term, 'كتاب');
  assert.equal(deck.words[0].termLang, 'ar');
  assert.equal(deck.words[0].audio, null);
  assert.ok(deck.words[0].image?.startsWith('data:image/png;base64,'));
}));

test('path escapes and unsupported media types are rejected', () => temporary(root => {
  assert.throws(() => buildData(config('../private.png'), root));
  writeFileSync(join(root, 'book.txt'), 'not a supported image');
  assert.throws(() => buildData(config('book.txt'), root), /Unsupported/);
}));

test('script JSON escapes markup and preserves Unicode', () => {
  const source = {term: '</script><!-- café كتاب'};
  const encoded = scriptJson(source);
  assert.ok(!encoded.includes('<'));
  assert.deepEqual(JSON.parse(encoded), source);
});

test('invalid metadata and duplicate IDs are rejected', () => temporary(root => {
  writeFileSync(join(root, 'book.png'), 'image');
  for (const [field, value] of [['termLang', 'el_GR'], ['meaningLang', ''], ['termDir', 'sideways']]) {
    const source = config();
    Object.assign(source.decks[0], {[field]: value});
    assert.throws(() => buildData(source, root));
  }
  const duplicateWords = config();
  duplicateWords.decks[0].words.push(duplicateWords.decks[0].words[0]);
  assert.throws(() => buildData(duplicateWords, root), /IDs/);
  const duplicateDecks = config();
  duplicateDecks.decks.push(duplicateDecks.decks[0]);
  assert.throws(() => buildData(duplicateDecks, root), /Deck IDs/);
}));

test('symlink escapes cannot embed outside files', () => temporary(base => {
  const root = join(base, 'root');
  mkdirSync(root);
  writeFileSync(join(base, 'outside.png'), 'private');
  symlinkSync(join(base, 'outside.png'), join(root, 'book.png'));
  assert.throws(() => buildData(config(), root), /inside/);
}));

test('portable build inlines exact tags, removes live marker and rejects unsafe content', () => temporary(root => {
  let html = '<html data-server="true"><link rel="stylesheet" href="style.css">';
  for (const name of ['learning.js', 'data.js', 'app.js']) {
    html += `<script src="${name}"></script>`;
    writeFileSync(join(root, name), 'const café = 1;');
  }
  writeFileSync(join(root, 'style.css'), 'body {color: blue}');
  writeFileSync(join(root, 'index.html'), html);
  const built = portableHtml(root);
  assert.ok(!built.includes('src='));
  assert.ok(!built.includes('data-server'));
  assert.ok(built.includes('café'));
  writeFileSync(join(root, 'index.html'), html.replace('<script src="app.js"></script>', ''));
  assert.throws(() => portableHtml(root), /app.js/);
  writeFileSync(join(root, 'index.html'), html);
  for (const invalid of ['</script>', '<!--']) {
    writeFileSync(join(root, 'app.js'), invalid);
    assert.throws(() => portableHtml(root), /Unsafe/);
  }
  writeFileSync(join(root, 'app.js'), 'const safe = 1;');
  writeFileSync(join(root, 'style.css'), '</style>');
  assert.throws(() => portableHtml(root), /Unsafe/);
}));
