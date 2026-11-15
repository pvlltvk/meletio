import {createHash, randomBytes, randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {transaction} from './database';
import {ApiError, fields, invalid, stringField, type User} from './types';

const lifetime = 90 * 24 * 60 * 60 * 1000;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

interface TokenMetadata {id: string; name: string; createdAt: number; expiresAt: number}

export function tokenName(value: unknown): string {
  const name = stringField(value, 'token name', 240).trim();
  if (!name || [...name].length > 120) invalid('Invalid token name.');
  return name;
}

export class AccessTokens {
  constructor(private db: DatabaseSync, private now: () => number) {}

  list(userId: string): TokenMetadata[] {
    return this.db.prepare(`SELECT id, name, created_at AS createdAt, expires_at AS expiresAt
      FROM access_tokens WHERE owner_id = ? AND expires_at > ? ORDER BY created_at, id`).all(userId, this.now()) as unknown as TokenMetadata[];
  }

  create(userId: string, body: Record<string, unknown>, verify?: () => void): TokenMetadata & {token: string} {
    fields(body, ['name']);
    const name = tokenName(body.name);
    return transaction(this.db, () => {
      verify?.();
      const createdAt = this.now();
      this.db.prepare('DELETE FROM access_tokens WHERE owner_id = ? AND expires_at <= ?').run(userId, createdAt);
      const count = this.db.prepare('SELECT count(*) AS n FROM access_tokens WHERE owner_id = ?').get(userId) as {n: number};
      if (count.n >= 20) throw new ApiError(409, 'token_limit', 'Revoke an access token before creating another.');
      const token = `mlt_${randomBytes(32).toString('hex')}`;
      const metadata = {id: randomUUID(), name, createdAt, expiresAt: createdAt + lifetime};
      this.db.prepare('INSERT INTO access_tokens VALUES (?,?,?,?,?,?)')
        .run(metadata.id, userId, hashToken(token), name, createdAt, metadata.expiresAt);
      return {...metadata, token};
    });
  }

  revoke(userId: string, id: string): {revoked: boolean} {
    const result = this.db.prepare('DELETE FROM access_tokens WHERE owner_id = ? AND id = ?').run(userId, id);
    return {revoked: result.changes > 0};
  }

  bearer(authorization?: string): User {
    const match = /^([A-Za-z]+) (mlt_[a-f0-9]{64})$/.exec(authorization || '');
    const row = match && match[1].toLowerCase() === 'bearer' && this.db.prepare(`SELECT users.id, users.email FROM access_tokens
      JOIN users ON users.id = access_tokens.owner_id WHERE token_hash = ? AND expires_at > ?`)
      .get(hashToken(match[2]), this.now()) as User | undefined;
    if (!row) throw new ApiError(401, 'unauthorized', 'Use a valid authoring access token.');
    return {id: row.id, email: row.email};
  }
}
