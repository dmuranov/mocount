// Slack settings — SPEC §4 (settings/slack admin page).
//
//   GET  /api/settings/slack          (admin)  current config
//   PUT  /api/settings/slack          (admin)  upsert webhook + enabled
//   POST /api/settings/slack/test     (admin)  send a [TEST] message now
//   POST /api/settings/slack/send-now (admin)  trigger the daily send
//                                              (idempotent — honours
//                                              last_sent_for)

import express from 'express';
import { requireAdmin } from '../auth/middleware.js';
import { supabase } from '../supabase.js';
import { auditLog, diffShallow } from '../util/audit.js';
import { sendTestMessage, postDaily } from '../services/slack.js';

export const slackRouter = express.Router();

function shape(c) {
  if (!c) return null;
  return {
    webhook_url: c.webhook_url || '',
    enabled: c.enabled,
    send_time_utc: c.send_time_utc || '06:00',
    last_sent_for: c.last_sent_for,
    updated_at: c.updated_at,
  };
}

slackRouter.get('/api/settings/slack', requireAdmin, async (_req, res) => {
  const { data, error } = await supabase()
    .from('slack_config').select('*').maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, config: shape(data) });
});

slackRouter.put('/api/settings/slack', requireAdmin, async (req, res) => {
  try {
    const sb = supabase();
    const { data: existing, error: loadErr } = await sb.from('slack_config').select('*').maybeSingle();
    if (loadErr) return res.status(500).json({ ok: false, error: loadErr.message });

    const patch = { updated_at: new Date().toISOString() };
    if (req.body?.webhook_url !== undefined) {
      const u = String(req.body.webhook_url || '').trim();
      if (u && !/^https:\/\/hooks\.slack\.com\//.test(u)) {
        return res.status(400).json({ ok: false, error: 'webhook_url must start with https://hooks.slack.com/' });
      }
      patch.webhook_url = u || null;
    }
    if (req.body?.enabled !== undefined) patch.enabled = req.body.enabled === true;
    if (req.body?.send_time_utc !== undefined) {
      const t = String(req.body.send_time_utc || '').trim();
      if (t && !/^\d{2}:\d{2}$/.test(t)) {
        return res.status(400).json({ ok: false, error: 'send_time_utc must be HH:MM' });
      }
      patch.send_time_utc = t || '06:00';
    }

    let updated;
    if (existing) {
      const { data, error } = await sb.from('slack_config').update(patch).eq('id', existing.id).select('*').maybeSingle();
      if (error) return res.status(500).json({ ok: false, error: error.message });
      updated = data;
    } else {
      const { data, error } = await sb.from('slack_config').insert(patch).select('*').maybeSingle();
      if (error) return res.status(500).json({ ok: false, error: error.message });
      updated = data;
    }
    await auditLog({
      userId: req.user.id, action: 'slack_config.update', entity: 'slack_config', entityId: updated.id,
      diff: existing ? diffShallow(existing, updated) : { source: 'first-write', ...patch },
    });
    res.json({ ok: true, config: shape(updated) });
  } catch (e) {
    res.status(e.code || 500).json({ ok: false, error: e.message });
  }
});

slackRouter.post('/api/settings/slack/test', requireAdmin, async (req, res) => {
  try {
    const r = await sendTestMessage(req.user.id);
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

slackRouter.post('/api/settings/slack/send-now', requireAdmin, async (req, res) => {
  try {
    const r = await postDaily(req.user.id);
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
