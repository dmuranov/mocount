// In-memory session store keyed by an opaque random token. Suitable
// for a single-process pm2 app with ~5 users. If we ever scale
// horizontally or want sessions to survive restarts, swap this for a
// Postgres-backed store (audit_log + a sessions table) without
// touching middleware.
//
// The cookie sent to the browser is `mocount_sid=<token>; HttpOnly;
// SameSite=Lax; Secure (in prod)`. SESSION_SECRET is reserved for
// future signing — current tokens are 32-byte random hex which is
// already opaque + unguessable.

import crypto from 'node:crypto';

export const SESSION_COOKIE = 'mocount_sid';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const _store = new Map(); // token -> { userId, email, role, createdAt, lastSeenAt }

export function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function createSession(user) {
  const token = newToken();
  _store.set(token, {
    userId: user.id,
    email: user.email,
    role: user.role,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  });
  return token;
}

export function getSession(token) {
  if (!token) return null;
  const s = _store.get(token);
  if (!s) return null;
  if (Date.now() - s.lastSeenAt > TTL_MS) {
    _store.delete(token);
    return null;
  }
  s.lastSeenAt = Date.now();
  return s;
}

export function destroySession(token) {
  if (!token) return;
  _store.delete(token);
}

export function destroyAllSessionsForEmail(email) {
  // Used when an admin deactivates a user — kill any live tabs they
  // have open. The middleware also re-checks active=true on every
  // request, but this gets them out faster.
  if (!email) return 0;
  let n = 0;
  for (const [token, s] of _store) {
    if (s.email === email) {
      _store.delete(token);
      n++;
    }
  }
  return n;
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
