import {readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {extname, isAbsolute, join, relative, resolve, sep} from 'node:path';

export interface Word {
  id: string;
  term: string;
  meaning: string;
  termLang: string;
  image: string | null;
  audio: string | null;
}

export interface Deck {
  id: string;
  title: string;
  termLang: string;
  meaningLang: string;
  termDir: 'ltr' | 'rtl';
  meaningDir: 'ltr' | 'rtl';
  words: Word[];
}

export interface Content {
  uiLanguage: string;
  decks: Deck[];
}

const mediaTypes: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav'
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected content object');
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected content list');
  return value;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected nonempty content text');
  return value;
}

function language(value: unknown): string {
  const tag = text(value);
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?(?:-(?:[A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*$/.test(tag)) {
    throw new Error('Use a language tag with optional script, region and variants');
  }
  return tag;
}

function direction(value: unknown): 'ltr' | 'rtl' {
  if (value !== 'ltr' && value !== 'rtl') throw new Error('Text direction must be ltr or rtl');
  return value;
}

function dataUrl(path: unknown, root: string, kind: 'image' | 'audio'): string {
  const directory = realpathSync(root);
  const source = realpathSync(resolve(directory, text(path)));
  const within = relative(directory, source);
  if (within === '..' || within.startsWith('..' + sep) || isAbsolute(within)) {
    throw new Error('Media path must remain inside the workspace');
  }
  const extension = extname(source).toLowerCase();
  const mime = mediaTypes[extension] || '';
  if (!mime.startsWith(kind + '/')) throw new Error(`Unsupported ${kind} type: ${extension}`);
  return `data:${mime};base64,${readFileSync(source).toString('base64')}`;
}

export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function buildData(config: unknown, root = process.cwd()): Content {
  const input = record(config);
  const decks = array(input.decks).map(value => {
    const source = record(value);
    const termLang = language(source.termLang);
    const ids = new Set<string>();
    const words = array(source.words).map(value => {
      const row = record(value);
      const wordId = typeof row.id === 'number' || typeof row.id === 'string' ? String(row.id).trim() : '';
      if (!wordId || ids.has(wordId)) throw new Error('Word IDs must be nonempty and unique within each deck');
      ids.add(wordId);
      return {
        id: wordId, term: text(row.term), meaning: text(row.meaning), termLang,
        image: row.imagePath ? dataUrl(row.imagePath, root, 'image') : null,
        audio: row.audioPath ? dataUrl(row.audioPath, root, 'audio') : null
      };
    });
    return {
      id: text(source.id), title: text(source.title), termLang,
      meaningLang: language(source.meaningLang), termDir: direction(source.termDir),
      meaningDir: direction(source.meaningDir), words
    };
  });
  if (new Set(decks.map(deck => deck.id)).size !== decks.length) throw new Error('Deck IDs must be unique');
  return {uiLanguage: language(input.uiLanguage ?? 'en'), decks};
}

export function portableHtml(directory: string): string {
  let html = readFileSync(join(directory, 'index.html'), 'utf8').replace(/\sdata-server="true"/g, '');
  const styleTag = '<link rel="stylesheet" href="style.css">';
  if (html.split(styleTag).length !== 2) throw new Error('Expected exactly one stylesheet reference');
  const css = readFileSync(join(directory, 'style.css'), 'utf8');
  if (css.toLowerCase().includes('</style')) throw new Error('Unsafe inline stylesheet terminator');
  html = html.replace(styleTag, () => '<style>' + css + '</style>');
  for (const name of ['learning.js', 'data.js', 'app.js']) {
    const tag = `<script src="${name}"></script>`;
    if (html.split(tag).length !== 2) throw new Error(`Expected exactly one ${name} script reference`);
    const js = readFileSync(join(directory, name), 'utf8');
    if (js.toLowerCase().includes('</script') || js.includes('<!--')) throw new Error(`Unsafe inline script terminator in ${name}`);
    html = html.replace(tag, () => '<script>' + js + '</script>');
  }
  return html;
}

export function prepare(root = process.cwd()): Content {
  const directory = join(root, 'web');
  const config: unknown = JSON.parse(readFileSync(join(directory, 'decks.json'), 'utf8'));
  const data = buildData(config, root);
  writeFileSync(join(directory, 'data.js'), 'const DATA = ' + scriptJson(data) + ';\n');
  const provenance = array(record(config).decks).flatMap(value => {
    const deck = record(value);
    return array(deck.words).map(value => {
      const word = record(value);
      return {deck: deck.id, term: word.term, image: word.imagePath ?? null, human_audio: word.audioPath ?? null};
    });
  });
  writeFileSync(join(directory, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
  writeFileSync(join(directory, 'preview.html'), portableHtml(directory));
  return data;
}

if (require.main === module) {
  const data = prepare();
  console.log(`Prepared ${data.decks.length} decks / ${data.decks.reduce((count, deck) => count + deck.words.length, 0)} words; preview: ${join(process.cwd(), 'web', 'preview.html')}`);
}
