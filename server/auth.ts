import {createHash, randomBytes, randomUUID, scrypt, timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {ApiError, fields, invalid, stringField, type User} from './types';

const lifetime = 30 * 24 * 60 * 60 * 1000;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export class Auth {
  private hashing = 0;
  private attempts = new Map<string, {count: number; expires: number}>();

  constructor(private db: DatabaseSync, private now: () => number) {}

  throttle(address: string) {
    const now = this.now();
    for (const [key, entry] of this.attempts) if (entry.expires <= now) this.attempts.delete(key);
    const entry = this.attempts.get(address);
    if (entry && entry.count >= 20) throw new ApiError(429, 'rate_limited', 'Too many attempts. Try again later.');
    if (!entry && this.attempts.size >= 1000) throw new ApiError(429, 'rate_limited', 'Please try again later.');
    this.attempts.set(address, {count: (entry?.count || 0) + 1, expires: entry?.expires || now + 15 * 60 * 1000});
  }

  private async derive(password: string, salt: string): Promise<Buffer> {
    if (this.hashing >= 2) throw new ApiError(429, 'busy', 'Please try again shortly.');
    this.hashing++;
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        scrypt(password, salt, 64, {N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024}, (error, key) => error ? reject(error) : resolve(key));
      });
    } finally {
      this.hashing--;
    }
  }

  async credentials(body: Record<string, unknown>, register: boolean): Promise<User> {
    fields(body, ['email', 'password']);
    const email = stringField(body.email, 'email', 254).trim().toLowerCase();
    const password = stringField(body.password, 'password');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid('Enter a valid email address.');
    if (password.length < 12) invalid('Use at least 12 characters for your password.');
    const row = this.db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(email) as {id: string; email: string; password_hash: string} | undefined;
    if (register) {
      if (row) throw new ApiError(409, 'email_in_use', 'An account already uses this email.');
      const salt = randomBytes(16).toString('hex');
      const key = await this.derive(password, salt);
      const user = {id: randomUUID(), email};
      try {
        this.db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(user.id, email, `${salt}:${key.toString('hex')}`, this.now());
      } catch (error) {
        if (this.db.prepare('SELECT id FROM users WHERE email = ?').get(email)) throw new ApiError(409, 'email_in_use', 'An account already uses this email.');
        throw error;
      }
      return user;
    }
    const [salt, saved] = row ? row.password_hash.split(':') : ['00000000000000000000000000000000', '00'.repeat(64)];
    const key = await this.derive(password, salt);
    if (!timingSafeEqual(key, Buffer.from(saved, 'hex')) || !row) throw new ApiError(401, 'invalid_credentials', 'Email or password is incorrect.');
    return {id: row.id, email: row.email};
  }

  token(cookie?: string): string | undefined {
    const token = cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('meletio_session='))?.slice('meletio_session='.length);
    return token && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
  }

  user(cookie?: string): User {
    const token = this.token(cookie);
    const row = token && this.db.prepare('SELECT users.id, users.email FROM auth_sessions JOIN users ON users.id = auth_sessions.user_id WHERE token_hash = ? AND expires_at > ?').get(hashToken(token), this.now()) as User | undefined;
    if (!row) throw new ApiError(401, 'unauthorized', 'Please log in.');
    return {id: row.id, email: row.email};
  }

  createSession(user: User, cookie?: string): string {
    this.revoke(cookie);
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(this.now());
    const token = randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO auth_sessions VALUES (?, ?, ?, ?)').run(hashToken(token), user.id, this.now() + lifetime, this.now());
    return token;
  }

  revoke(cookie?: string) {
    const token = this.token(cookie);
    if (token) this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(token));
  }
}

export function sessionCookie(token: string, secure: boolean): string {
  return `meletio_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? lifetime / 1000 : 0}${secure ? '; Secure' : ''}`;
}
