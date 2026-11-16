import {extname} from 'node:path';

export function sniffMedia(data: Buffer, name: string): string | null {
  const extension = extname(name).toLowerCase();
  if (extension === '.png' && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (['.jpg', '.jpeg'].includes(extension) && data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (extension === '.webp' && data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (extension === '.wav' && data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (extension === '.ogg' && data.length >= 4 && data.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (extension === '.mp3' && ((data.length >= 10 && data.toString('ascii', 0, 3) === 'ID3') || (data.length >= 4 && data[0] === 255 && (data[1] & 0xe0) === 0xe0 && (data[1] & 6) !== 0))) return 'audio/mpeg';
  if (['.m4a', '.mp4'].includes(extension) && data.length >= 12 && data.toString('ascii', 4, 8) === 'ftyp' && ['M4A ', 'M4B ', 'isom', 'iso2', 'mp41', 'mp42', 'qt  '].includes(data.toString('ascii', 8, 12))) return 'audio/mp4';
  return null;
}
