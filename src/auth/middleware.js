// requireAuth + requireAdmin middleware.
//
// SPEC §1: "On every authenticated request, middleware re-checks
// users.active = true. Deactivating a user logs them out on next
// request." So we don't trust the in-memory session role/email blindly
// — we re-query the DB on each call. With ~5 users this is fine; if
// we ever add many users, cache the lookup for ~30s.

import { getSession, clearSessionCookie, destroySession, SESSION_COOKIE } from './sessions.js';
import { findActiveUserByEmail } from './allowlist.js';

function unauth(res, code, status = 401) {
  return res.status(status).json({ ok: false, error: 'Not authenticated', code });
}

async function resolveUser(req, res) {
  const token = req.cookies?.[SESSION_COOKIE];
  const session = getSession(token);
  if (!session) return null;

  // Re-check the user is still active. If they were deactivated, kill
  // the session immediately so future requests don't hit the DB again.
  const user = await findActiveUserByEmail(session.email);
  if (!user) {
    destroySession(token);
    clearSessionCookie(res);
    return null;
  }
  return user;
}

export async function requireAuth(req, res, next) {
  const user = await resolveUser(req, res);
  if (!user) return unauth(res, 'AUTH_REQUIRED');
  req.user = user;
  next();
}

export async function requireAdmin(req, res, next) {
  const user = await resolveUser(req, res);
  if (!user) return unauth(res, 'AUTH_REQUIRED');
  if (user.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Admin only', code: 'ADMIN_REQUIRED' });
  }
  req.user = user;
  next();
}

// Convenience for routes that want to behave differently for guests vs
// signed-in users without 401-ing (e.g. /api/me, the landing page).
export async function loadUser(req, _res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  const session = getSession(token);
  if (session) {
    const user = await findActiveUserByEmail(session.email);
    if (user) req.user = user;
  }
  next();
}
