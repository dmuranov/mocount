// Fees CRUD — SPEC §2 (fees table) + §14 step 7.
//
// Single-active rule: at most one *open-ended* monthly fee per
// (number_id, type='monthly', side). Inserting a new monthly fee
// auto-closes the prior one by stamping effective_to = day before
// the new effective_from. Setup fees ignore effective_to and may
// repeat across months.
//
// Every mutation writes audit_log: fee.create / fee.update / fee.delete.
// Editing amount on a billed-month-locked fee is *not* blocked here —
// the closed-month guard lives in volumes (where the actual billing
// math happens). Fees are metadata; nothing in fees calculates without
// a daily_volume row to multiply against.

import express from 'express';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { supabase } from '../supabase.js';
import { auditLog, diffShallow } from '../util/audit.js';

export const feesRouter = express.Router();

const VALID_TYPES = new Set(['monthly', 'yearly', 'setup']);
const RECURRING_TYPES = new Set(['monthly', 'yearly']);
const VALID_SIDES = new Set(['cost', 'sale']);

function normAmount(v, label) {
  if (v === null || v === undefined || v === '') {
    throw Object.assign(new Error(`${label} is required`), { code: 400 });
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw Object.assign(new Error(`${label} must be a non-negative number`), { code: 400 });
  }
  return Number(n.toFixed(2));
}

function normDate(v, label) {
  // Accept 'YYYY-MM-DD' (we don't allow excel-serial here — that's the
  // importer's job; CRUD is for human-typed values).
  const s = String(v ?? '').trim();
  if (!s) throw Object.assign(new Error(`${label} is required`), { code: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw Object.assign(new Error(`${label} must be YYYY-MM-DD`), { code: 400 });
  }
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) {
    throw Object.assign(new Error(`${label} is not a valid date`), { code: 400 });
  }
  return s;
}

// 'YYYY-MM-DD' minus one day, UTC. Used to close an ongoing monthly
// fee the moment a new one starts: prior.effective_to = new.effective_from - 1.
function dayBefore(yyyyMmDd) {
  const d = new Date(yyyyMmDd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function shape(f) {
  if (!f) return null;
  return {
    id: f.id,
    number_id: f.number_id,
    type: f.type,
    side: f.side,
    amount: Number(f.amount),
    effective_from: f.effective_from,
    effective_to: f.effective_to,
    created_at: f.created_at,
    created_by: f.created_by,
  };
}

// ── GET /api/numbers/:id/fees ───────────────────────────────
// Lists every fee for a number, all states (active, closed, setup
// past). The detail page wants the full history, not just current.
feesRouter.get('/api/numbers/:id/fees', requireAuth, async (req, res) => {
  const numberId = req.params.id;
  const { data, error } = await supabase()
    .from('fees')
    .select('*')
    .eq('number_id', numberId)
    .order('side', { ascending: true })
    .order('type', { ascending: true })
    .order('effective_from', { ascending: false });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, fees: (data || []).map(shape) });
});

// ── POST /api/numbers/:id/fees ──────────────────────────────
// For monthly fees we enforce single-active: close any prior ongoing
// row before inserting.
feesRouter.post('/api/numbers/:id/fees', requireAdmin, async (req, res) => {
  try {
    const numberId = req.params.id;

    // Number must exist (otherwise FK insert error is unfriendly).
    const { data: num, error: numErr } = await supabase()
      .from('numbers').select('id').eq('id', numberId).maybeSingle();
    if (numErr) return res.status(500).json({ ok: false, error: numErr.message });
    if (!num) return res.status(404).json({ ok: false, error: 'Number not found' });

    const type = String(req.body?.type || '').trim().toLowerCase();
    if (!VALID_TYPES.has(type)) return res.status(400).json({ ok: false, error: "type must be 'monthly' or 'setup'" });
    const side = String(req.body?.side || '').trim().toLowerCase();
    if (!VALID_SIDES.has(side)) return res.status(400).json({ ok: false, error: "side must be 'cost' or 'sale'" });

    const amount = normAmount(req.body?.amount, 'amount');
    const effective_from = normDate(req.body?.effective_from, 'effective_from');
    let effective_to = null;
    if (RECURRING_TYPES.has(type) && req.body?.effective_to) {
      effective_to = normDate(req.body.effective_to, 'effective_to');
      if (effective_to < effective_from) {
        return res.status(400).json({ ok: false, error: 'effective_to cannot be before effective_from' });
      }
    }

    // Single-active rule: close any prior open-ended recurring fee
    // (monthly or yearly) on the same (number, type, side) before
    // inserting the new one. Setup fees stay independent.
    let closedPriorId = null;
    if (RECURRING_TYPES.has(type)) {
      const { data: prior, error: priorErr } = await supabase()
        .from('fees')
        .select('id, effective_from, effective_to')
        .eq('number_id', numberId)
        .eq('type', type)
        .eq('side', side)
        .is('effective_to', null)
        .maybeSingle();
      if (priorErr) return res.status(500).json({ ok: false, error: priorErr.message });
      if (prior) {
        const closeAt = dayBefore(effective_from);
        if (closeAt < prior.effective_from) {
          return res.status(400).json({
            ok: false,
            error: `New fee starts ${effective_from} but prior fee already starts ${prior.effective_from}; pick a later date or edit the prior fee instead`,
          });
        }
        const { error: closeErr } = await supabase()
          .from('fees').update({ effective_to: closeAt }).eq('id', prior.id);
        if (closeErr) return res.status(500).json({ ok: false, error: 'Failed to close prior fee: ' + closeErr.message });
        closedPriorId = prior.id;
        await auditLog({
          userId: req.user.id,
          action: 'fee.close',
          entity: 'fee',
          entityId: prior.id,
          diff: { effective_to: [null, closeAt], reason: 'superseded by new fee' },
        });
      }
    }

    const insertRow = {
      number_id: numberId,
      type,
      side,
      amount,
      effective_from,
      effective_to,
      created_by: req.user.id,
    };
    const { data: created, error: insErr } = await supabase()
      .from('fees').insert(insertRow).select('*').maybeSingle();
    if (insErr) return res.status(500).json({ ok: false, error: insErr.message });

    await auditLog({
      userId: req.user.id,
      action: 'fee.create',
      entity: 'fee',
      entityId: created.id,
      diff: { ...insertRow, ...(closedPriorId ? { closed_prior_fee: closedPriorId } : {}) },
    });

    res.json({ ok: true, fee: shape(created) });
  } catch (e) {
    res.status(e.code || 500).json({ ok: false, error: e.message });
  }
});

