// Reports endpoints — SPEC §9 + §14 step 12.
//   GET /api/reports/:yyyymm        (auth)  — 4-tab JSON
//   GET /api/reports/:yyyymm/xlsx   (auth)  — single workbook, 4 sheets
//
// Both endpoints feed the same buildMonthReport output through. JSON
// is the raw structure; xlsx flattens each tab into a sheet matching
// the SPEC §5 column order.

import express from 'express';
import * as XLSX from 'xlsx';
import { requireAuth } from '../auth/middleware.js';
import { supabase } from '../supabase.js';
import { buildMonthReport } from '../services/reports.js';
import { monthBounds } from '../services/calc.js';

export const reportsRouter = express.Router();

const YYYYMM_RE = /^\d{4}-\d{2}$/;

async function loadReport(yyyymm) {
  const bounds = monthBounds(yyyymm); // throws on invalid format
  const sb = supabase();

  // Numbers: full set incl. inactive. A number deactivated mid-month
  // still belongs in the report for that month.
  const { data: numbers, error: nErr } = await sb
    .from('numbers').select('id, number, type, country, client, purchase_price_per_mo, selling_price_per_mo, active');
  if (nErr) throw new Error(nErr.message);

  const { data: volumes, error: vErr } = await sb
    .from('daily_volumes').select('number_id, date, volume')
    .gte('date', bounds.firstDay).lte('date', bounds.lastDay);
  if (vErr) throw new Error(vErr.message);

  // Fees: pull anything that *could* touch the month. Monthly fees
  // already-closed before firstDay are filtered out by the resolver;
  // setup fees outside the month are filtered by month-equality.
  const { data: fees, error: fErr } = await sb
    .from('fees').select('number_id, type, side, amount, effective_from, effective_to')
    .lte('effective_from', bounds.lastDay)
    .or(`effective_to.is.null,effective_to.gte.${bounds.firstDay}`);
  if (fErr) throw new Error(fErr.message);

  return buildMonthReport({
    numbers: numbers || [],
    volumes: volumes || [],
    fees: fees || [],
    month: yyyymm,
  });
}

// ── JSON endpoint ───────────────────────────────────────────
reportsRouter.get('/api/reports/:yyyymm', requireAuth, async (req, res) => {
  const ym = String(req.params.yyyymm || '').trim();
  if (!YYYYMM_RE.test(ym)) {
    return res.status(400).json({ ok: false, error: 'Path must be YYYY-MM' });
  }
  try {
    const r = await loadReport(ym);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── xlsx export ─────────────────────────────────────────────
// One sheet per tab. Column order matches SPEC §5. Money cells stay
// as numbers (not strings) so Excel users can sum/format themselves.
reportsRouter.get('/api/reports/:yyyymm/xlsx', requireAuth, async (req, res) => {
  const ym = String(req.params.yyyymm || '').trim();
  if (!YYYYMM_RE.test(ym)) {
    return res.status(400).json({ ok: false, error: 'Path must be YYYY-MM' });
  }
  try {
    const r = await loadReport(ym);
    const wb = XLSX.utils.book_new();

    // ── Tab 1: Summary ────────────────────────────────────
    const sumRows = [];
    sumRows.push({ Section: 'HEADLINE', Label: 'Total volume', Amount: r.summary.headline.total_volume });
    sumRows.push({ Section: 'HEADLINE', Label: 'Total revenue', Amount: r.summary.headline.total_revenue });
    sumRows.push({ Section: 'HEADLINE', Label: 'Total cost fees', Amount: r.summary.headline.total_cost_fees });
    sumRows.push({ Section: 'HEADLINE', Label: 'Net', Amount: r.summary.headline.net });
    sumRows.push({});
    sumRows.push({ Section: 'CREDIT', Label: 'Total revenue (volume × margin)', Amount: r.summary.credit.total_revenue });
    sumRows.push({});
    sumRows.push({ Section: 'DEBIT (cost-side)' });
    for (const line of r.summary.debit.lines) {
      sumRows.push({ Section: '', Label: line.label, Amount: line.amount });
    }
    sumRows.push({ Section: '', Label: 'Total cost fees', Amount: r.summary.debit.total });
    sumRows.push({});
    sumRows.push({ Section: 'NET', Label: '', Amount: r.summary.net });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sumRows, { header: ['Section', 'Label', 'Amount'] }), 'Summary');

    // ── Tab 2: Per SC/LVN ─────────────────────────────────
    const t2Rows = r.perNumber.rows.map((row) => ({
      Number: row.number,
      type: row.type,
      country: row.country,
      client: row.client,
      volume: row.volume,
      margin: row.margin,
      revenue: row.revenue,
    }));
    t2Rows.push({});
    t2Rows.push({ Number: 'TOTAL', volume: r.perNumber.totals.volume, revenue: r.perNumber.totals.revenue });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(t2Rows, {
      header: ['Number', 'type', 'country', 'client', 'volume', 'margin', 'revenue'],
    }), 'Per SC-LVN');

    // ── Tab 3: Costs ──────────────────────────────────────
    const t3Rows = r.costs.rows.map((row) => ({
      Number: row.number,
      type: row.type,
      country: row.country,
      client: row.client,
      volume: row.volume,
      'purchase price': row.purchase_price,
      'cost (vol×price)': row.cost,
      'monthly fee': row.monthly_fee,
      'setup fee': row.setup_fee,
      'total cost': row.total_cost,
    }));
    t3Rows.push({});
    t3Rows.push({
      Number: 'TOTAL',
      volume: r.costs.totals.volume,
      'cost (vol×price)': r.costs.totals.cost,
      'monthly fee': r.costs.totals.monthly_fee,
      'setup fee': r.costs.totals.setup_fee,
      'total cost': r.costs.totals.total_cost,
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(t3Rows, {
      header: ['Number', 'type', 'country', 'client', 'volume', 'purchase price', 'cost (vol×price)', 'monthly fee', 'setup fee', 'total cost'],
    }), 'Costs');

    // ── Tab 4: Client billing ─────────────────────────────
    const t4Rows = [];
    for (const g of r.clientBilling.groups) {
      t4Rows.push({ Client: g.client });
      for (const row of g.rows) {
        t4Rows.push({
          Client: '',
          Number: row.number,
          country: row.country,
          volume: row.volume,
          'selling price': row.selling_price,
          'sales (vol×selling)': row.sales,
          'monthly fee': row.monthly_fee,
          'setup fee': row.setup_fee,
          total: row.total,
        });
      }
      t4Rows.push({
        Client: 'subtotal',
        volume: g.subtotal.volume,
        'sales (vol×selling)': g.subtotal.sales,
        'monthly fee': g.subtotal.monthly_fee,
        'setup fee': g.subtotal.setup_fee,
        total: g.subtotal.total,
      });
      t4Rows.push({});
    }
    t4Rows.push({
      Client: 'GRAND TOTAL',
      volume: r.clientBilling.grandTotal.volume,
      'sales (vol×selling)': r.clientBilling.grandTotal.sales,
      'monthly fee': r.clientBilling.grandTotal.monthly_fee,
      'setup fee': r.clientBilling.grandTotal.setup_fee,
      total: r.clientBilling.grandTotal.total,
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(t4Rows, {
      header: ['Client', 'Number', 'country', 'volume', 'selling price', 'sales (vol×selling)', 'monthly fee', 'setup fee', 'total'],
    }), 'Client billing');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="mocount-report-${ym}.xlsx"`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
