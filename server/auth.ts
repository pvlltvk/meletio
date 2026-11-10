import {createHash, randomBytes, randomUUID, scrypt, timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {AuthLimits} from './auth-limits';
import {transaction} from './database';
import {ApiError, fields, invalid, stringField, type User} from './types';

const lifetime = 30 * 24 * 60 * 60 * 1000;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export class Auth {
  private hashing = 0;
  private limits: AuthLimits;

  constructor(private db: DatabaseSync, private now: () => number) {
    this.limits = new AuthLimits(now);
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

  async authenticate(body: Record<string, unknown>, register: boolean, cookie: string | undefined, address: string): Promise<{user: User; token: string}> {
    this.limits.admit(address);
    fields(body, ['email', 'password']);
    const email = stringField(body.email, 'email', 254).trim().toLowerCase();
    const password = stringField(body.password, 'password');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid('Enter a valid email address.');
    if (password.length < 12) invalid('Use at least 12 characters for your password.');
    this.limits.check(email, address);
    const row = this.db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(email) as {id: string; email: string; password_hash: string} | undefined;
    if (register) {
      if (row) throw new ApiError(409, 'email_in_use', 'An account already uses this email.');
      const salt = randomBytes(16).toString('hex');
      const key = await this.derive(password, salt);
      const user = {id: randomUUID(), email};
      try {
        const result = transaction(this.db, () => {
          this.db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(user.id, email, `${salt}:${key.toString('hex')}`, this.now());
          return {user, token: this.createSession(user, cookie)};
        });
        this.limits.success(email);
        return result;
      } catch (error) {
        if (this.db.prepare('SELECT id FROM users WHERE email = ?').get(email)) throw new ApiError(409, 'email_in_use', 'An account already uses this email.');
        throw error;
      }
    }
    const [salt, saved] = row ? row.password_hash.split(':') : ['00000000000000000000000000000000', '00'.repeat(64)];
    const key = await this.derive(password, salt);
    if (!timingSafeEqual(key, Buffer.from(saved, 'hex')) || !row) {
      this.limits.failure(email, address);
      throw new ApiError(401, 'invalid_credentials', 'Email or password is incorrect.');
    }
    const result = transaction(this.db, () => {
      const current = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(row.id) as {password_hash: string} | undefined;
      if (current?.password_hash !== row.password_hash) throw new ApiError(401, 'invalid_credentials', 'Email or password is incorrect.');
      const user = {id: row.id, email: row.email};
      return {user, token: this.createSession(user, cookie)};
    });
    this.limits.success(email);
    return result;
  }

  async changePassword(body: Record<string, unknown>, cookie: string | undefined, address: string): Promise<{changed: true}> {
    this.limits.admit(address);
    fields(body, ['currentPassword', 'newPassword']);
    const currentPassword = stringField(body.currentPassword, 'current password');
    const newPassword = stringField(body.newPassword, 'new password');
    if (currentPassword.length < 12 || newPassword.length < 12) invalid('Use at least 12 characters for your password.');
    const user = this.user(cookie);
    this.limits.check(user.email, address);
    const row = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as {password_hash: string};
    const [salt, saved] = row.password_hash.split(':');
    const currentKey = await this.derive(currentPassword, salt);
    if (!timingSafeEqual(currentKey, Buffer.from(saved, 'hex'))) {
      this.limits.failure(user.email, address);
      throw new ApiError(403, 'invalid_current_password', 'Current password is incorrect.');
    }
    const nextSalt = randomBytes(16).toString('hex');
    const nextKey = await this.derive(newPassword, nextSalt);
    transaction(this.db, () => {
      const active = this.user(cookie);
      if (active.id !== user.id) throw new ApiError(401, 'account_changed', 'Your account changed. Log in again.');
      const changed = this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?')
        .run(`${nextSalt}:${nextKey.toString('hex')}`, user.id, row.password_hash);
      if (changed.changes !== 1) throw new ApiError(409, 'credentials_changed', 'Your password changed in another session. Try again.');
      this.db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token_hash <> ?').run(user.id, hashToken(this.token(cookie)!));
    });
    this.limits.success(user.email);
    return {changed: true};
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

  private createSession(user: User, cookie?: string): string {
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
