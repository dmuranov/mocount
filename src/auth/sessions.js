// Stateless session cookie: HMAC-signed JSON payload. No server-side
// store, so dev-server restarts (node --watch) don't log everyone out
// and pm2 restarts in prod don't either.
//
// Token shape: `<base64url(payload)>.<base64url(hmac)>`
//   payload = { e: email, c: createdAt_ms, x: expiresAt_ms }
//
// `userId` and `role` are intentionally NOT in the payload — the auth
// middleware always re-fetches them from the users table on every
// request (SPEC §1: active=true is re-checked every call). That keeps
// deactivation effective and means a stale cookie can't outlive a
// role demotion.

import crypto from 'node:crypto';
import { CONFIG } from '../config.js';

export const SESSION_COOKIE = 'mocount_sid';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function secret() {
  const s = CONFIG.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is required for signed sessions');
  return s;
}

function b64uEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function sign(payloadStr) {
  return crypto.createHmac('sha256', secret()).update(payloadStr).digest();
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function createSession(user) {
  const now = Date.now();
  const payload = { e: user.email, c: now, x: now + TTL_MS };
  const json = JSON.stringify(payload);
  const mac = sign(json);
  return `${b64uEncode(json)}.${b64uEncode(mac)}`;
}

export function getSession(token) {
  if (!token || typeof token !== 'string') return null;
  const i = token.indexOf('.');
  if (i < 1) return null;
  const payloadPart = token.slice(0, i);
  const macPart = token.slice(i + 1);
  let json;
  try { json = b64uDecode(payloadPart).toString('utf8'); }
  catch { return null; }
  const expectedMac = sign(json);
  let providedMac;
  try { providedMac = b64uDecode(macPart); }
  catch { return null; }
  if (!safeEqual(expectedMac, providedMac)) return null;
  let payload;
  try { payload = JSON.parse(json); }
  catch { return null; }
  if (!payload?.e || !payload?.x) return null;
  if (Date.now() > Number(payload.x)) return null;
  return { email: payload.e, createdAt: payload.c, expiresAt: payload.x };
}

export function destroySession(_token) {
  // Stateless tokens have no server-side state to clear. The route
  // handler still clears the cookie via clearSessionCookie().
}

export function destroyAllSessionsForEmail(_email) {
  // Stateless: nothing server-side to evict. The auth middleware
  // already re-checks users.active on every request, so a deactivated
  // user is locked out on their next call regardless.
  return 0;
}

// Cookie helpers — keep cookie semantics in one place.
export function setSessionCookie(res, token, isProd) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(TTL_MS / 1000)}`,
  ];
  if (isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
