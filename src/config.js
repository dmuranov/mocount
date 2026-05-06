// Centralised env-derived config. All env access lives here so the rest
// of the codebase can `import { CONFIG } from '../config.js'` and get a
// validated, typed view.

import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return String(v).trim();
}

function optional(name, fallback = '') {
  const v = process.env[name];
  return v == null ? fallback : String(v).trim();
}

export const CONFIG = {
  PORT: Number(process.env.PORT) || 3002,
  NODE_ENV: optional('NODE_ENV', 'development'),
  APP_URL: optional('APP_URL', 'http://localhost:3002'),

  SUPABASE_URL: optional('SUPABASE_URL'),
  SUPABASE_ANON_KEY: optional('SUPABASE_ANON_KEY'),
  SUPABASE_SERVICE_ROLE_KEY: optional('SUPABASE_SERVICE_ROLE_KEY'),

  GOOGLE_CLIENT_ID: optional('GOOGLE_CLIENT_ID'),
  GOOGLE_CLIENT_SECRET: optional('GOOGLE_CLIENT_SECRET'),
  GOOGLE_REDIRECT_URI: optional('GOOGLE_REDIRECT_URI', 'http://localhost:3002/auth/callback'),

  RESEND_API_KEY: optional('RESEND_API_KEY'),
  EMAIL_FROM: optional('EMAIL_FROM', 'mocount@mocount.com'),

  SESSION_SECRET: optional('SESSION_SECRET'),
};

// Step 3 demands these specifically; called at server boot so misconfig
// surfaces immediately, not on the first /auth/google click.
export function requireAuthEnv() {
  const missing = [];
  if (!CONFIG.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!CONFIG.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!CONFIG.GOOGLE_CLIENT_ID) missing.push('GOOGLE_CLIENT_ID');
  if (!CONFIG.GOOGLE_CLIENT_SECRET) missing.push('GOOGLE_CLIENT_SECRET');
  if (!CONFIG.SESSION_SECRET) missing.push('SESSION_SECRET');
  if (missing.length) {
    console.warn(`[config] auth env not yet set: ${missing.join(', ')} — /auth/* routes will fail until configured`);
  }
}
