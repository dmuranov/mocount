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
  console.log('[scheduler] started — slack daily polling every 5 min');
}

export function stopScheduler() {
  for (const t of tasks) t.stop();
  tasks.length = 0;
}
