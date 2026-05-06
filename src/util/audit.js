// Audit log helper. Every financial mutation + every user mutation
// must call this. Fire-and-forget; we never let an audit failure
// block the user-facing operation, but we do log to console so a
// silent audit gap is visible.

import { supabase } from '../supabase.js';

export async function auditLog({ userId, action, entity, entityId, diff }) {
  try {
    const { error } = await supabase()
      .from('audit_log')
      .insert({
        user_id: userId || null,
        action,
        entity: entity || null,
        entity_id: entityId != null ? String(entityId) : null,
        diff: diff || null,
      });
    if (error) console.warn('[audit] insert failed:', error.message, { action, entity, entityId });
  } catch (err) {
    console.warn('[audit] error:', err.message);
  }
}

// Compute a shallow diff between before/after objects, only for keys
// that actually changed. Returns { keyName: [oldValue, newValue], ... }.
// Used by PATCH endpoints so the audit row records exactly what flipped.
export function diffShallow(before, after) {
  const out = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    const a = before?.[k];
    const b = after?.[k];
    if (a !== b) out[k] = [a, b];
  }
  return Object.keys(out).length ? out : null;
}
