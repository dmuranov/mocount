// Reports list — SPEC §4 + §14 step 17.
// Shows the last 12 months with status badges. Admin can Prepare a
// month (computes & snapshots) and Approve it (locks). The actual
// email send is step 19 — until then 'sent' is unreachable from the
// UI and stays a state the cron writes.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

const STATUS_LABEL = {
  open:     { text: 'open',     css: 'badge-open' },
  pending:  { text: 'pending',  css: 'badge-pending' },
  approved: { text: 'approved', css: 'badge-approved' },
  sent:     { text: 'sent',     css: 'badge-sent' },
};

function fmtMoney(n) { return n == null ? '—' : `$${Number(n).toFixed(2)}`; }
function fmtInt(n)   { return n == null ? '—' : Number(n).toLocaleString('en-US'); }

export default function Reports() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [months, setMonths] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // month string while a mutation is in flight

  async function load() {
    setError(null);
    try {
      const r = await api.get('/api/reports');
      setMonths(r.months);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function prepare(month) {
    setBusy(month); setError(null);
    try { await api.post(`/api/reports/${month}/prepare`); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(null); }
  }

  async function approveAndSend(month) {
    if (!confirm(`Approve ${month} and email the report to all recipients with monthly emails enabled?`)) return;
    setBusy(month); setError(null);
    try {
      await api.post(`/api/reports/${month}/approve`);
      const sendRes = await api.post(`/api/reports/${month}/send-email`);
      if (sendRes.errors?.length) {
        setError(`Approved + sent to ${sendRes.sent_to.length}; ${sendRes.errors.length} failed: ${sendRes.errors.map((e) => e.email).join(', ')}`);
      }
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(null); }
  }

  async function resend(month) {
    if (!confirm(`Re-send the ${month} report to every recipient?`)) return;
    setBusy(month); setError(null);
    try {
      const sendRes = await api.post(`/api/reports/${month}/send-email`);
      if (sendRes.errors?.length) {
        setError(`Sent to ${sendRes.sent_to.length}; ${sendRes.errors.length} failed.`);
      }
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(null); }
  }

  async function runPrep() {
    setBusy('prep'); setError(null);
    try {
      const r = await api.post('/api/reports/run-prep');
      if (r.skipped) setError(`Prep skipped: ${r.reason}`);
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(null); }
  }

  return (
    <div className="page">
      {error && <div className="err-box" style={{ marginBottom: 14 }}>{error}</div>}

      {isAdmin && (
        <div className="numbers-toolbar">
          <p className="mono" style={{ color: 'var(--dim)', margin: 0 }}>
            // monthly prep auto-runs day 1, 06:00 UTC. Use Run prep now to force a fresh snapshot of the prior month.
          </p>
          <div className="dash-actions">
            <button className="btn-ghost" disabled={busy === 'prep'} onClick={runPrep}>
              {busy === 'prep' ? 'Running…' : 'Run prep now'}
            </button>
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Month</th>
              <th>Status</th>
              <th style={{ textAlign: 'right' }}>Volume</th>
              <th style={{ textAlign: 'right' }}>Revenue</th>
              <th style={{ textAlign: 'right' }}>Cost fees</th>
              <th style={{ textAlign: 'right' }}>Net</th>
              <th>Prepared</th>
              <th>Approved</th>
              {isAdmin && <th></th>}
            </tr>
          </thead>
          <tbody>
            {months === null && (
              <tr><td colSpan={isAdmin ? 9 : 8} className="mono" style={{ color: 'var(--dim)' }}>loading…</td></tr>
            )}
            {months?.map((m) => {
              const sl = STATUS_LABEL[m.status] || { text: m.status, css: '' };
              const h = m.headline;
              return (
                <tr key={m.month}>
                  <td className="mono">
                    <Link className="link-btn" to={`/reports/${m.month}`}>{m.month}</Link>
                  </td>
                  <td><span className={'badge ' + sl.css}>{sl.text}</span></td>
                  <td style={{ textAlign: 'right' }} className="mono">{fmtInt(h?.total_volume)}</td>
                  <td style={{ textAlign: 'right' }} className="mono">{fmtMoney(h?.total_revenue)}</td>
                  <td style={{ textAlign: 'right' }} className="mono">{fmtMoney(h?.total_cost_fees)}</td>
                  <td style={{ textAlign: 'right' }} className="mono">{fmtMoney(h?.net)}</td>
                  <td className="mono" style={{ color: 'var(--dim)' }}>{m.prepared_at?.slice(0, 10) || '—'}</td>
                  <td className="mono" style={{ color: 'var(--dim)' }}>{m.approved_at?.slice(0, 10) || '—'}</td>
                  {isAdmin && (
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {m.status === 'open' && (
                        <button className="btn-ghost" disabled={busy === m.month} onClick={() => prepare(m.month)}>Prepare</button>
                      )}
                      {m.status === 'pending' && (
                        <>
                          <button className="btn-ghost" disabled={busy === m.month} onClick={() => prepare(m.month)}>Re-prepare</button>{' '}
                          <button className="btn-primary" disabled={busy === m.month} onClick={() => approveAndSend(m.month)}>Approve &amp; Send</button>
                        </>
                      )}
                      {m.status === 'approved' && (
                        <button className="btn-primary" disabled={busy === m.month} onClick={() => resend(m.month)}>Send email</button>
                      )}
                      {m.status === 'sent' && (
                        <button className="btn-ghost" disabled={busy === m.month} onClick={() => resend(m.month)}>Re-send</button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
