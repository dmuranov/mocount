// Users CRUD — admin-only. SPEC §1: "the only way an account exists
// is if an admin created it via the Users page." So POST is the entry
// point — there's no signup, no auto-create.
//
// Guardrails baked in here (not just in UI):
//   - No demoting/deactivating yourself (would lock you out instantly).
//   - At least one active admin must remain after any mutation.
//   - Email is lowercased + trimmed + uniqueness-checked at the DB.

import express from 'express';
import { requireAdmin } from '../auth/middleware.js';
import { destroyAllSessionsForEmail } from '../auth/sessions.js';
import { supabase } from '../supabase.js';
import { auditLog, diffShallow } from '../util/audit.js';

export const usersRouter = express.Router();

const VALID_ROLES = new Set(['admin', 'viewer']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normEmail(s) {
  return String(s || '').trim().toLowerCase();
}

async function countActiveAdmins() {
  const { count, error } = await supabase()
    .from('users')
    .select('*', { count: 'exact', head: true })
    .eq('role', 'admin')
    .eq('active', true);
  if (error) throw new Error('Could not count admins: ' + error.message);
  return count || 0;
}

// ── GET /api/users ──────────────────────────────────────────
// Returns all users (admin needs to see deactivated ones to reactivate).
usersRouter.get('/api/users', requireAdmin, async (_req, res) => {
  const { data, error } = await supabase()
    .from('users')
    .select('id, email, name, role, receives_monthly_email, active, created_at')
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, users: data || [] });
});

// ── POST /api/users ─────────────────────────────────────────
usersRouter.post('/api/users', requireAdmin, async (req, res) => {
  const email = normEmail(req.body?.email);
  const name = (req.body?.name || '').trim() || null;
  const role = String(req.body?.role || '').trim();
  const receives_monthly_email = req.body?.receives_monthly_email === true;

  if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: 'Invalid email' });
  if (!VALID_ROLES.has(role)) return res.status(400).json({ ok: false, error: 'role must be admin or viewer' });

  const { data, error } = await supabase()
    .from('users')
    .insert({ email, name, role, receives_monthly_email, active: true, created_by: req.user.id })
    .select('id, email, name, role, receives_monthly_email, active')
    .maybeSingle();

  if (error) {
    if (error.code === '23505') return res.status(409).json({ ok: false, error: 'A user with that email already exists' });
    return res.status(500).json({ ok: false, error: error.message });
  }

  await auditLog({
    userId: req.user.id,
    action: 'user.create',
    entity: 'user',
    entityId: data.id,
    diff: { email, role, receives_monthly_email },
  });

  res.json({ ok: true, user: data });
});

// ── PATCH /api/users/:id ────────────────────────────────────
usersRouter.patch('/api/users/:id', requireAdmin, async (req, res) => {
  const id = req.params.id;

  // Load current row so we can diff + run guardrails before writing.
  const { data: existing, error: loadErr } = await supabase()
    .from('users')
    .select('id, email, name, role, receives_monthly_email, active')
    .eq('id', id)
    .maybeSingle();
  if (loadErr) return res.status(500).json({ ok: false, error: loadErr.message });
  if (!existing) return res.status(404).json({ ok: false, error: 'User not found' });

  // Build patch from allowed fields only.
  const patch = {};
  if (req.body?.name !== undefined) patch.name = (String(req.body.name).trim() || null);
  if (req.body?.role !== undefined) {
    if (!VALID_ROLES.has(req.body.role)) return res.status(400).json({ ok: false, error: 'role must be admin or viewer' });
    patch.role = req.body.role;
  }
  if (req.body?.receives_monthly_email !== undefined) {
    patch.receives_monthly_email = req.body.receives_monthly_email === true;
  }
  if (req.body?.active !== undefined) {
    patch.active = req.body.active === true;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ ok: false, error: 'No fields to update' });
  }

  // Guardrail: no self-demote / self-deactivate (would lock you out).
  if (existing.id === req.user.id) {
    if (patch.role && patch.role !== 'admin') {
      return res.status(400).json({ ok: false, error: 'You cannot demote yourself' });
    }
    if (patch.active === false) {
      return res.status(400).json({ ok: false, error: 'You cannot deactivate yourself' });
    }
  }

  // Guardrail: at least one active admin must remain.
  const becomingNonAdmin = patch.role && patch.role !== 'admin' && existing.role === 'admin';
  const becomingInactive = patch.active === false && existing.active === true;
  if ((becomingNonAdmin || becomingInactive) && existing.role === 'admin' && existing.active === true) {
    const admins = await countActiveAdmins();
    if (admins <= 1) {
      return res.status(400).json({ ok: false, error: 'At least one active admin must remain' });
    }
  }

  const { data: updated, error: updErr } = await supabase()
    .from('users')
    .update(patch)
    .eq('id', id)
    .select('id, email, name, role, receives_monthly_email, active')
    .maybeSingle();
  if (updErr) return res.status(500).json({ ok: false, error: updErr.message });

  // If they were just deactivated, kill any live sessions.
  if (patch.active === false) {
    destroyAllSessionsForEmail(existing.email);
  }

  await auditLog({
    userId: req.user.id,
    action: 'user.update',
    entity: 'user',
    entityId: id,
    diff: diffShallow(existing, updated),
  });

  res.json({ ok: true, user: updated });
});

// ── DELETE /api/users/:id (soft) ────────────────────────────
// Sets active=false. Real deletion would orphan audit_log rows + lose
// history; the spec is explicit that we keep them.
usersRouter.delete('/api/users/:id', requireAdmin, async (req, res) => {
  const id = req.params.id;

  const { data: existing, error: loadErr } = await supabase()
    .from('users')
    .select('id, email, role, active')
    .eq('id', id)
    .maybeSingle();
  if (loadErr) return res.status(500).json({ ok: false, error: loadErr.message });
  if (!existing) return res.status(404).json({ ok: false, error: 'User not found' });

  if (existing.id === req.user.id) {
    return res.status(400).json({ ok: false, error: 'You cannot deactivate yourself' });
  }
  if (existing.role === 'admin' && existing.active) {
    const admins = await countActiveAdmins();
    if (admins <= 1) return res.status(400).json({ ok: false, error: 'At least one active admin must remain' });
  }

  const { error: updErr } = await supabase()
    .from('users')
    .update({ active: false })
    .eq('id', id);
  if (updErr) return res.status(500).json({ ok: false, error: updErr.message });

  destroyAllSessionsForEmail(existing.email);

  await auditLog({
    userId: req.user.id,
    action: 'user.deactivate',
    entity: 'user',
    entityId: id,
    diff: { active: [true, false] },
  });

  res.json({ ok: true });
});
