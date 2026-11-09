import {Parser} from 'htmlparser2';
import {IMPORT_LIMITS} from './import-types';

function localMedia(value: string): string | null {
  let name = value.trim();
  try { name = decodeURIComponent(name); } catch { return null; }
  if (!name || /[\\/\x00-\x1f\x7f:]/.test(name) || name === '.' || name === '..' || name.length > 255) return null;
  return name.normalize('NFC');
}

export function extractField(html: string): {text: string; images: string[]; audio: string[]} {
  if (Buffer.byteLength(html, 'utf8') > IMPORT_LIMITS.fieldBytes) throw new Error('Source field exceeds the 64KiB limit');
  const parts: string[] = [];
  const images: {name: string; preferred: boolean}[] = [];
  const audio: string[] = [];
  const stack: {ignored: boolean; preferred: boolean; block: boolean}[] = [];
  const blocks = new Set(['div', 'p', 'section', 'article', 'header', 'footer', 'li', 'ul', 'ol', 'table', 'tr', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  const parser = new Parser({
    onopentag(name, attributes) {
      const parent = stack[stack.length - 1];
      const ignored = Boolean(parent?.ignored) || ['script', 'style', 'template', 'iframe', 'object', 'svg'].includes(name);
      const preferred = Boolean(parent?.preferred) || attributes['data-vocab-image'] === 'v1';
      const block = blocks.has(name);
      stack.push({ignored, preferred, block});
      if (ignored) return;
      if (block || name === 'br') parts.push('\n');
      if (name === 'img' && attributes.src) {
        const media = localMedia(attributes.src);
        if (media) images.push({name: media, preferred});
      }
    },
    ontext(value) {
      if (stack[stack.length - 1]?.ignored) return;
      parts.push(value);
    },
    onclosetag() {
      const current = stack.pop();
      if (current?.block && !current.ignored) parts.push('\n');
    }
  }, {decodeEntities: true});
  parser.end(html);
  const visible = parts.join('').replace(/\[sound:([^\]\r\n]+)\]/gi, (_match, reference: string) => {
    const media = localMedia(reference);
    if (media) audio.push(media);
    return '';
  });
  const text = visible.replace(/\r\n?/g, '\n').replace(/[\t\f\v \u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const ordered = [...images.filter(image => image.preferred), ...images.filter(image => !image.preferred)].map(image => image.name);
  return {text, images: [...new Set(ordered)], audio: [...new Set(audio)]};
}
