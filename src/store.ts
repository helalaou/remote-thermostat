import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomToken, hashToken } from './crypto.ts';

export interface AccessKey { id: string; label: string; role: 'owner' | 'neighbor'; createdAt: number; expiresAt: number | null }
export interface Session { hash: string; keyId: string; role: 'owner' | 'neighbor'; label: string; csrfToken: string; expiresAt: number }
export class RateLimitError extends Error {
  retryAfterSeconds: number;
  constructor(seconds: number) { super('Too many requests. Please wait before trying again.'); this.retryAfterSeconds = Math.max(1, Math.ceil(seconds)); }
}
export class Store {
  db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = join(directory, 'thermostat.sqlite');
    this.db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS access_keys (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK(role IN ('owner','neighbor')), label TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, key_id TEXT NOT NULL REFERENCES access_keys(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_states (hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rate_events (bucket TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS rate_events_bucket_at ON rate_events(bucket, at);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, key_id TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, key_id TEXT NOT NULL, action TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL);
      PRAGMA user_version = 1;`);
    this.prune();
  }
  close() { this.db.close(); }
  prune(now = Date.now()) {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM rate_events WHERE at <= ?').run(now - 3_600_000);
    this.db.prepare('DELETE FROM requests WHERE at <= ?').run(now - 86_400_000);
    this.db.prepare('DELETE FROM audit WHERE at <= ?').run(now - 30 * 86_400_000);
  }
  createKey(role: 'owner' | 'neighbor', label: string, expiresAt: number | null = null, now = Date.now()) {
    if (!label.trim() || label.length > 80) throw new Error('Use a label between 1 and 80 characters.');
    if (role === 'owner' && this.hasOwner()) throw new Error('An owner already exists. Revoke it locally before creating a replacement.');
    const token = `nt_${randomToken()}`; const id = randomToken().slice(0, 12);
    this.db.prepare('INSERT INTO access_keys (id, token_hash, role, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, hashToken(token), role, label.trim(), now, expiresAt);
    return { id, token, role, label: label.trim(), expiresAt };
  }
  hasOwner() { return Boolean(this.db.prepare("SELECT id FROM access_keys WHERE role = 'owner' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)").get(Date.now())); }
  listKeys(now = Date.now()): AccessKey[] {
    return this.db.prepare('SELECT id, label, role, created_at AS createdAt, expires_at AS expiresAt FROM access_keys WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at').all(now) as unknown as AccessKey[];
  }
  revokeKey(id: string, now = Date.now()) {
    this.db.prepare('UPDATE access_keys SET revoked_at = ? WHERE id = ?').run(now, id);
    this.db.prepare('DELETE FROM sessions WHERE key_id = ?').run(id);
  }
  login(key: string, now = Date.now()): { token: string; session: Session } | null {
    if (!/^nt_[A-Za-z0-9_-]{43}$/.test(key)) return null;
    const found = this.db.prepare('SELECT id, role, label FROM access_keys WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)').get(hashToken(key), now) as {id:string;role:'owner'|'neighbor';label:string} | undefined;
    if (!found) return null;
    const token = randomToken(); const csrfToken = randomToken(); const hash = hashToken(token); const expiresAt = now + 7 * 86_400_000;
    this.db.prepare('INSERT INTO sessions (hash, key_id, csrf, expires_at) VALUES (?, ?, ?, ?)').run(hash, found.id, csrfToken, expiresAt);
    return { token, session: { hash, keyId: found.id, role: found.role, label: found.label, csrfToken, expiresAt } };
  }
  session(token: string | undefined, now = Date.now()): Session | null {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return (this.db.prepare('SELECT s.hash, s.key_id AS keyId, k.role, k.label, s.csrf AS csrfToken, s.expires_at AS expiresAt FROM sessions s JOIN access_keys k ON k.id = s.key_id WHERE s.hash = ? AND s.expires_at > ? AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?)').get(hashToken(token), now, now) as unknown as Session) || null;
  }
  logout(hash: string) { this.db.prepare('DELETE FROM sessions WHERE hash = ?').run(hash); }
  get(name: string): string | undefined { return (this.db.prepare('SELECT value FROM secrets WHERE name = ?').get(name) as {value:string}|undefined)?.value; }
  set(name: string, value: string) { this.db.prepare('INSERT INTO secrets (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, value); }
  delete(name: string) { this.db.prepare('DELETE FROM secrets WHERE name = ?').run(name); }
  createOAuthState(sessionHash: string, verifier: string, now = Date.now()) {
    const state = randomToken();
    this.db.prepare('DELETE FROM oauth_states WHERE session_hash = ?').run(sessionHash);
    this.db.prepare('INSERT INTO oauth_states VALUES (?, ?, ?, ?)').run(hashToken(state), sessionHash, verifier, now + 600_000);
    return state;
  }
  consumeOAuthState(state: string, sessionHash: string, now = Date.now()): string | null {
    const found = this.db.prepare('DELETE FROM oauth_states WHERE hash = ? AND session_hash = ? AND expires_at > ? RETURNING verifier').get(hashToken(state), sessionHash, now) as {verifier:string}|undefined;
    return found?.verifier || null;
  }
  reserve(bucket: string, limits: {max:number;windowMs:number}[], now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM rate_events WHERE at <= ?').run(now - 3_600_000);
      let wait = 0;
      for (const limit of limits) {
        const rows = this.db.prepare('SELECT at FROM rate_events WHERE bucket = ? AND at > ? ORDER BY at').all(bucket, now - limit.windowMs) as {at:number}[];
        if (rows.length >= limit.max) wait = Math.max(wait, (rows[rows.length-limit.max].at + limit.windowMs - now) / 1000);
      }
      if (wait > 0) throw new RateLimitError(wait);
      this.db.prepare('INSERT INTO rate_events VALUES (?, ?)').run(bucket, now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getRequest(id: string): {keyId:string;result:string}|undefined { return this.db.prepare('SELECT key_id AS keyId, result FROM requests WHERE id = ?').get(id) as {keyId:string;result:string}|undefined; }
  saveRequest(id: string, keyId: string, result: unknown) {
    this.db.prepare('INSERT INTO requests VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET result = excluded.result').run(id, keyId, JSON.stringify(result), Date.now());
  }
  audit(keyId: string, action: string, result: string) { this.db.prepare('INSERT INTO audit (key_id, action, result, at) VALUES (?, ?, ?, ?)').run(keyId, action, result, Date.now()); }
}
