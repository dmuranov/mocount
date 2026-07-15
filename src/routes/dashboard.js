// Dashboard cards endpoint — SPEC §4.
// GET /api/dashboard/cards?date=YYYY-MM-DD  (auth)
//
// Returns the picked-date day totals + MTD-through-picked-date for the
// four dashboard cards. Computed server-side (not in the browser) so split
// SCs are priced through operator pricing — the same loadSplitPricing path
// History/reports/invoices use — instead of the flat snapshot margin.

import express from 'express';
import { requireAuth } from '../auth/middleware.js';
import { supabase } from '../supabase.js';
import { buildDashboardCards, monthBounds } from '../services/calc.js';
import { loadSplitPricing } from '../services/operator_pricing.js';
import { fetchVolumesInRange } from '../util/volumes.js';

export const dashboardRouter = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

dashboardRouter.get('/api/dashboard/cards', requireAuth, async (req, res) => {
  try {
    const date = String(req.query.date || '').trim();
    if (!DATE_RE.test(date)) {
      const e = new Error('Query ?date must be YYYY-MM-DD');
      e.status = 400; throw e;
    }
    const month = date.slice(0, 7);
    const { firstDay } = monthBounds(month);
    const sb = supabase();

    const { data: numbers, error: numErr } = await sb
      .from('numbers')
      .select('id, client, purchase_price_per_mo, selling_price_per_mo, active')
      .eq('active', true);
    if (numErr) throw new Error(numErr.message);

    // Volumes month-start → picked date; split pricing for the month.
    const volumes = await fetchVolumesInRange(sb, firstDay, date);
    const split = await loadSplitPricing(sb, month);

    const cards = buildDashboardCards({ numbers: numbers || [], volumes, date, split });
    res.json({ ok: true, ...cards });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});
