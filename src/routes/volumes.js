// Volumes CRUD — SPEC §9 + §14 step 8.
//
// daily_volumes is the input table for the dashboard's main numeric:
// (number_id, date, volume). The DB trigger
// `daily_volumes_lock_approved_month` refuses any write inside an
// approved/sent month — that's the no-bypass guarantee. We *also*
// pre-check here so the API returns a 409 with a clean message
// instead of the raw Postgres exception.
//
// Bulk POST is the dashboard's save flow: one row per active number
// for the picked date. We upsert on (number_id, date) per SPEC §2.
// Audit captures only what changed (before/after volume per row) so
// the audit page doesn't get spammed with no-op saves.

import express from 'express';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { supabase } from '../supabase.js';
import { auditLog } from '../util/audit.js';

export const volumesRouter = express.Router();

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normDate(v, label) {
  const s = String(v ?? '').trim();
  if (!s) throw Object.assign(new Error(`${label} is required`), { code: 400 });
  if (!ISO_DATE_RE.test(s)) {
    throw Object.assign(new Error(`${label} must be YYYY-MM-DD`), { code: 400 });
  }
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) {
    throw Object.assign(new Error(`${label} is not a valid date`), { code: 400 });
  }
  return s;
}

function normVolume(v) {
  if (v === null || v === undefined || v === '') {
    throw Object.assign(new Error('volume is required'), { code: 400 });
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw Object.assign(new Error('volume must be a non-negative integer'), { code: 400 });
  }
  return n;
}

function monthKey(yyyyMmDd) {
  return yyyyMmDd.slice(0, 7); // 'YYYY-MM'
}

// Pre-check: which of these months are closed (approved or sent)?
// Returns a Set of locked 'YYYY-MM' strings. If none, the upsert is
// safe to attempt; if any, we return the affected dates as errors and
// let the rest through (per SPEC §8: "rejected rows returned as errors").
async function loadClosedMonths(months) {
  if (!months.length) return new Set();
  const { data, error } = await supabase()
    .from('monthly_closes')
    .select('month, status')
    .in('month', months)
    .in('status', ['approved', 'sent']);
  if (error) throw new Error('Failed to check closed months: ' + error.message);
  return new Set((data || []).map((r) => r.month));
}

function shape(v) {
  if (!v) return null;
  return {
    id: v.id,
    number_id: v.number_id,
    date: v.date,
    volume: Number(v.volume),
    entered_by: v.entered_by,
    entered_at: v.entered_at,
  };
}

// ── GET /api/volumes?from=&to=&number_id= ───────────────────
// All filters optional. `from`/`to` are inclusive. No filters returns
// everything — fine for a small admin set, but we cap at 5k rows so a
// pathological client doesn't hang the server.
volumesRouter.get('/api/volumes', requireAuth, async (req, res) => {
  try {
    let q = supabase().from('daily_volumes').select('*').order('date', { ascending: false }).limit(5000);
    if (req.query.from) q = q.gte('date', normDate(req.query.from, 'from'));
    if (req.query.to) q = q.lte('date', normDate(req.query.to, 'to'));
    if (req.query.number_id) q = q.eq('number_id', String(req.query.number_id));
    const { data, error } = await q;
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, volumes: (data || []).map(shape) });
  } catch (e) {
    res.status(e.code || 500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/volumes ───────────────────────────────────────
// Body: array of { number_id, date, volume }. Bulk upsert on
// (number_id, date). Closed-month rows are filtered out and returned
// as errors; the rest commit.
volumesRouter.post('/api/volumes', requireAdmin, async (req, res) => {
  try {
    const input = Array.isArray(req.body) ? req.body : req.body?.rows;
    if (!Array.isArray(input) || input.length === 0) {
      return res.status(400).json({ ok: false, error: 'Body must be a non-empty array of { number_id, date, volume }' });
    }
    if (input.length > 1000) {
      return res.status(400).json({ ok: false, error: 'Max 1000 rows per request' });
    }

    const cleaned = [];
    const errors = [];
    for (let i = 0; i < input.length; i++) {
      const r = input[i];
      try {
        if (!r || typeof r !== 'object') throw new Error('row must be an object');
        const number_id = String(r.number_id || '').trim();
        if (!number_id) throw new Error('number_id is required');
        const date = normDate(r.date, 'date');
        const volume = normVolume(r.volume);
        cleaned.push({ idx: i, number_id, date, volume });
      } catch (e) {
        errors.push({ idx: i, error: e.message });
      }
    }
    if (cleaned.length === 0) {
      return res.status(400).json({ ok: false, error: 'No valid rows', errors });
    }

    // Closed-month pre-filter. The DB trigger is still the source of
    // truth — if a month gets approved between our check and the
    // upsert, the trigger will reject and we surface the raw error.
    const months = [...new Set(cleaned.map((r) => monthKey(r.date)))];
    const closed = await loadClosedMonths(months);
    const writable = [];
    for (const r of cleaned) {
      if (closed.has(monthKey(r.date))) {
        errors.push({ idx: r.idx, error: `Month ${monthKey(r.date)} is closed; volume edits refused` });
      } else {
        writable.push(r);
      }
    }
    if (writable.length === 0) {
      return res.status(409).json({ ok: false, error: 'All rows fall in closed months', errors });
    }

    // Snapshot prior values so audit captures real before/after diffs
    // instead of just "we upserted N rows".
    const numberIds = [...new Set(writable.map((r) => r.number_id))];
    const dates = [...new Set(writable.map((r) => r.date))];
    const { data: prior, error: priorErr } = await supabase()
      .from('daily_volumes')
      .select('number_id, date, volume')
      .in('number_id', numberIds)
      .in('date', dates);
    if (priorErr) return res.status(500).json({ ok: false, error: priorErr.message });
    const priorMap = new Map((prior || []).map((p) => [`${p.number_id}|${p.date}`, Number(p.volume)]));

    const upserts = writable.map((r) => ({
      number_id: r.number_id,
      date: r.date,
      volume: r.volume,
      entered_by: req.user.id,
      entered_at: new Date().toISOString(),
    }));

    const { data: saved, error: upErr } = await supabase()
      .from('daily_volumes')
      .upsert(upserts, { onConflict: 'number_id,date' })
      .select('*');
    if (upErr) {
      // Postgres trigger error path (race against an approval).
      if (/closed/i.test(upErr.message)) {
        return res.status(409).json({ ok: false, error: upErr.message, errors });
      }
      return res.status(500).json({ ok: false, error: upErr.message, errors });
    }

    let changed = 0, unchanged = 0;
    for (const w of writable) {
      const prev = priorMap.get(`${w.number_id}|${w.date}`);
      if (prev === w.volume) {
        unchanged++;
        continue;
      }
      changed++;
      await auditLog({
        userId: req.user.id,
        action: 'volume.upsert',
        entity: 'daily_volume',
        entityId: `${w.number_id}|${w.date}`,
        diff: { number_id: w.number_id, date: w.date, volume: [prev ?? null, w.volume] },
      });
    }

    res.json({
      ok: true,
      saved: (saved || []).map(shape),
      written: writable.length,
      changed,
      unchanged,
      errors,
    });
  } catch (e) {
    res.status(e.code || 500).json({ ok: false, error: e.message });
  }
});
