// Daily Slack post — SPEC §6.
//
// Reads slack_config (single row), builds yesterday + MTD totals via
// the same history matrix the dashboard uses, posts to the webhook,
// and stamps last_sent_for so the next run skips. Idempotent.
//
// Retry: up to 3 attempts with linear backoff (200ms, 600ms). Slack
// webhooks rarely fail but when they do it's worth a couple of nudges.

import { supabase } from '../supabase.js';
import { buildHistoryMatrix } from './history.js';
import { loadSplitPricing } from './operator_pricing.js';
import { auditLog } from '../util/audit.js';
import { fetchVolumesInRange } from '../util/volumes.js';
import { monthBounds } from './calc.js';

function pad2(n) { return String(n).padStart(2, '0'); }
function todayUTC() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
function yesterdayUTC(ref = new Date()) {
  const d = new Date(ref);
  d.setUTCDate(d.getUTCDate() - 1);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
function fmtInt(n)   { return (Number(n) || 0).toLocaleString('en-US'); }
function fmtMoney(n) { return `$${(Number(n) || 0).toFixed(2)}`; }

// Public for the Test button so admins can preview the message they'd
// post without actually shipping it.
export function buildDailyMessage(matrix, yesterday) {
  let yVol = 0, yRev = 0;
  for (const sect of Object.values(matrix.sections || {})) {
    const cell = sect.byDay?.[yesterday];
    if (cell) { yVol += cell.volume; yRev += cell.revenue; }
  }
  const monthStart = matrix.firstDay;
  const lines = [
    `📊 *mocount* — ${yesterday}`,
    `Volume: ${fmtInt(yVol)} MO`,
    `Revenue: ${fmtMoney(yRev)}`,
    '',
    `📅 *MTD* (${monthStart} → ${matrix.visibleLastDay || yesterday})`,
    `Volume: ${fmtInt(matrix.grandTotal.volume)} MO`,
    `Revenue: ${fmtMoney(matrix.grandTotal.revenue)}`,
  ];
  return lines.join('\n');
}

async function postToWebhook(url, text) {
  const body = JSON.stringify({ text });
  const delays = [0, 200, 600];
  let lastErr;
  for (const wait of delays) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (res.ok) return { ok: true, status: res.status };
      lastErr = new Error(`Slack returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function loadMatrixForYesterday() {
  const yest = yesterdayUTC();
  const month = yest.slice(0, 7);
  const sb = supabase();

  const { data: numbers, error: nErr } = await sb
    .from('numbers').select('id, number, type, country, client, purchase_price_per_mo, selling_price_per_mo, active');
  if (nErr) throw new Error(nErr.message);
  const { firstDay, lastDay } = monthBounds(month);
  const volumes = await fetchVolumesInRange(sb, firstDay, lastDay);
  const split = await loadSplitPricing(sb, month);

  return {
    matrix: buildHistoryMatrix({ numbers: numbers || [], volumes, month, split }),
    yesterday: yest,
  };
}

// ── Test send ─────────────────────────────────────────────
// Posts to the webhook regardless of last_sent_for, with a
// `[TEST]` prefix so it's clear in the channel.
export async function sendTestMessage(userId) {
  const sb = supabase();
  const { data: cfg, error: cErr } = await sb.from('slack_config').select('webhook_url, enabled').maybeSingle();
  if (cErr) throw new Error(cErr.message);
  if (!cfg?.webhook_url) throw new Error('No webhook URL configured');

  const { matrix, yesterday } = await loadMatrixForYesterday();
  const text = '*[TEST]* ' + buildDailyMessage(matrix, yesterday);
  const result = await postToWebhook(cfg.webhook_url, text);
  await auditLog({
    userId, action: 'slack.test', entity: 'slack_config', entityId: 'singleton',
    diff: { sent_for: yesterday, status: result.status },
  });
  return { ok: true, sent_for: yesterday, preview: text };
}

// ── Daily send ────────────────────────────────────────────
// Skips if disabled, no webhook, or last_sent_for already covers
// yesterday. Updates last_sent_for on success so future calls in the
// same day are no-ops. Returns { ok, skipped?, reason? } either way.
export async function postDaily(userId = null) {
  const sb = supabase();
  const { data: cfg, error: cErr } = await sb.from('slack_config')
    .select('webhook_url, enabled, last_sent_for').maybeSingle();
  if (cErr) throw new Error(cErr.message);
  if (!cfg) return { ok: false, skipped: true, reason: 'no slack_config row' };
  if (!cfg.enabled) return { ok: true, skipped: true, reason: 'slack disabled' };
  if (!cfg.webhook_url) return { ok: true, skipped: true, reason: 'no webhook url' };

  const yest = yesterdayUTC();
  if (cfg.last_sent_for && cfg.last_sent_for >= yest) {
    return { ok: true, skipped: true, reason: `already sent for ${cfg.last_sent_for}` };
  }

  const { matrix, yesterday } = await loadMatrixForYesterday();
  const text = buildDailyMessage(matrix, yesterday);
  const result = await postToWebhook(cfg.webhook_url, text);

  const { error: updErr } = await sb.from('slack_config')
    .update({ last_sent_for: yesterday, updated_at: new Date().toISOString() })
    .eq('webhook_url', cfg.webhook_url);
  if (updErr) {
    // Posted but couldn't stamp — log and warn so we don't double-post next run.
    console.error('[slack] post succeeded but stamp failed:', updErr.message);
  }
  await auditLog({
    userId, action: 'slack.daily_post', entity: 'slack_config', entityId: 'singleton',
    diff: { sent_for: yesterday, status: result.status },
  });
  return { ok: true, sent_for: yesterday };
}

// Today's date (UTC) — used by the scheduler for "should we send now?".
export { todayUTC };
