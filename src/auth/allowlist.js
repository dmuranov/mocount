// Allowlist check — SPEC §1: "the only way an account exists is if an
// admin created it via the Users page."
//
// findActiveUserByEmail returns the user row if email matches AND
// active=true, otherwise null. NEVER inserts. Called both at OAuth
// callback (login gate) and on every authenticated request (deactivation
// must log out on next request).

import { supabase } from '../supabase.js';

export async function findActiveUserByEmail(email) {
  if (!email) return null;
  const normalized = String(email).trim().toLowerCase();
  const { data, error } = await supabase()
    .from('users')
    .select('id, email, name, role, receives_monthly_email, active')
    .eq('email', normalized)
    .eq('active', true)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[allowlist] lookup failed:', error.message);
    return null;
  }
  return data || null;
}
