// Numbers CRUD — SPEC §9. Auth-only for read; admin-only for writes.
// margin_per_mo is derived (selling - purchase) and never stored.
//
// All mutations write audit_log so price/ownership changes are
// traceable for monthly P&L disputes.

import express from 'express';
import * as XLSX from 'xlsx';
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

function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function yesterdayISO() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// Close any open price-history row for (number_id, side[, operator group]) and
// insert a new row effective from today. operatorGroupId=null is the number's
// default rate; a uuid scopes the window to that operator override group.
// Same-day re-edit is treated as a correction: update the open row in place.
async function logPriceChange({ numberId, side, newPrice, userId, operatorGroupId = null }) {
  const today = todayISO();
  let sel = supabase()
    .from('number_price_history')
    .select('id, effective_from, price')
    .eq('number_id', numberId).eq('side', side).is('effective_to', null);
  sel = operatorGroupId == null ? sel.is('operator_group_id', null) : sel.eq('operator_group_id', operatorGroupId);
  const { data: open } = await sel.maybeSingle();

  if (open && open.effective_from === today) {
    await supabase()
      .from('number_price_history')
      .update({ price: newPrice, created_by: userId })
      .eq('id', open.id);
    return;
  }
  if (open) {
    await supabase()
      .from('number_price_history')
      .update({ effective_to: yesterdayISO() })
      .eq('id', open.id);
  }
  await supabase()
    .from('number_price_history')
    .insert({ number_id: numberId, side, price: newPrice, effective_from: today, created_by: userId, operator_group_id: operatorGroupId });
}

// Normalize an MNC list: accept an array or a comma/space-separated string.
function normMncs(v) {
  const arr = Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/);
  return [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))];
}

function groupShape(g) {
  if (!g) return null;
  const margin = (Number(g.selling_price_per_mo) || 0) - (Number(g.purchase_price_per_mo) || 0);
  return {
    id: g.id,
    number_id: g.number_id,
    label: g.label,
    mncs: g.mncs || [],
    purchase_price_per_mo: Number(g.purchase_price_per_mo),
    selling_price_per_mo: Number(g.selling_price_per_mo),
    margin_per_mo: Number(margin.toFixed(4)),
    active: g.active,
  };
}

function rowShape(r, groups = []) {
  if (!r) return null;
  const margin = (Number(r.selling_price_per_mo) || 0) - (Number(r.purchase_price_per_mo) || 0);
  const operatorGroups = (groups || []).map(groupShape);
  const hasOp = operatorGroups.length > 0;
  // Displayed avg = simple mean of the default rate + each group rate. Purely
  // cosmetic (the asterisk row); exact billing is per-operator under the hood.
  let avgPurchase = Number(r.purchase_price_per_mo);
  let avgSelling = Number(r.selling_price_per_mo);
  if (hasOp) {
    const buys = [Number(r.purchase_price_per_mo), ...operatorGroups.map((g) => g.purchase_price_per_mo)];
    const sells = [Number(r.selling_price_per_mo), ...operatorGroups.map((g) => g.selling_price_per_mo)];
    avgPurchase = Number((buys.reduce((a, b) => a + b, 0) / buys.length).toFixed(4));
    avgSelling = Number((sells.reduce((a, b) => a + b, 0) / sells.length).toFixed(4));
  }
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
    has_operator_pricing: hasOp,
    operator_groups: operatorGroups,
    avg_purchase_price_per_mo: avgPurchase,
    avg_selling_price_per_mo: avgSelling,
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

  // Attach active operator-pricing groups so the list can show the asterisk + avg.
  const { data: groups, error: gErr } = await supabase()
    .from('number_operator_prices')
    .select('id, number_id, label, mncs, purchase_price_per_mo, selling_price_per_mo, active')
    .eq('active', true);
  if (gErr) return res.status(500).json({ ok: false, error: gErr.message });
  const groupsByNum = new Map();
  for (const g of groups || []) {
    if (!groupsByNum.has(g.number_id)) groupsByNum.set(g.number_id, []);
    groupsByNum.get(g.number_id).push(g);
  }

  res.json({ ok: true, numbers: (data || []).map((n) => rowShape(n, groupsByNum.get(n.id) || [])) });
});

