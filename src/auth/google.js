// Google OAuth (server-side). Direct OAuth 2.0 flow — we don't go
// through Supabase Auth because our user table is the canonical
// allowlist and Supabase Auth's parallel auth.users would just be
// confusing extra state.
//
// Flow:
//   1. buildAuthUrl(state) → 302 the user to Google with this URL
//   2. Google redirects back to GOOGLE_REDIRECT_URI?code=...&state=...
//   3. exchangeCodeForUser(code) → POSTs the code to Google's token
//      endpoint, then GETs userinfo, returns { email, name, sub }.
//
// CSRF: caller is responsible for generating a random `state` and
// verifying that the callback's state matches. We just pass it through.

import { CONFIG } from '../config.js';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';
const SCOPES = ['openid', 'email', 'profile'].join(' ');

export function buildAuthUrl(state) {
  if (!CONFIG.GOOGLE_CLIENT_ID) {
    throw new Error('GOOGLE_CLIENT_ID not configured');
  }
  const u = new URL(GOOGLE_AUTH);
  u.searchParams.set('client_id', CONFIG.GOOGLE_CLIENT_ID);
  u.searchParams.set('redirect_uri', CONFIG.GOOGLE_REDIRECT_URI);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('state', state);
  u.searchParams.set('access_type', 'online');
  u.searchParams.set('prompt', 'select_account');
  return u.toString();
}

export async function exchangeCodeForUser(code) {
  if (!CONFIG.GOOGLE_CLIENT_ID || !CONFIG.GOOGLE_CLIENT_SECRET) {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured');
  }

  // 1. Exchange code → access_token
  const tokenRes = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CONFIG.GOOGLE_CLIENT_ID,
      client_secret: CONFIG.GOOGLE_CLIENT_SECRET,
      redirect_uri: CONFIG.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '');
    throw new Error(`Google token exchange failed (${tokenRes.status}): ${body.slice(0, 200)}`);
  }
  const { access_token } = await tokenRes.json();
  if (!access_token) throw new Error('Google token response missing access_token');

  // 2. access_token → userinfo
  const userRes = await fetch(GOOGLE_USERINFO, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!userRes.ok) {
    const body = await userRes.text().catch(() => '');
    throw new Error(`Google userinfo failed (${userRes.status}): ${body.slice(0, 200)}`);
  }
  const info = await userRes.json();
  if (!info?.email) throw new Error('Google userinfo missing email');

  return {
    email: String(info.email).toLowerCase(),
    name: info.name || null,
    sub: info.sub || null,
    email_verified: info.email_verified === true,
  };
}
