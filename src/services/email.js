// Resend email integration — SPEC §7.
//
// Two flows:
//   sendPrepReadyToAdmins(month)   — day-1 cron tells admins the
//                                    pending close is ready for review
//   sendMonthlyReport(month)       — admin clicks Approve & Send;
//                                    builds the report body + xlsx,
//                                    sends to every user with
//                                    receives_monthly_email = true,
//                                    flips monthly_closes.status='sent'
//
// All Resend calls go through `postResend` which retries up to 3 times
// (rate-limit / transient 5xx) with linear backoff.

import * as XLSX from 'xlsx';
import { CONFIG } from '../config.js';
import { supabase } from '../supabase.js';
import { auditLog } from '../util/audit.js';
import { buildMonthReport } from './reports.js';
import { loadSplitPricing } from './operator_pricing.js';
import { monthBounds } from './calc.js';
import { fetchVolumesInRange } from '../util/volumes.js';

const RESEND_URL = 'https://api.resend.com/emails';

function fmtMoney(n) { return `$${(Number(n) || 0).toFixed(2)}`; }
function fmtInt(n)   { return (Number(n) || 0).toLocaleString('en-US'); }

function ensureKey() {
  if (!CONFIG.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured');
  if (!CONFIG.EMAIL_FROM) throw new Error('EMAIL_FROM is not configured');
}

async function postResend(body) {
  ensureKey();
  const delays = [0, 400, 1200];
  let lastErr;
  for (const wait of delays) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const res = await fetch(RESEND_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CONFIG.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (res.ok) return await res.json();
      // 4xx (except 429) is the caller's fault — fail fast.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        const txt = await res.text();
        throw new Error(`Resend ${res.status}: ${txt.slice(0, 300)}`);
      }
      lastErr = new Error(`Resend ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// ── Monthly report email (admin-approved, to recipients) ────
async function loadReportSnapshot(yyyymm) {
  const sb = supabase();
  const { data: close, error: cErr } = await sb
    .from('monthly_closes').select('snapshot, status').eq('month', yyyymm).maybeSingle();
  if (cErr) throw new Error(cErr.message);
  if (close?.snapshot) return { snapshot: close.snapshot, status: close.status };

  // No snapshot — recompute (defensive; the admin path always has one).
  const bounds = monthBounds(yyyymm);
  const [{ data: numbers, error: nErr }, volumes, { data: fees, error: fErr }] = await Promise.all([
    sb.from('numbers').select('id, number, type, country, client, purchase_price_per_mo, selling_price_per_mo, active'),
    fetchVolumesInRange(sb, bounds.firstDay, bounds.lastDay),
    sb.from('fees').select('number_id, type, side, amount, effective_from, effective_to')
      .lte('effective_from', bounds.lastDay)
      .or(`effective_to.is.null,effective_to.gte.${bounds.firstDay}`),
  ]);
  if (nErr) throw new Error(nErr.message);
  if (fErr) throw new Error(fErr.message);
  const split = await loadSplitPricing(sb, yyyymm);
  const snapshot = buildMonthReport({ numbers: numbers || [], volumes, fees: fees || [], month: yyyymm, split });
  return { snapshot, status: close?.status || null };
}

function buildXlsxAttachment(snapshot, yyyymm) {
  const wb = XLSX.utils.book_new();
  // Tab 1 — Summary
  const sumRows = [];
  sumRows.push({ Section: 'HEADLINE', Label: 'Total volume',     Amount: snapshot.summary.headline.total_volume });
  sumRows.push({ Section: 'HEADLINE', Label: 'Total revenue',    Amount: snapshot.summary.headline.total_revenue });
  sumRows.push({ Section: 'HEADLINE', Label: 'Total cost fees',  Amount: snapshot.summary.headline.total_cost_fees });
  sumRows.push({ Section: 'HEADLINE', Label: 'Net',              Amount: snapshot.summary.headline.net });
  sumRows.push({});
  for (const line of snapshot.summary.debit.lines) {
    sumRows.push({ Section: 'DEBIT', Label: line.label, Amount: line.amount });
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sumRows, { header: ['Section', 'Label', 'Amount'] }), 'Summary');
  // Tab 2/3/4: simplified — just per-row data, no totals (the email is a snapshot)
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(snapshot.perNumber.rows), 'Per SC-LVN');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(snapshot.costs.rows), 'Costs');
  const cb = [];
  for (const g of snapshot.clientBilling.groups) {
    cb.push({ client: g.client });
    for (const r of g.rows) cb.push({ client: '', ...r });
    cb.push({ client: 'subtotal', ...g.subtotal });
    cb.push({});
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cb), 'Client billing');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return { filename: `mocount-report-${yyyymm}.xlsx`, content: buf.toString('base64') };
}

function buildReportHtml(snapshot, yyyymm) {
  const h = snapshot.summary.headline;
  const monthLabel = new Date(yyyymm + '-01T00:00:00Z').toLocaleString('en-US', { year: 'numeric', month: 'long', timeZone: 'UTC' });
  const debitRows = snapshot.summary.debit.lines.map((l) =>
    `<tr><td>${l.label}</td><td style="text-align:right">${fmtMoney(l.amount)}</td></tr>`
  ).join('');
  return `<!doctype html><html><body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #222; max-width: 720px; margin: 0 auto; padding: 24px;">
  <h2 style="color:#1a1a1a">mocount — ${monthLabel}</h2>
  <p>Monthly P&amp;L summary. Full detail in the attached xlsx.</p>

  <h3 style="border-bottom: 1px solid #ddd; padding-bottom: 6px">Headline</h3>
  <table cellpadding="6" cellspacing="0" style="border-collapse: collapse; width: 100%">
    <tr><td>Total volume</td><td style="text-align:right">${fmtInt(h.total_volume)}</td></tr>
    <tr><td>Total revenue</td><td style="text-align:right">${fmtMoney(h.total_revenue)}</td></tr>
    <tr><td>Total cost fees</td><td style="text-align:right">${fmtMoney(h.total_cost_fees)}</td></tr>
    <tr style="border-top:2px solid #444"><td><b>Net</b></td><td style="text-align:right"><b>${fmtMoney(h.net)}</b></td></tr>
  </table>

  <h3 style="border-bottom: 1px solid #ddd; padding-bottom: 6px; margin-top: 24px">Cost detail</h3>
  <table cellpadding="6" cellspacing="0" style="border-collapse: collapse; width: 100%">
    ${debitRows}
    <tr style="border-top:2px solid #444"><td><b>Total cost fees</b></td><td style="text-align:right"><b>${fmtMoney(snapshot.summary.debit.total)}</b></td></tr>
  </table>

  <p style="color:#888; font-size:12px; margin-top: 32px">
    Generated by mocount · ${new Date().toISOString().slice(0, 10)}
  </p>
</body></html>`;
}

// ── sendMonthlyReport ─────────────────────────────────────
// Sends to all users with receives_monthly_email=true. Returns
// { ok, sent_to, skipped, errors[] }. Does not throw on per-recipient
// failures — partial success is the right shape so a single bad
// address doesn't tank the whole send.
export async function sendMonthlyReport({ month, userId }) {
  ensureKey();
  const { snapshot, status } = await loadReportSnapshot(month);
  if (status !== 'approved') {
    throw new Error(`Cannot send: month ${month} status is ${status || 'open'} (must be 'approved')`);
  }

  const sb = supabase();
  const { data: recipients, error: rErr } = await sb
    .from('users').select('id, email, name')
    .eq('active', true).eq('receives_monthly_email', true);
  if (rErr) throw new Error(rErr.message);
  if (!recipients?.length) {
    return { ok: true, sent_to: [], skipped: 'no recipients with receives_monthly_email=true' };
  }

  const monthLabel = new Date(month + '-01T00:00:00Z').toLocaleString('en-US', { year: 'numeric', month: 'long', timeZone: 'UTC' });
  const subject = `mocount — ${monthLabel} Report`;
  const html = buildReportHtml(snapshot, month);
  const attachment = buildXlsxAttachment(snapshot, month);

  const sent_to = [];
  const errors = [];
  for (const r of recipients) {
    try {
      await postResend({
        from: CONFIG.EMAIL_FROM,
        to: [r.email],
        ...(CONFIG.EMAIL_REPLY_TO ? { reply_to: CONFIG.EMAIL_REPLY_TO } : {}),
        subject,
        html,
        attachments: [attachment],
      });
      sent_to.push(r.email);
    } catch (e) {
      errors.push({ email: r.email, error: e.message });
    }
  }

  if (sent_to.length) {
    const { error: upErr } = await sb.from('monthly_closes')
      .update({ status: 'sent', email_sent_at: new Date().toISOString() })
      .eq('month', month);
    if (upErr) console.error('[email] sent but stamp failed:', upErr.message);

    await auditLog({
      userId, action: 'monthly_close.sent', entity: 'monthly_close', entityId: month,
      diff: { recipients: sent_to.length, failed: errors.length },
    });
  }

  return { ok: true, sent_to, errors };
}

// ── sendPrepReadyToAdmins (cron path) ─────────────────────
// Day-1 cron pings admins after creating the pending close. No xlsx
// attachment — that's for the final send. Just a link to /reports.
export async function sendPrepReadyToAdmins(month, appUrl) {
  ensureKey();
  const sb = supabase();
  const { data: admins, error } = await sb
    .from('users').select('email').eq('role', 'admin').eq('active', true);
  if (error) throw new Error(error.message);
  if (!admins?.length) return { ok: true, sent_to: [], skipped: 'no active admins' };

  const monthLabel = new Date(month + '-01T00:00:00Z').toLocaleString('en-US', { year: 'numeric', month: 'long', timeZone: 'UTC' });
  const url = `${appUrl || ''}/reports/${month}`;
  const html = `<!doctype html><html><body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #222; max-width: 600px; margin: 0 auto; padding: 24px;">
    <h2>mocount — ${monthLabel} report ready for review</h2>
    <p>The monthly close has been auto-prepared. Review and approve at:</p>
    <p><a href="${url}" style="color:#2a8c2a">${url}</a></p>
    <p style="color:#888; font-size:12px; margin-top: 24px">Once you approve, the report goes out to everyone with monthly emails enabled.</p>
  </body></html>`;

  const sent_to = [];
  const errors = [];
  for (const a of admins) {
    try {
      await postResend({
        from: CONFIG.EMAIL_FROM,
        to: [a.email],
        subject: `mocount — ${monthLabel} report ready for review`,
        html,
      });
      sent_to.push(a.email);
    } catch (e) {
      errors.push({ email: a.email, error: e.message });
    }
  }
  return { ok: true, sent_to, errors };
}
