// Pro forma invoice endpoints — JSON, print-ready HTML, and CSV.
//
// The HTML preview is styled close to the reference invoice format:
// customer block top-left, metadata top-right, line-item table with
// description sub-line, totals box, payment-info footer. It auto-fires
// window.print() on load so the user lands directly in the print
// dialog and can "Save as PDF".
//
// CSV columns mirror the reference report. Network / MCC-MNC are not
// tracked in the data model, so they default to "All Networks".

import express from 'express';
import { requireAdmin } from '../auth/middleware.js';
import { supabase } from '../supabase.js';
import { CONFIG } from '../config.js';
import { buildInvoiceLines } from '../services/invoices.js';
import { loadSplitPricing } from '../services/operator_pricing.js';
import { monthBounds } from '../services/calc.js';
import { fetchVolumesInRange } from '../util/volumes.js';

export const invoicesRouter = express.Router();

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
const MONTH_SHORT = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

function pad2(n) { return String(n).padStart(2, '0'); }

function formatPeriod(from, to) {
  const [y, m, d1] = from.split('-').map(Number);
  const [, , d2] = to.split('-').map(Number);
  const name = MONTH_NAMES[m - 1];
  if (from === to) return `${name} ${pad2(d1)}, ${y} (One day ONLY)`;
  return `${name} ${pad2(d1)}-${pad2(d2)}, ${y}`;
}

