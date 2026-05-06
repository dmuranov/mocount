// Server-side Supabase client. Uses the service-role key so it bypasses
// RLS — this is intentional for the API layer (auth/role gates live in
// our middleware, not in Postgres policies). The service role key
// MUST NEVER reach the browser; only `src/**` modules import this.

import { createClient } from '@supabase/supabase-js';
import { CONFIG } from './config.js';

let _client = null;

export function supabase() {
  if (_client) return _client;
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase env not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  }
  _client = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _client;
}
