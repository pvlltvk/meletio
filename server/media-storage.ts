import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {ApiError} from './types';

export interface MediaLimits {bytes: number; files: number}

export const defaultMediaLimits = {bytes: 512 * 1024 * 1024, files: 10000} as const;

export function validateMediaLimits(limits: MediaLimits = defaultMediaLimits): MediaLimits {
  if (!limits || !Number.isSafeInteger(limits.bytes) || limits.bytes < 1) throw new Error('MEDIA_MAX_BYTES must be a positive safe integer.');
  if (!Number.isSafeInteger(limits.files) || limits.files < 1) throw new Error('MEDIA_MAX_FILES must be a positive safe integer.');
  return {bytes: limits.bytes, files: limits.files};
}

export type StoreMedia = (sha256: string, mime: string, bytes: Uint8Array) => string;

export class MediaStorage {
  private limits: MediaLimits;

  constructor(private db: DatabaseSync, limits: MediaLimits = defaultMediaLimits) {
    this.limits = validateMediaLimits(limits);
  }

  // The caller's content transaction also covers quota admission and its replay receipt.
  store(userId: string, sha256: string, mime: string, bytes: Uint8Array): string {
    return this.admitter(userId)(sha256, mime, bytes);
  }

  // One admission per caller transaction, for writers that store many files at once. The
  // owner's usage is read on the first file and then tracked in memory, so a bulk commit
  // costs one usage scan instead of one per file.
  admitter(userId: string): StoreMedia {
    let used: {files: number; bytes: number} | null = null;
    return (sha256, mime, bytes) => {
      const existing = this.db.prepare('SELECT id FROM imported_media WHERE owner_id = ? AND sha256 = ? AND mime = ?')
        .get(userId, sha256, mime) as {id: string} | undefined;
      if (existing) return existing.id;
      used ??= this.db.prepare('SELECT count(*) AS files, COALESCE(sum(size),0) AS bytes FROM imported_media WHERE owner_id = ?')
        .get(userId) as {files: number; bytes: number};
      if (used.files >= this.limits.files || bytes.byteLength > this.limits.bytes - used.bytes) {
        throw new ApiError(422, 'storage_limit', 'Media storage limit reached for this account.');
      }
      used.files += 1;
      used.bytes += bytes.byteLength;
      const id = randomUUID();
      this.db.prepare('INSERT INTO imported_media VALUES (?,?,?,?,?,?)').run(id, userId, sha256, mime, bytes.byteLength, bytes);
      return id;
    };
  }
}