function fmtMoney(n) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtInt(n) {
  return Number(n || 0).toLocaleString('en-US');
}
function fmtRate(n) {
  return Number(n || 0).toFixed(4);
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function escapeCsv(s) {
  const v = String(s ?? '');
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

// ── pull what we need for the invoice in three queries ──────
async function loadInvoiceInputs(month) {
  const { firstDay, lastDay } = monthBounds(month);
  const [numsRes, volumes, histRes, split] = await Promise.all([
    supabase().from('numbers').select('id, number, type, country, client, selling_price_per_mo').eq('active', true),
    fetchVolumesInRange(supabase(), firstDay, lastDay),
    supabase().from('number_price_history').select('number_id, side, price, effective_from, effective_to').eq('side', 'selling'),
    loadSplitPricing(supabase(), month),
  ]);
  if (numsRes.error) throw new Error(numsRes.error.message);
  if (histRes.error) throw new Error(histRes.error.message);
  return { numbers: numsRes.data || [], volumes, priceHistory: histRes.data || [], split };
}

// ── GET /api/invoices/:yyyymm?client=... → JSON ─────────────
invoicesRouter.get('/api/invoices/:yyyymm', requireAdmin, async (req, res) => {
  try {
    const month = req.params.yyyymm;
    const client = req.query.client || '';
    const inputs = await loadInvoiceInputs(month);
    const result = buildInvoiceLines({ ...inputs, month, client });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/invoices/:yyyymm/preview.html?client=... ───────
invoicesRouter.get('/api/invoices/:yyyymm/preview.html', requireAdmin, async (req, res) => {
  try {
    const month = req.params.yyyymm;
    const client = String(req.query.client || '').trim();
    if (!client) return res.status(400).type('html').send('<p>client query param is required</p>');
    const inputs = await loadInvoiceInputs(month);
    const data = buildInvoiceLines({ ...inputs, month, client });
    res.type('html').send(renderInvoiceHtml(data, client));
  } catch (e) {
    res.status(500).type('html').send(`<p>Error: ${escapeHtml(e.message)}</p>`);
  }
});

// ── GET /api/invoices/:yyyymm/export.csv?client=... ─────────
invoicesRouter.get('/api/invoices/:yyyymm/export.csv', requireAdmin, async (req, res) => {
  try {
    const month = req.params.yyyymm;
    const client = String(req.query.client || '').trim();
    if (!client) return res.status(400).type('text/plain').send('client query param is required');
    const inputs = await loadInvoiceInputs(month);
    const data = buildInvoiceLines({ ...inputs, month, client });

    const monthShort = `${MONTH_SHORT[Number(month.slice(5, 7)) - 1]}-${month.slice(0, 4)}`;
    const fname = `${client} - ${monthShort}.csv`;

    const header = ['Country','Network','MCC/MNC','Short Code (SC)','Virtual Long Number (VLN)',
                    'TOTAL MESSAGE COUNT','Sell Price - Per Message','TOTAL COST','Customer Using Number'];
    const rows = [header.map(escapeCsv).join(',')];
    for (const ln of data.lines) {
      const isSC = ln.type === 'SC';
      rows.push([
        ln.country || '',
        'All Networks',
        'All Networks',
        isSC ? ln.number : 'n/a',
        isSC ? 'n/a' : ln.number,
        fmtInt(ln.qty),
        fmtRate(ln.rate),
        fmtMoney(ln.amount),
        client,
      ].map(escapeCsv).join(','));
    }
    // Match the reference grand-total footer row exactly.
    rows.push(['','','','','','',`GRAND TOTAL for ${monthShort}`, fmtMoney(data.grandTotal), ''].map(escapeCsv).join(','));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(rows.join('\n') + '\n');
  } catch (e) {
    res.status(500).type('text/plain').send(`Error: ${e.message}`);
  }
});

// ── HTML template (matches Clickatell INVOICE layout) ──────
// Single-document invoice (not traffic report). Customer block in a
// bordered box with customer info left + invoice meta right; line
// items stacked with bold description over gray sub-text; totals box
// bottom-right with rule lines around the bold "Total amount in USD";
// payment info in its own bordered box.
function renderInvoiceHtml(data, client) {
  const today = new Date();
  const todayStr = `${today.getUTCDate()} ${MONTH_NAMES[today.getUTCMonth()].slice(0, 3)} ${today.getUTCFullYear()}`;
  const monthLabel = `${MONTH_NAMES[Number(data.month.slice(5, 7)) - 1]} ${data.month.slice(0, 4)}`;
  const issuerAddrLines = (CONFIG.ISSUER_ADDRESS || '').split(/\\n|\n/).filter(Boolean);
  const bankAddrLines = (CONFIG.BANK_ADDRESS || '').split(/\\n|\n/).filter(Boolean);
  const issuerLine = [CONFIG.ISSUER_NAME, ...issuerAddrLines, CONFIG.ISSUER_EMAIL ? 'Email: ' + CONFIG.ISSUER_EMAIL : ''].filter(Boolean).map(escapeHtml).join(' | ');

  const lineRows = data.lines.map((ln, i) => {
    const tag = ln.type === 'SC' ? 'SC' : 'VLN';
    const desc = `SMS MO - ${tag} ${escapeHtml(ln.number)} - Qty. ${fmtInt(ln.qty)} - Rate ${fmtRate(ln.rate)}`;
    return `
      <tr>
        <td class="num">${i + 1}</td>
        <td>
          <div class="desc-main">${desc}</div>
          <div class="desc-sub">${escapeHtml(formatPeriod(ln.fromDate, ln.toDate))}</div>
        </td>
        <td class="amt">${fmtMoney(ln.amount)}</td>
      </tr>`;
  }).join('');

  // Operator breakdown — portal only (class no-print → never on the PDF), and
  // never in the CSV. Exposes purchase cost, so it must not reach the customer.
  const splitLines = data.lines.filter((ln) => ln.operatorSlices && ln.operatorSlices.length);
  const breakdownHtml = splitLines.length ? `
<details class="no-print op-breakdown">
  <summary>View operator breakdown — internal, not shown to the customer (${splitLines.length} number${splitLines.length > 1 ? 's' : ''})</summary>
  <div class="op-note">Each split SC bills as one blended line above; per-operator detail below sums to that exact amount.</div>
  ${splitLines.map((ln) => `
  <div class="op-block">
    <div class="op-title">${escapeHtml(ln.number)} — Qty. ${fmtInt(ln.qty)} · blended rate ${fmtRate(ln.rate)} · ${fmtMoney(ln.amount)}</div>
    <table class="op-table">
      <thead><tr><th>MCC-MNC</th><th>Group</th><th class="r">Qty</th><th class="r">Purchase</th><th class="r">Selling</th><th class="r">Revenue</th></tr></thead>
      <tbody>${ln.operatorSlices.map((s) => `<tr><td>${escapeHtml(s.mcc_mnc)}</td><td>${escapeHtml(s.label)}</td><td class="r">${fmtInt(s.qty)}</td><td class="r">${fmtRate(s.purchase)}</td><td class="r">${fmtRate(s.selling)}</td><td class="r">${fmtMoney(s.revenue)}</td></tr>`).join('')}</tbody>
    </table>
  </div>`).join('')}
</details>` : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>ProForma - ${escapeHtml(client)} - ${monthLabel}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  html, body { background: #fff; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; font-size: 11px; line-height: 1.45; margin: 0; padding: 22px 28px; max-width: 820px; margin-left: auto; margin-right: auto; }
  .top-issuer { text-align: right; font-size: 9.5px; color: #444; margin-bottom: 14px; }
  h1.title { font-size: 28px; font-weight: 700; margin: 6px 0 18px; letter-spacing: 0.3px; }
  .box { border: 1px solid #c4c4c4; padding: 14px 16px; margin-bottom: 16px; }
  .cust-row { display: flex; gap: 24px; }
  .cust-row .left { flex: 1; }
  .cust-row .left .label { font-size: 14px; font-weight: 700; margin-bottom: 6px; }
  .cust-row .left .name { font-weight: 500; margin-bottom: 2px; }
  .cust-row .right { width: 230px; padding-top: 4px; }
  .meta-grid { display: grid; grid-template-columns: 110px 1fr; row-gap: 4px; column-gap: 8px; font-size: 11px; }
  .meta-grid .k { color: #555; }
  .meta-grid .v { text-align: right; font-weight: 500; }
  table.items { width: 100%; border-collapse: collapse; margin-bottom: 18px; }
  table.items thead th { text-align: left; font-size: 11px; font-weight: 700; padding: 9px 6px; border-top: 1px solid #888; border-bottom: 1px solid #888; }
  table.items thead th.amt-h { text-align: right; }
  table.items td { padding: 11px 6px; border-bottom: 1px solid #ececec; vertical-align: top; }
  table.items td.num { width: 28px; color: #555; text-align: left; }
  table.items td.amt { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  table.items .desc-main { font-weight: 500; }
  table.items .desc-sub { color: #666; font-size: 10.5px; margin-top: 3px; }
  .totals-wrap { display: flex; justify-content: flex-end; margin-bottom: 18px; }
  .totals { width: 380px; }
  .totals .row { display: flex; justify-content: space-between; padding: 5px 4px; font-size: 11px; }
  .totals .row .lbl { color: #444; }
  .totals .row .val { font-variant-numeric: tabular-nums; }
  .totals .grand {
    padding: 10px 4px; margin-top: 4px;
    border-top: 1px solid #1a1a1a; border-bottom: 1px solid #1a1a1a;
    font-weight: 700; font-size: 14px;
  }
  .op-breakdown { margin: -6px 0 20px; font-size: 10.5px; }
  .op-breakdown summary { cursor: pointer; color: #555; padding: 6px 0; user-select: none; }
  .op-breakdown .op-block { margin: 8px 0 14px; }
  .op-breakdown .op-title { font-weight: 600; margin-bottom: 4px; }
  .op-breakdown table.op-table { width: 100%; border-collapse: collapse; }
  .op-breakdown .op-table th, .op-breakdown .op-table td { padding: 4px 6px; border-bottom: 1px solid #eee; text-align: left; }
  .op-breakdown .op-table th.r, .op-breakdown .op-table td.r { text-align: right; font-variant-numeric: tabular-nums; }
  .op-breakdown .op-note { color: #999; font-style: italic; margin-bottom: 6px; }
  .pay h2 { font-size: 14px; font-weight: 700; margin: 0 0 12px; }
  .pay-grid { display: grid; grid-template-columns: 130px 1fr 130px 1fr; row-gap: 5px; column-gap: 14px; font-size: 11px; }
  .pay-grid .k { color: #444; }
  .footer-note { font-size: 10px; color: #555; margin-top: 14px; line-height: 1.5; text-align: left; }
  .footer-note .italic { font-style: italic; color: #777; }
  @media print {
    body { padding: 0; }
    .no-print { display: none; }
  }
</style>
</head><body>

<div class="no-print" style="margin-bottom: 14px; padding: 8px 12px; background: #f5f5f5; border-radius: 4px; font-size: 11px; color: #555;">
  Print dialog should open automatically — choose "Save as PDF". Suggested filename: <b>ProForma - ${escapeHtml(client)} - ${monthLabel}.pdf</b>
</div>

<div class="top-issuer">${issuerLine}</div>

<h1 class="title">PRO FORMA INVOICE</h1>

<div class="box">
  <div class="cust-row">
    <div class="left">
      <div class="label">Customer</div>
      <div class="name">${escapeHtml(client)}</div>
    </div>
    <div class="right">
      <div class="meta-grid">
        <span class="k">Issue date:</span><span class="v">${escapeHtml(todayStr)}</span>
        <span class="k">Billing period:</span><span class="v">${escapeHtml(monthLabel)}</span>
      </div>
    </div>
  </div>
</div>

<table class="items">
  <thead><tr><th>#</th><th>Description</th><th class="amt-h">Amount in USD</th></tr></thead>
  <tbody>${lineRows || '<tr><td colspan="3" style="color:#999;text-align:center;padding:24px">No volume for this client in this month.</td></tr>'}</tbody>
</table>

<div class="totals-wrap">
  <div class="totals">
    <div class="row"><span class="lbl">Total amount excl. VAT:</span><span class="val">${fmtMoney(data.grandTotal)}</span></div>
    <div class="row"><span class="lbl">VAT amount (0.00%):</span><span class="val">0.00</span></div>
    <div class="row grand"><span>Total amount in USD</span><span class="val">${fmtMoney(data.grandTotal)}</span></div>
  </div>
</div>
${breakdownHtml}

<div class="box pay">
  <h2>Payment information</h2>
  <div class="pay-grid">
    <span class="k">Bank name:</span><span>${escapeHtml(CONFIG.BANK_NAME || '')}</span>
    <span class="k">Billing period:</span><span>${escapeHtml(monthLabel)}</span>
    <span class="k">Bank address:</span><span>${bankAddrLines.map(escapeHtml).join(', ')}</span>
    <span class="k">Payment reference:</span><span>${escapeHtml(client)} ${escapeHtml(monthLabel)}</span>
    <span class="k">Bank account holder:</span><span>${escapeHtml(CONFIG.BANK_ACCOUNT_HOLDER || '')}</span>
    <span class="k"></span><span></span>
    <span class="k">IBAN:</span><span>${escapeHtml(CONFIG.BANK_IBAN || '')}</span>
    <span class="k"></span><span></span>
    <span class="k">SWIFT/BIC:</span><span>${escapeHtml(CONFIG.BANK_SWIFT || '')}</span>
  </div>
</div>

<div class="footer-note">
  Please make sure the total amount is transferred to our bank account before the due date to prevent extra fees.<br>
  Please note: VAT-service subject to reverse charge procedure.
  <span class="italic">— Pro forma document, not a fiscal invoice.</span>
</div>

<script>window.addEventListener('load', () => setTimeout(() => window.print(), 200));</script>
</body></html>`;
}
