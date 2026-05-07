// Numbers CRUD — SPEC §9. Auth-only for read; admin-only for writes.
// margin_per_mo is derived (selling - purchase) and never stored.
//
// All mutations write audit_log so price/ownership changes are
// traceable for monthly P&L disputes.

import express from 'express';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { supabase } from '../supabase.js';
import { auditLog, diffShallow } from '../util/audit.js';

export const numbersRouter = express.Router();

const VALID_TYPES = new Set(['SC', 'LVN']);

function normNumber(s) {
  return String(s || '').trim();
}
function normCountry(s) {
  // SPEC §2: ISO-3166 alpha-2 uppercase. Empty allowed (some legacy
  // imports may not have it). We trim + uppercase but don't enforce
  // 2-char strictly — the importer is the right place for that, since
  // pricing flows still work without country.
  const v = String(s ?? '').trim().toUpperCase();
  return v || null;
}
function normPrice(v, label) {
  if (v === null || v === undefined || v === '') {
    throw Object.assign(new Error(`${label} is required`), { code: 400 });
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw Object.assign(new Error(`${label} must be a non-negative number`), { code: 400 });
  }
  return n;
}

function rowShape(r) {
  if (!r) return null;
  const margin = (Number(r.selling_price_per_mo) || 0) - (Number(r.purchase_price_per_mo) || 0);
  return {
    id: r.id,
    number: r.number,
    type: r.type,
    country: r.country,
    client: r.client,
    purchase_price_per_mo: Number(r.purchase_price_per_mo),
    selling_price_per_mo: Number(r.selling_price_per_mo),
    margin_per_mo: Number(margin.toFixed(4)),
    active: r.active,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ── GET /api/numbers?active=true|false ──────────────────────
// No `active` query → all rows (admin needs deactivated rows to reactivate).
numbersRouter.get('/api/numbers', requireAuth, async (req, res) => {
  let query = supabase()
    .from('numbers')
    .select('*')
    .order('type', { ascending: true })
    .order('number', { ascending: true });

  if (req.query.active === 'true') query = query.eq('active', true);
  else if (req.query.active === 'false') query = query.eq('active', false);

  const { data, error } = await query;
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, numbers: (data || []).map(rowShape) });
});

// ── POST /api/numbers ───────────────────────────────────────
numbersRouter.post('/api/numbers', requireAdmin, async (req, res) => {
  try {
    const number = normNumber(req.body?.number);
    if (!number) return res.status(400).json({ ok: false, error: 'number is required' });
    const type = String(req.body?.type || '').trim().toUpperCase();
    if (!VALID_TYPES.has(type)) return res.status(400).json({ ok: false, error: 'type must be SC or LVN' });
    const country = normCountry(req.body?.country);
    const client = (String(req.body?.client ?? '').trim()) || null;
    const purchase = normPrice(req.body?.purchase_price_per_mo, 'purchase_price_per_mo');
    const selling = normPrice(req.body?.selling_price_per_mo, 'selling_price_per_mo');
    const active = req.body?.active === false ? false : true;

    const { data, error } = await supabase()
      .from('numbers')
      .insert({
        number,
        type,
        country,
        client,
        purchase_price_per_mo: purchase,
        selling_price_per_mo: selling,
        active,
        updated_by: req.user.id,
      })
      .select('*')
      .maybeSingle();

    if (error) {
      if (error.code === '23505') return res.status(409).json({ ok: false, error: 'A number with that value already exists' });
      return res.status(500).json({ ok: false, error: error.message });
    }

    await auditLog({
      userId: req.user.id,
      action: 'number.create',
      entity: 'number',
      entityId: data.id,
      diff: { number, type, country, client, purchase, selling, active },
    });

    res.json({ ok: true, number: rowShape(data) });
  } catch (e) {
    res.status(e.code || 500).json({ ok: false, error: e.message });
  }
});

// ── PATCH /api/numbers/:id ──────────────────────────────────
numbersRouter.patch('/api/numbers/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const { data: existing, error: loadErr } = await supabase()
      .from('numbers').select('*').eq('id', id).maybeSingle();
    if (loadErr) return res.status(500).json({ ok: false, error: loadErr.message });
    if (!existing) return res.status(404).json({ ok: false, error: 'Number not found' });

    const patch = { updated_by: req.user.id };
    if (req.body?.number !== undefined) {
      const v = normNumber(req.body.number);
      if (!v) return res.status(400).json({ ok: false, error: 'number cannot be empty' });
      patch.number = v;
    }
    if (req.body?.type !== undefined) {
      const t = String(req.body.type).trim().toUpperCase();
      if (!VALID_TYPES.has(t)) return res.status(400).json({ ok: false, error: 'type must be SC or LVN' });
      patch.type = t;
    }
    if (req.body?.country !== undefined) patch.country = normCountry(req.body.country);
    if (req.body?.client !== undefined) {
      const c = String(req.body.client ?? '').trim();
      patch.client = c || null;
    }
    if (req.body?.purchase_price_per_mo !== undefined) {
      patch.purchase_price_per_mo = normPrice(req.body.purchase_price_per_mo, 'purchase_price_per_mo');
    }
    if (req.body?.selling_price_per_mo !== undefined) {
      patch.selling_price_per_mo = normPrice(req.body.selling_price_per_mo, 'selling_price_per_mo');
    }
    if (req.body?.active !== undefined) patch.active = req.body.active === true;

    // updated_by is always set; if NOTHING else changed, fail clean.
    if (Object.keys(patch).length <= 1) {
      return res.status(400).json({ ok: false, error: 'No fields to update' });
    }

    const { data: updated, error: updErr } = await supabase()
      .from('numbers').update(patch).eq('id', id)
      .select('*').maybeSingle();
    if (updErr) {
      if (updErr.code === '23505') return res.status(409).json({ ok: false, error: 'A number with that value already exists' });
      return res.status(500).json({ ok: false, error: updErr.message });
    }

    await auditLog({
      userId: req.user.id,
      action: 'number.update',
      entity: 'number',
      entityId: id,
      diff: diffShallow(existing, updated),
    });

    res.json({ ok: true, number: rowShape(updated) });
  } catch (e) {
    res.status(e.code || 500).json({ ok: false, error: e.message });
  }
});

// ── DELETE /api/numbers/:id (soft) ──────────────────────────
// Sets active=false. Hard delete would CASCADE wipe daily_volumes
// and fees — we never want that for a number that was billed.
numbersRouter.delete('/api/numbers/:id', requireAdmin, async (req, res) => {
  const id = req.params.id;
  const { data: existing, error: loadErr } = await supabase()
    .from('numbers').select('id, number, active').eq('id', id).maybeSingle();
  if (loadErr) return res.status(500).json({ ok: false, error: loadErr.message });
  if (!existing) return res.status(404).json({ ok: false, error: 'Number not found' });

  const { error: updErr } = await supabase()
    .from('numbers')
    .update({ active: false, updated_by: req.user.id })
    .eq('id', id);
  if (updErr) return res.status(500).json({ ok: false, error: updErr.message });

  await auditLog({
    userId: req.user.id,
    action: 'number.deactivate',
    entity: 'number',
    entityId: id,
    diff: { active: [existing.active, false] },
  });

  res.json({ ok: true });
});
