import sharp from 'sharp';
import {IMPORT_LIMITS} from './import-types';

sharp.cache(false);
sharp.concurrency(1);

export async function optimizeImage(bytes: Buffer): Promise<Buffer> {
  if (bytes.length > IMPORT_LIMITS.imageSourceBytes) throw new Error('Image source exceeds the 8MiB limit');
  const options = {failOn: 'warning' as const, limitInputPixels: IMPORT_LIMITS.imagePixels, sequentialRead: true};
  const metadata = await sharp(bytes, options).metadata();
  if (!['png', 'jpeg', 'webp'].includes(metadata.format) || !metadata.width || !metadata.height
    || metadata.width * metadata.height > IMPORT_LIMITS.imagePixels) throw new Error('Unsupported image or image pixel limit exceeded');
  for (const [dimension, quality] of [[IMPORT_LIMITS.imageDimension, 80], [768, 70], [512, 60]]) {
    const output = await sharp(bytes, options).autoOrient()
      .resize({width: dimension, height: dimension, fit: 'inside', withoutEnlargement: true})
      .webp({quality, effort: 3}).timeout({seconds: 3}).toBuffer();
    if (output.length <= IMPORT_LIMITS.mediaBytes) return output;
  }
  throw new Error('Optimized image exceeds the 512KiB limit');
}