// ── PATCH /api/fees/:id ─────────────────────────────────────
// Allowed: amount, effective_from, effective_to. We don't allow
// type/side/number_id edits — those define the fee's identity. If you
// got the side wrong, delete and re-create.
feesRouter.patch('/api/fees/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const { data: existing, error: loadErr } = await supabase()
      .from('fees').select('*').eq('id', id).maybeSingle();
    if (loadErr) return res.status(500).json({ ok: false, error: loadErr.message });
    if (!existing) return res.status(404).json({ ok: false, error: 'Fee not found' });

    const patch = {};
    if (req.body?.amount !== undefined) {
      patch.amount = normAmount(req.body.amount, 'amount');
    }
    if (req.body?.effective_from !== undefined) {
      patch.effective_from = normDate(req.body.effective_from, 'effective_from');
    }
    if (req.body?.effective_to !== undefined) {
      if (req.body.effective_to === null || req.body.effective_to === '') {
        if (!RECURRING_TYPES.has(existing.type)) {
          return res.status(400).json({ ok: false, error: 'Only recurring fees (monthly/yearly) may have effective_to' });
        }
        patch.effective_to = null;
      } else {
        patch.effective_to = normDate(req.body.effective_to, 'effective_to');
      }
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ ok: false, error: 'No fields to update' });
    }

    const fromDate = patch.effective_from ?? existing.effective_from;
    const toDate = patch.effective_to !== undefined ? patch.effective_to : existing.effective_to;
    if (toDate && fromDate && toDate < fromDate) {
      return res.status(400).json({ ok: false, error: 'effective_to cannot be before effective_from' });
    }

    const { data: updated, error: updErr } = await supabase()
      .from('fees').update(patch).eq('id', id).select('*').maybeSingle();
    if (updErr) return res.status(500).json({ ok: false, error: updErr.message });

    await auditLog({
      userId: req.user.id,
      action: 'fee.update',
      entity: 'fee',
      entityId: id,
      diff: diffShallow(existing, updated),
    });

    res.json({ ok: true, fee: shape(updated) });
  } catch (e) {
    res.status(e.code || 500).json({ ok: false, error: e.message });
  }
});

// ── DELETE /api/fees/:id ────────────────────────────────────
// Hard delete. Fees aren't billed directly — they're inputs to the
// month report — so removing one only affects future re-runs of the
// report. We snapshot the row in audit so the change is reversible
// from the audit page if someone deletes the wrong fee.
feesRouter.delete('/api/fees/:id', requireAdmin, async (req, res) => {
  const id = req.params.id;
  const { data: existing, error: loadErr } = await supabase()
    .from('fees').select('*').eq('id', id).maybeSingle();
  if (loadErr) return res.status(500).json({ ok: false, error: loadErr.message });
  if (!existing) return res.status(404).json({ ok: false, error: 'Fee not found' });

  const { error: delErr } = await supabase().from('fees').delete().eq('id', id);
  if (delErr) return res.status(500).json({ ok: false, error: delErr.message });

  await auditLog({
    userId: req.user.id,
    action: 'fee.delete',
    entity: 'fee',
    entityId: id,
    diff: { deleted: shape(existing) },
  });

  res.json({ ok: true });
});
