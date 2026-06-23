// Cron registration. Single source of truth for every scheduled
// job in the app. Started from server.js after the routes mount.
//
// We use a polling cron (every 5 minutes) so the configurable
// send_time_utc in slack_config is honored without re-scheduling.
// The daily-send service is itself idempotent (last_sent_for) so
// running it many times in a day is safe.

import cron from 'node-cron';
import { postDaily, todayUTC } from '../services/slack.js';
import { supabase } from '../supabase.js';
import { CONFIG } from '../config.js';
import { buildMonthReport } from '../services/reports.js';
import { loadSplitPricing } from '../services/operator_pricing.js';
import { monthBounds } from '../services/calc.js';
import { sendPrepReadyToAdmins } from '../services/email.js';
import { auditLog } from '../util/audit.js';
import { fetchVolumesInRange } from '../util/volumes.js';

// Keep a handle so tests / hot reload can stop us if needed.
const tasks = [];

export function startScheduler() {
  // Slack daily — every 5 minutes, check if we're past send_time_utc
  // and haven't sent for yesterday yet. The service itself enforces
  // both checks; the cron is just a wakeup.
  const t = cron.schedule('*/5 * * * *', async () => {
    try {
      const { data: cfg } = await supabase()
        .from('slack_config').select('enabled, send_time_utc, last_sent_for').maybeSingle();
      if (!cfg?.enabled) return;
      const sendTime = cfg.send_time_utc || '06:00';
      const now = new Date();
      const nowHHMM = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
      // Only post once we've crossed send_time_utc on the calendar day,
      // and only if last_sent_for hasn't already covered yesterday.
      if (nowHHMM < sendTime) return;
      const today = todayUTC();
      const yesterday = today.slice(0, 8) + String(Number(today.slice(8)) - 1).padStart(2, '0'); // best-effort string
      // Accurate yesterday compute, in case of month rollover:
      const y = new Date(now);
      y.setUTCDate(y.getUTCDate() - 1);
      const yIso = `${y.getUTCFullYear()}-${String(y.getUTCMonth() + 1).padStart(2, '0')}-${String(y.getUTCDate()).padStart(2, '0')}`;
      if (cfg.last_sent_for && cfg.last_sent_for >= yIso) return;
      const r = await postDaily(null);
      if (!r.skipped) console.log('[scheduler] slack daily posted for', r.sent_for);
    } catch (e) {
      console.error('[scheduler] slack daily failed:', e.message);
    }
  });
  tasks.push(t);

  // Monthly prep — day 1 at 06:00 UTC. Auto-creates the prior month's
  // pending close (if not already prepared/approved) and emails admins
  // with the review link.
  const monthly = cron.schedule('0 6 1 * *', async () => {
    try {
      await runMonthlyPrep();
    } catch (e) {
      console.error('[scheduler] monthly prep failed:', e.message);
    }
  });
  tasks.push(monthly);

  console.log('[scheduler] started — slack daily (every 5 min) + monthly prep (day 1, 06:00 UTC)');
}

// Exported so admins can trigger a re-run manually if the cron missed.
export async function runMonthlyPrep(now = new Date()) {
  // Prior month relative to "now". On day 1 at 06:00 UTC, "now"'s
  // month is the new month; we want the one that just closed.
  const prior = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const ym = `${prior.getUTCFullYear()}-${String(prior.getUTCMonth() + 1).padStart(2, '0')}`;
  const sb = supabase();

  const { data: existing, error: loadErr } = await sb
    .from('monthly_closes').select('status').eq('month', ym).maybeSingle();
  if (loadErr) throw new Error(loadErr.message);
  if (existing && (existing.status === 'approved' || existing.status === 'sent')) {
    console.log(`[scheduler] ${ym} already ${existing.status}, skipping prep`);
    return { skipped: true, reason: existing.status };
  }

  // Build snapshot fresh.
  const bounds = monthBounds(ym);
  const [{ data: numbers, error: nErr }, volumes, { data: fees, error: fErr }] = await Promise.all([
    sb.from('numbers').select('id, number, type, country, client, purchase_price_per_mo, selling_price_per_mo, active'),
    fetchVolumesInRange(sb, bounds.firstDay, bounds.lastDay),
    sb.from('fees').select('number_id, type, side, amount, effective_from, effective_to')
      .lte('effective_from', bounds.lastDay)
      .or(`effective_to.is.null,effective_to.gte.${bounds.firstDay}`),
  ]);
  if (nErr) throw new Error(nErr.message);
  if (fErr) throw new Error(fErr.message);
  const split = await loadSplitPricing(sb, ym);
  const snapshot = buildMonthReport({ numbers: numbers || [], volumes, fees: fees || [], month: ym, split });

  const row = { month: ym, status: 'pending', snapshot, prepared_at: new Date().toISOString() };
  const { error: upErr } = existing
    ? await sb.from('monthly_closes').update(row).eq('month', ym)
    : await sb.from('monthly_closes').insert(row);
  if (upErr) throw new Error(upErr.message);

  await auditLog({
    userId: null, action: 'monthly_close.prepare', entity: 'monthly_close', entityId: ym,
    diff: { source: 'cron', headline: snapshot.summary?.headline || null },
  });

  // Tell admins it's ready.
  let notify = null;
  try {
    notify = await sendPrepReadyToAdmins(ym, CONFIG.APP_URL);
  } catch (e) {
    console.error('[scheduler] prep email failed:', e.message);
  }
  console.log(`[scheduler] monthly prep complete for ${ym}; notified ${notify?.sent_to?.length ?? 0} admins`);
  return { ok: true, month: ym, notified: notify?.sent_to || [] };
}

export function stopScheduler() {
  for (const t of tasks) t.stop();
  tasks.length = 0;
}
