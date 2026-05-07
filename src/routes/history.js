// History endpoint — SPEC §9.
// GET /api/history/:yyyymm?client=&country=  (auth)
//
// Loads numbers + volumes for the month and feeds them into the pure
// buildHistoryMatrix. Filters are passed through as-is (matrix does
// the case-folding). MTD truncation lives in the service.

import express from 'express';
import { requireAuth } from '../auth/middleware.js';
import { supabase } from '../supabase.js';
import { buildHistoryMatrix } from '../services/history.js';
import { monthBounds } from '../services/calc.js';

export const historyRouter = express.Router();

const YYYYMM_RE = /^\d{4}-\d{2}$/;

historyRouter.get('/api/history/:yyyymm', requireAuth, async (req, res) => {
  const ym = String(req.params.yyyymm || '').trim();
  if (!YYYYMM_RE.test(ym)) {
    return res.status(400).json({ ok: false, error: 'Path must be YYYY-MM (e.g. 2026-04)' });
  }
  let bounds;
  try { bounds = monthBounds(ym); } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }

  const sb = supabase();

  // Numbers: full set (active + inactive). The history page wants to
  // show numbers that were billed in past months even if they've since
  // been deactivated.
  const { data: numbers, error: numErr } = await sb
    .from('numbers').select('id, number, type, country, client, purchase_price_per_mo, selling_price_per_mo, active');
  if (numErr) return res.status(500).json({ ok: false, error: numErr.message });

  // Volumes scoped to month. The matrix re-clamps too — defense in depth.
  const { data: volumes, error: volErr } = await sb
    .from('daily_volumes')
    .select('number_id, date, volume')
    .gte('date', bounds.firstDay)
    .lte('date', bounds.lastDay);
  if (volErr) return res.status(500).json({ ok: false, error: volErr.message });

  const matrix = buildHistoryMatrix({
    numbers: numbers || [],
    volumes: volumes || [],
    month: ym,
    client: req.query.client ? String(req.query.client) : null,
    country: req.query.country ? String(req.query.country) : null,
  });

  res.json({ ok: true, ...matrix });
});