// ── GET /api/numbers/export.xlsx ────────────────────────────
// Workbook with one row per number, columns matching the importer
// (so an export → edit → re-import round-trip is possible). Fees
// and LVN members are deliberately not exported here — those are
// edited via the Number drawer and have their own audit trail.
numbersRouter.get('/api/numbers/export.xlsx', requireAuth, async (_req, res) => {
  const { data, error } = await supabase()
    .from('numbers')
    .select('number, type, country, client, purchase_price_per_mo, selling_price_per_mo, active')
    .order('type', { ascending: true })
    .order('number', { ascending: true });
  if (error) return res.status(500).json({ ok: false, error: error.message });

  const rows = (data || []).map((n) => ({
    number: n.number,
    type: n.type,
    country: n.country || '',
    client: n.client || '',
    purchase_price: Number(n.purchase_price_per_mo),
    selling_price: Number(n.selling_price_per_mo),
    active: n.active ? 'true' : 'false',
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows, {
    header: ['number', 'type', 'country', 'client', 'purchase_price', 'selling_price', 'active'],
  }), 'Numbers');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="mocount-numbers.xlsx"');
  res.send(buf);
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

    // Log price changes to number_price_history so pro forma invoices can
    // split mid-month rate changes into separate line items.
    if (Number(existing.purchase_price_per_mo) !== Number(updated.purchase_price_per_mo)) {
      await logPriceChange({ numberId: id, side: 'purchase', newPrice: Number(updated.purchase_price_per_mo), userId: req.user.id });
    }
    if (Number(existing.selling_price_per_mo) !== Number(updated.selling_price_per_mo)) {
      await logPriceChange({ numberId: id, side: 'selling', newPrice: Number(updated.selling_price_per_mo), userId: req.user.id });
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

// ── Operator pricing groups ─────────────────────────────────
// A number can carry per-operator override rates (label + MNC set). The
// number's own purchase/selling stays the default (catch-all) rate; groups
// override it for their MNCs. Each group keeps its own price_history window
// (operator_group_id) so invoices can price past months correctly.

// GET /api/numbers/:id/operator-pricing
numbersRouter.get('/api/numbers/:id/operator-pricing', requireAuth, async (req, res) => {
  const { data, error } = await supabase()
    .from('number_operator_prices')
    .select('*').eq('number_id', req.params.id).order('label', { ascending: true });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, groups: (data || []).map(groupShape) });
});

// POST /api/numbers/:id/operator-pricing
numbersRouter.post('/api/numbers/:id/operator-pricing', requireAdmin, async (req, res) => {
  try {
    const numberId = req.params.id;
    const { data: num, error: nErr } = await supabase().from('numbers').select('id, number').eq('id', numberId).maybeSingle();
    if (nErr) return res.status(500).json({ ok: false, error: nErr.message });
    if (!num) return res.status(404).json({ ok: false, error: 'Number not found' });

    const label = String(req.body?.label ?? '').trim();
    if (!label) return res.status(400).json({ ok: false, error: 'label is required' });
    const mncs = normMncs(req.body?.mncs);
    if (!mncs.length) return res.status(400).json({ ok: false, error: 'at least one MNC is required' });
    const purchase = normPrice(req.body?.purchase_price_per_mo, 'purchase_price_per_mo');
    const selling = normPrice(req.body?.selling_price_per_mo, 'selling_price_per_mo');

    const { data: g, error } = await supabase()
      .from('number_operator_prices')
      .insert({ number_id: numberId, label, mncs, purchase_price_per_mo: purchase, selling_price_per_mo: selling, active: true, updated_by: req.user.id })
      .select('*').maybeSingle();
    if (error) return res.status(500).json({ ok: false, error: error.message });

    await logPriceChange({ numberId, side: 'purchase', newPrice: purchase, userId: req.user.id, operatorGroupId: g.id });
    await logPriceChange({ numberId, side: 'selling', newPrice: selling, userId: req.user.id, operatorGroupId: g.id });
    await auditLog({
      userId: req.user.id, action: 'number.operator_price.create', entity: 'number_operator_price', entityId: g.id,
      diff: { number: num.number, label, mncs, purchase, selling },
    });
    res.json({ ok: true, group: groupShape(g) });
  } catch (e) {
    res.status(e.code || 500).json({ ok: false, error: e.message });
  }
});

// PATCH /api/operator-pricing/:groupId
numbersRouter.patch('/api/operator-pricing/:groupId', requireAdmin, async (req, res) => {
  try {
    const id = req.params.groupId;
    const { data: existing, error: loadErr } = await supabase().from('number_operator_prices').select('*').eq('id', id).maybeSingle();
    if (loadErr) return res.status(500).json({ ok: false, error: loadErr.message });
    if (!existing) return res.status(404).json({ ok: false, error: 'Operator price group not found' });

    const patch = { updated_by: req.user.id, updated_at: new Date().toISOString() };
    if (req.body?.label !== undefined) {
      const l = String(req.body.label).trim();
      if (!l) return res.status(400).json({ ok: false, error: 'label cannot be empty' });
      patch.label = l;
    }
    if (req.body?.mncs !== undefined) {
      const m = normMncs(req.body.mncs);
      if (!m.length) return res.status(400).json({ ok: false, error: 'at least one MNC is required' });
      patch.mncs = m;
    }
    if (req.body?.purchase_price_per_mo !== undefined) patch.purchase_price_per_mo = normPrice(req.body.purchase_price_per_mo, 'purchase_price_per_mo');
    if (req.body?.selling_price_per_mo !== undefined) patch.selling_price_per_mo = normPrice(req.body.selling_price_per_mo, 'selling_price_per_mo');
    if (req.body?.active !== undefined) patch.active = req.body.active === true;
    if (Object.keys(patch).length <= 2) return res.status(400).json({ ok: false, error: 'No fields to update' });

    const { data: updated, error: updErr } = await supabase().from('number_operator_prices').update(patch).eq('id', id).select('*').maybeSingle();
    if (updErr) return res.status(500).json({ ok: false, error: updErr.message });

    if (Number(existing.purchase_price_per_mo) !== Number(updated.purchase_price_per_mo)) {
      await logPriceChange({ numberId: updated.number_id, side: 'purchase', newPrice: Number(updated.purchase_price_per_mo), userId: req.user.id, operatorGroupId: id });
    }
    if (Number(existing.selling_price_per_mo) !== Number(updated.selling_price_per_mo)) {
      await logPriceChange({ numberId: updated.number_id, side: 'selling', newPrice: Number(updated.selling_price_per_mo), userId: req.user.id, operatorGroupId: id });
    }
    await auditLog({
      userId: req.user.id, action: 'number.operator_price.update', entity: 'number_operator_price', entityId: id,
      diff: diffShallow({ ...existing, mncs: JSON.stringify(existing.mncs) }, { ...updated, mncs: JSON.stringify(updated.mncs) }),
    });
    res.json({ ok: true, group: groupShape(updated) });
  } catch (e) {
    res.status(e.code || 500).json({ ok: false, error: e.message });
  }
});

// DELETE /api/operator-pricing/:groupId — hard delete (its price history
// cascades). Volume on that MNC then falls back to the number's default rate.
numbersRouter.delete('/api/operator-pricing/:groupId', requireAdmin, async (req, res) => {
  const id = req.params.groupId;
  const { data: existing, error: loadErr } = await supabase().from('number_operator_prices').select('*').eq('id', id).maybeSingle();
  if (loadErr) return res.status(500).json({ ok: false, error: loadErr.message });
  if (!existing) return res.status(404).json({ ok: false, error: 'Operator price group not found' });

  const { error } = await supabase().from('number_operator_prices').delete().eq('id', id);
  if (error) return res.status(500).json({ ok: false, error: error.message });

  await auditLog({
    userId: req.user.id, action: 'number.operator_price.delete', entity: 'number_operator_price', entityId: id,
    diff: { label: existing.label, mncs: existing.mncs, purchase: existing.purchase_price_per_mo, selling: existing.selling_price_per_mo },
  });
  res.json({ ok: true });
});
