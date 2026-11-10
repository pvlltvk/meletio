import {ApiError} from './types';

interface Window {count: number; expires: number}

export class AuthLimitError extends ApiError {
  constructor(readonly retryAfter: number) {
    super(429, 'rate_limited', 'Too many attempts. Try again later.');
  }
}

export class AuthLimits {
  private admissions = new Map<string, Window>();
  private accounts = new Map<string, Window>();
  private addresses = new Map<string, Window>();
  private global: Window = {count: 0, expires: 0};

  constructor(private now: () => number) {}

  private active(map: Map<string, Window>, key: string, now: number) {
    for (const [entry, value] of map) if (value.expires <= now) map.delete(entry);
    return map.get(key);
  }

  private increment(map: Map<string, Window>, key: string, duration: number, now: number) {
    const existing = this.active(map, key, now);
    if (existing) existing.count++;
    else {
      if (map.size >= 1000) map.delete(map.keys().next().value!);
      map.set(key, {count: 1, expires: now + duration});
    }
  }

  private reject(until: number, now: number): never {
    throw new AuthLimitError(Math.max(1, Math.ceil((until - now) / 1000)));
  }

  admit(address: string) {
    const now = this.now();
    if (this.global.expires <= now) this.global = {count: 0, expires: now + 60000};
    const local = this.active(this.admissions, address, now);
    const blocked = [this.global.count >= 120 ? this.global.expires : 0, local && local.count >= 60 ? local.expires : 0];
    const until = Math.max(...blocked);
    if (until > now) this.reject(until, now);
    this.global.count++;
    this.increment(this.admissions, address, 60000, now);
  }

  check(account: string, address: string) {
    const now = this.now();
    const email = account.trim().toLowerCase();
    const accountWindow = this.active(this.accounts, email, now);
    const addressWindow = this.active(this.addresses, address, now);
    const blocked = [accountWindow && accountWindow.count >= 5 ? accountWindow.expires : 0,
      addressWindow && addressWindow.count >= 20 ? addressWindow.expires : 0];
    const until = Math.max(...blocked);
    if (until > now) this.reject(until, now);
  }

  failure(account: string, address: string) {
    const now = this.now();
    this.increment(this.accounts, account.trim().toLowerCase(), 15 * 60000, now);
    this.increment(this.addresses, address, 15 * 60000, now);
  }

  success(account: string) {
    this.accounts.delete(account.trim().toLowerCase());
  }
}
