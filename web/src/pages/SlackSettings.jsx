// Slack settings — SPEC §4.
// Single-row config (webhook URL, enabled, send time). The Test
// button posts a [TEST]-prefixed message immediately. Send now
// triggers the daily flow with idempotency.

import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function SlackSettings() {
  const [cfg, setCfg] = useState(null);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);

  // Form state
  const [webhook, setWebhook] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [sendTime, setSendTime] = useState('06:00');
  const [dirty, setDirty] = useState(false);

  async function load() {
    setError(null); setInfo(null);
    try {
      const r = await api.get('/api/settings/slack');
      setCfg(r.config);
      setWebhook(r.config?.webhook_url || '');
      setEnabled(!!r.config?.enabled);
      setSendTime(r.config?.send_time_utc || '06:00');
      setDirty(false);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function save() {
    setBusy(true); setError(null); setInfo(null);
    try {
      const r = await api.request ? null : null;
      // PUT — using fetch directly since api helper only exposes get/post/patch/del
      const res = await fetch('/api/settings/slack', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook_url: webhook, enabled, send_time_utc: sendTime }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
      setInfo('Saved.');
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true); setError(null); setInfo(null);
    try {
      const r = await api.post('/api/settings/slack/test');
      setInfo(`Sent test for ${r.sent_for}. Preview:\n\n${r.preview}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function sendNow() {
    setBusy(true); setError(null); setInfo(null);
    try {
      const r = await api.post('/api/settings/slack/send-now');
      if (r.skipped) setInfo(`Skipped: ${r.reason}`);
      else setInfo(`Daily post sent for ${r.sent_for}.`);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <h2>Slack settings</h2>

      {error && <div className="err-box" style={{ marginBottom: 14 }}>{error}</div>}
      {info && <div className="ok-box" style={{ marginBottom: 14, whiteSpace: 'pre-wrap' }}>{info}</div>}

      {!cfg && !error && <p className="mono">loading…</p>}

      {cfg !== null && (
        <div style={{ maxWidth: 720 }}>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr', gap: 14 }}>
            <label>
              Webhook URL
              <input
                type="url" placeholder="https://hooks.slack.com/services/T.../B.../..."
                value={webhook} onChange={(e) => { setWebhook(e.target.value); setDirty(true); }}
              />
            </label>
            <label className="tick">
              <input type="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); setDirty(true); }} />
              Enabled (cron sends daily at the time below)
            </label>
            <label>
              Send time (UTC, HH:MM)
              <input type="text" placeholder="06:00" value={sendTime}
                onChange={(e) => { setSendTime(e.target.value); setDirty(true); }} maxLength={5} />
            </label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn-primary" disabled={busy || !dirty} onClick={save}>
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button className="btn-ghost" disabled={busy || !webhook} onClick={test}>Test now</button>
              <button className="btn-ghost" disabled={busy || !webhook || !enabled} onClick={sendNow}>Send daily now</button>
            </div>
          </div>

          <div className="kv" style={{ marginTop: 24, gridTemplateColumns: '1fr 1fr' }}>
            <div>
              <span className="kv-label">Last sent for</span>
              <span className="mono">{cfg.last_sent_for || '—'}</span>
            </div>
            <div>
              <span className="kv-label">Last update</span>
              <span className="mono">{cfg.updated_at?.slice(0, 19).replace('T', ' ') || '—'}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
