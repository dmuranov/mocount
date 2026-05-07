// Reports endpoints — SPEC §9 + §14 steps 12 + 17.
//   GET  /api/reports                       (auth)  — list recent months
//   GET  /api/reports/:yyyymm               (auth)  — 4-tab JSON
//   GET  /api/reports/:yyyymm/xlsx          (auth)  — single workbook
//   POST /api/reports/:yyyymm/prepare       (admin) — create 'pending' close
//   POST /api/reports/:yyyymm/approve       (admin) — flip 'pending' -> 'approved'
//
// The 'sent' transition + the Resend email lands in step 19 with the
// monthly cron. Step 17 only flips 'approved'; everything beyond
// that stays a no-op until then.

import express from 'express';
import * as XLSX from 'xlsx';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { supabase } from '../supabase.js';
import { auditLog } from '../util/audit.js';
import { buildMonthReport } from '../services/reports.js';
import { sendMonthlyReport } from '../services/email.js';
import { runMonthlyPrep } from '../jobs/scheduler.js';
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

// Build a YYYY-MM N months ago in UTC. Used to seed the recent-months
// list shown on /reports.
function ymOffset(monthsAgo, ref = new Date()) {
  const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - monthsAgo, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ── List recent months ──────────────────────────────────────
// Returns the last 12 months merged with whatever monthly_closes
// rows exist. Months without a close row come back as status='open'
// with no snapshot — the UI shows them as "open" (not yet prepared).
reportsRouter.get('/api/reports', requireAuth, async (_req, res) => {
  const months = [];
  for (let i = 0; i < 12; i++) months.push(ymOffset(i));

  const { data: closes, error } = await supabase()
    .from('monthly_closes')
    .select('month, status, prepared_at, approved_at, approved_by, email_sent_at, snapshot')
    .order('month', { ascending: false })
    .limit(36);
  if (error) return res.status(500).json({ ok: false, error: error.message });

  const byMonth = new Map();
  for (const c of closes || []) byMonth.set(c.month, c);
  // Make sure any close older than 12 months still surfaces.
  for (const c of closes || []) if (!months.includes(c.month)) months.push(c.month);

  const list = months.sort((a, b) => b.localeCompare(a)).map((m) => {
    const c = byMonth.get(m);
    if (c) {
      const headline = c.snapshot?.summary?.headline || null;
      return {
        month: m,
        status: c.status,
        prepared_at: c.prepared_at,
        approved_at: c.approved_at,
        approved_by: c.approved_by,
        email_sent_at: c.email_sent_at,
        headline,
      };
    }
    return { month: m, status: 'open', prepared_at: null, approved_at: null, approved_by: null, email_sent_at: null, headline: null };
  });
  res.json({ ok: true, months: list });
});

// ── Prepare a month ─────────────────────────────────────────
// Idempotent: re-running on a 'pending' month overwrites the
// snapshot with a freshly computed one. Refuses if status is
// already 'approved' or 'sent' (use a re-prep workflow once we
// have one — for now the SPEC's expected path is cron-only).
reportsRouter.post('/api/reports/:yyyymm/prepare', requireAdmin, async (req, res) => {
  const ym = String(req.params.yyyymm || '').trim();
  if (!YYYYMM_RE.test(ym)) return res.status(400).json({ ok: false, error: 'Path must be YYYY-MM' });
  try {
    const sb = supabase();
    const { data: existing, error: loadErr } = await sb
      .from('monthly_closes').select('status').eq('month', ym).maybeSingle();
    if (loadErr) return res.status(500).json({ ok: false, error: loadErr.message });
    if (existing && (existing.status === 'approved' || existing.status === 'sent')) {
      return res.status(409).json({ ok: false, error: `Month ${ym} is already ${existing.status}` });
    }

    const snapshot = await loadReport(ym);
    const row = {
      month: ym,
      status: 'pending',
      snapshot,
      prepared_at: new Date().toISOString(),
    };
    const { error: upErr } = existing
      ? await sb.from('monthly_closes').update(row).eq('month', ym)
      : await sb.from('monthly_closes').insert(row);
    if (upErr) return res.status(500).json({ ok: false, error: upErr.message });

    await auditLog({
      userId: req.user.id,
      action: 'monthly_close.prepare',
      entity: 'monthly_close',
      entityId: ym,
      diff: { headline: snapshot.summary?.headline || null, source: existing ? 're-prepare' : 'first-prepare' },
    });
    res.json({ ok: true, month: ym, status: 'pending' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Approve a month ─────────────────────────────────────────
// 'pending' -> 'approved'. The actual email send (status='sent') is
// step 19 — this endpoint just locks the snapshot and unblocks the
// admin from going further (the daily_volumes_lock_approved_month
// trigger refuses writes for approved months).
reportsRouter.post('/api/reports/:yyyymm/approve', requireAdmin, async (req, res) => {
  const ym = String(req.params.yyyymm || '').trim();
  if (!YYYYMM_RE.test(ym)) return res.status(400).json({ ok: false, error: 'Path must be YYYY-MM' });
  const sb = supabase();
  const { data: existing, error: loadErr } = await sb
    .from('monthly_closes').select('status').eq('month', ym).maybeSingle();
  if (loadErr) return res.status(500).json({ ok: false, error: loadErr.message });
  if (!existing) return res.status(404).json({ ok: false, error: `Month ${ym} has no prepared close — run Prepare first` });
  if (existing.status === 'approved' || existing.status === 'sent') {
    return res.status(409).json({ ok: false, error: `Month ${ym} is already ${existing.status}` });
  }
  const { error: updErr } = await sb
    .from('monthly_closes')
    .update({ status: 'approved', approved_at: new Date().toISOString(), approved_by: req.user.id })
    .eq('month', ym);
  if (updErr) return res.status(500).json({ ok: false, error: updErr.message });

  await auditLog({
    userId: req.user.id,
    action: 'monthly_close.approve',
    entity: 'monthly_close',
    entityId: ym,
    diff: { status: ['pending', 'approved'] },
  });
  res.json({ ok: true, month: ym, status: 'approved' });
});

// ── Manual trigger of the monthly prep cron ─────────────────
// Useful when cron missed the window, or for forcing a fresh
// snapshot of the prior month before approval. Runs the same logic
// scheduler.js does on day 1 at 06:00 UTC.
reportsRouter.post('/api/reports/run-prep', requireAdmin, async (_req, res) => {
  try {
    const r = await runMonthlyPrep();
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Send the approved month via Resend ──────────────────────
// Recipients: every active user with receives_monthly_email=true.
// Partial-failure tolerant: returns per-recipient errors but only
// flips status -> 'sent' if at least one recipient succeeded.
reportsRouter.post('/api/reports/:yyyymm/send-email', requireAdmin, async (req, res) => {
  const ym = String(req.params.yyyymm || '').trim();
  if (!YYYYMM_RE.test(ym)) return res.status(400).json({ ok: false, error: 'Path must be YYYY-MM' });
  try {
    const r = await sendMonthlyReport({ month: ym, userId: req.user.id });
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

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
