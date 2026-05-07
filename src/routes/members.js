// LVN members CRUD — change request LVN-3.
//
// Members are individual phone numbers inside an LVN group. Service
// layer guards: a member can only attach to a number whose type is
// 'LVN'. Attempting to attach to an SC returns 400.
//
// Soft-delete via `active = false` keeps audit references intact.
// Re-adding a phone that was previously inactive on the same parent
// reactivates the existing row (no duplicate insert).

import express from 'express';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { supabase } from '../supabase.js';
import { auditLog, diffShallow } from '../util/audit.js';

export const membersRouter = express.Router();

// Phone validation: digits + optional leading +, length 6–20.
// Real-world MSISDNs are E.164 (max 15 digits), but some legacy
// pilot pools use longer test numbers — keep the upper bound loose.
const PHONE_RE = /^\+?\d{6,20}$/;

function normPhone(raw, label = 'phone') {
  const s = String(raw ?? '').trim();
  if (!s) throw Object.assign(new Error(`${label} is required`), { code: 400 });
  if (!PHONE_RE.test(s)) {
    throw Object.assign(new Error(`${label} must be 6–20 digits, optional leading +`), { code: 400 });
  }
  return s;
}

function shape(m) {
  if (!m) return null;
  return {
    id: m.id,
    number_id: m.number_id,
    phone: m.phone,
    active: m.active,
    created_at: m.created_at,
  };
}

// Load parent number; throw 404/400 with structured error if missing
// or not type='LVN'. Used by every endpoint that takes :id.
async function loadLvnParent(numberId) {
  const { data, error } = await supabase()
    .from('numbers').select('id, type').eq('id', numberId).maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { code: 500 });
  if (!data) throw Object.assign(new Error('Number not found'), { code: 404 });
  if (data.type !== 'LVN') {
    throw Object.assign(new Error('Members are only valid for LVN-type numbers'), { code: 400 });
  }
  return data;
}

// ── GET /api/numbers/:id/members ────────────────────────────
// Lists every member, active + inactive. UI hides inactive by default
// behind a "Show removed" toggle.
membersRouter.get('/api/numbers/:id/members', requireAuth, async (req, res) => {
  try {
    await loadLvnParent(req.params.id);
    const { data, error } = await supabase()
      .from('lvn_members')
      .select('id, number_id, phone, active, created_at')
      .eq('number_id', req.params.id)
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, members: (data || []).map(shape) });
  } catch (e) {
    res.status(e.code || 500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/numbers/:id/members ───────────────────────────
// Add a member. If the same phone exists inactive on this parent,
// reactivate that row instead of inserting a duplicate (the
// (number_id, phone) unique constraint would block it anyway).
membersRouter.post('/api/numbers/:id/members', requireAdmin, async (req, res) => {
  try {
    await loadLvnParent(req.params.id);
    const phone = normPhone(req.body?.phone);

    const sb = supabase();
    const { data: existing, error: lookupErr } = await sb
      .from('lvn_members')
      .select('id, active')
      .eq('number_id', req.params.id)
      .eq('phone', phone)
      .maybeSingle();
    if (lookupErr) return res.status(500).json({ ok: false, error: lookupErr.message });

    if (existing && existing.active) {
      return res.status(409).json({ ok: false, error: `Phone ${phone} is already a member` });
    }

    if (existing) {
      const { data: revived, error: upErr } = await sb
        .from('lvn_members').update({ active: true }).eq('id', existing.id)
        .select('*').maybeSingle();
      if (upErr) return res.status(500).json({ ok: false, error: upErr.message });
      await auditLog({
        userId: req.user.id,
        action: 'lvn_member.add',
        entity: 'lvn_member',
        entityId: revived.id,
        diff: { number_id: req.params.id, phone, source: 'reactivate' },
      });
      return res.json({ ok: true, member: shape(revived) });
    }

    const { data: created, error: insErr } = await sb
      .from('lvn_members')
      .insert({ number_id: req.params.id, phone, created_by: req.user.id, active: true })
      .select('*').maybeSingle();
    if (insErr) return res.status(500).json({ ok: false, error: insErr.message });

    await auditLog({
      userId: req.user.id,
      action: 'lvn_member.add',
      entity: 'lvn_member',
      entityId: created.id,
      diff: { number_id: req.params.id, phone },
    });

    res.json({ ok: true, member: shape(created) });
  } catch (e) {
    res.status(e.code || 500).json({ ok: false, error: e.message });
  }
});

// ── PATCH /api/lvn-members/:memberId ────────────────────────
// Allowed: phone (with re-validation), active. Cannot move a member
// between parent numbers — delete and re-add is the right primitive
// for that, and the audit trail stays clearer.
membersRouter.patch('/api/lvn-members/:memberId', requireAdmin, async (req, res) => {
  try {
    const id = req.params.memberId;
    const sb = supabase();
    const { data: existing, error: loadErr } = await sb
      .from('lvn_members').select('*').eq('id', id).maybeSingle();
    if (loadErr) return res.status(500).json({ ok: false, error: loadErr.message });
    if (!existing) return res.status(404).json({ ok: false, error: 'Member not found' });

    const patch = {};
    if (req.body?.phone !== undefined) patch.phone = normPhone(req.body.phone);
    if (req.body?.active !== undefined) patch.active = req.body.active === true;

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ ok: false, error: 'No fields to update' });
    }

    const { data: updated, error: updErr } = await sb
      .from('lvn_members').update(patch).eq('id', id).select('*').maybeSingle();
    if (updErr) {
      if (updErr.code === '23505') {
        return res.status(409).json({ ok: false, error: 'Another member already has that phone' });
      }
      return res.status(500).json({ ok: false, error: updErr.message });
    }

    await auditLog({
      userId: req.user.id,
      action: 'lvn_member.update',
      entity: 'lvn_member',
      entityId: id,
      diff: diffShallow(existing, updated),
    });

    res.json({ ok: true, member: shape(updated) });
  } catch (e) {
    res.status(e.code || 500).json({ ok: false, error: e.message });
  }
});

// ── DELETE /api/lvn-members/:memberId ───────────────────────
// Soft delete (sets active=false). Hard delete would CASCADE-orphan
// audit references that point to the row.
membersRouter.delete('/api/lvn-members/:memberId', requireAdmin, async (req, res) => {
  const id = req.params.memberId;
  const sb = supabase();
  const { data: existing, error: loadErr } = await sb
    .from('lvn_members').select('id, number_id, phone, active').eq('id', id).maybeSingle();
  if (loadErr) return res.status(500).json({ ok: false, error: loadErr.message });
  if (!existing) return res.status(404).json({ ok: false, error: 'Member not found' });

  if (existing.active) {
    const { error: updErr } = await sb
      .from('lvn_members').update({ active: false }).eq('id', id);
    if (updErr) return res.status(500).json({ ok: false, error: updErr.message });
  }

  await auditLog({
    userId: req.user.id,
    action: 'lvn_member.remove',
    entity: 'lvn_member',
    entityId: id,
    diff: { number_id: existing.number_id, phone: existing.phone, active: [existing.active, false] },
  });

  res.json({ ok: true });
});
