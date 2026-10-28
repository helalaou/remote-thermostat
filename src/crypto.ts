import { createHmac, timingSafeEqual } from 'node:crypto';

export type Role = 'admin' | 'user';
export interface Session {
  role: Role;
  csrfToken: string;
}

const SESSION_DAYS = 30;
const hmac = (secret: string, value: string) =>
  createHmac('sha256', secret).update(value).digest('base64url');

export function equalToken(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

/** Compares a typed code against the configured one without leaking timing or length. */
export function codeMatches(secret: string, typed: string, expected: string | undefined): boolean {
  return Boolean(expected) && equalToken(hmac(secret, typed), hmac(secret, expected!));
}

// Cookie: role.expiry.codeTag.signature. The code tag ties a session to the current code,
// so changing a code signs everyone using it out.
export function createSession(secret: string, role: Role, code: string, now = Date.now()) {
  const payload = `${role}.${now + SESSION_DAYS * 86_400_000}.${hmac(secret, `code:${code}`).slice(0, 16)}`;
  return `${payload}.${hmac(secret, payload)}`;
}

export function readSession(
  secret: string,
  cookie: string | undefined,
  codes: Record<Role, string | undefined>,
  now = Date.now(),
): Session | null {
  if (!cookie || cookie.length > 200) return null;
  const parts = cookie.split('.');
  if (parts.length !== 4) return null;
  const [role, expiry, tag, signature] = parts;
  if (!equalToken(signature, hmac(secret, `${role}.${expiry}.${tag}`))) return null;
  if (role !== 'admin' && role !== 'user') return null;
  if (!(Number(expiry) > now)) return null;
  const code = codes[role];
  if (!code || !equalToken(tag, hmac(secret, `code:${code}`).slice(0, 16))) return null;
  return { role, csrfToken: hmac(secret, `csrf:${cookie}`) };
}

export const sessionMaxAge = SESSION_DAYS * 86_400;
