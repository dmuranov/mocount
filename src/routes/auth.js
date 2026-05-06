// Auth routes: /auth/google, /auth/callback, /auth/logout, /api/me.
//
// SPEC §1: "OAuth callback only verifies, never inserts into users."
// Login flow:
//   1. /auth/google → 302 to Google with random state cookie
//   2. /auth/callback → verify state, exchange code, lookup allowlist:
//      hit  → create session, set cookie, redirect to "/"
//      miss → redirect to /access-denied (NO DB write)

import express from 'express';
import crypto from 'node:crypto';
import { CONFIG } from '../config.js';
import { buildAuthUrl, exchangeCodeForUser } from '../auth/google.js';
import { findActiveUserByEmail } from '../auth/allowlist.js';
import {
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  SESSION_COOKIE,
  getSession,
} from '../auth/sessions.js';

const STATE_COOKIE = 'mocount_oauth_state';
const STATE_TTL_S = 5 * 60; // 5 minutes

export const authRouter = express.Router();

// ── /auth/google ────────────────────────────────────────────
// Generate a CSRF state, stash it in an httpOnly cookie, redirect to
// Google. State must round-trip — callback compares it to the cookie.
authRouter.get('/auth/google', (_req, res) => {
  if (!CONFIG.GOOGLE_CLIENT_ID) {
    return res.status(503).send('Google OAuth not configured');
  }
  const state = crypto.randomBytes(16).toString('hex');
  const isProd = CONFIG.NODE_ENV === 'production';
  res.setHeader('Set-Cookie', [
    `${STATE_COOKIE}=${state}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${STATE_TTL_S}`,
    ...(isProd ? ['Secure'] : []),
  ].join('; '));
  return res.redirect(buildAuthUrl(state));
});

// ── /auth/callback ──────────────────────────────────────────
authRouter.get('/auth/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) {
      console.warn('[auth/callback] Google returned error:', error);
      return res.redirect('/access-denied');
    }
    if (!code) return res.redirect('/access-denied');

    const cookieState = req.cookies?.[STATE_COOKIE];
    if (!state || !cookieState || state !== cookieState) {
      console.warn('[auth/callback] state mismatch — possible CSRF');
      return res.redirect('/access-denied');
    }
    // Burn the state cookie regardless of outcome.
    res.append('Set-Cookie', `${STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);

    const profile = await exchangeCodeForUser(String(code));
    if (!profile.email_verified) {
      console.warn('[auth/callback] unverified Google email rejected:', profile.email);
      return res.redirect('/access-denied');
    }

    // Allowlist gate — NO insert if missing.
    const user = await findActiveUserByEmail(profile.email);
    if (!user) {
      console.log('[auth/callback] not on allowlist:', profile.email);
      return res.redirect('/access-denied');
    }

    const token = createSession(user);
    setSessionCookie(res, token, CONFIG.NODE_ENV === 'production');
    return res.redirect('/');
  } catch (err) {
    console.error('[auth/callback] error:', err.message);
    return res.redirect('/access-denied');
  }
});

// ── /auth/logout ────────────────────────────────────────────
authRouter.post('/auth/logout', (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  destroySession(token);
  clearSessionCookie(res);
  return res.json({ ok: true });
});

// ── /api/me ─────────────────────────────────────────────────
// Returns the current user (200) or null (200 with user:null) — never
// 401. The React shell calls this on every page load to decide between
// /login and the dashboard, so a 200 with null is the right shape.
authRouter.get('/api/me', async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  const session = getSession(token);
  if (!session) return res.json({ user: null });

  const user = await findActiveUserByEmail(session.email);
  if (!user) {
    destroySession(token);
    clearSessionCookie(res);
    return res.json({ user: null });
  }
  return res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      receives_monthly_email: user.receives_monthly_email,
    },
  });
});
