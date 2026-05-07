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

  async function approve(month) {
    if (!confirm(`Approve ${month}? Daily volumes for that month will be locked.`)) return;
    setBusy(month); setError(null);
    try { await api.post(`/api/reports/${month}/approve`); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(null); }
  }

  return (
    <div className="page">
      {error && <div className="err-box" style={{ marginBottom: 14 }}>{error}</div>}

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
                          <button className="btn-primary" disabled={busy === m.month} onClick={() => approve(m.month)}>Approve</button>
                        </>
                      )}
                      {(m.status === 'approved' || m.status === 'sent') && <span className="mono" style={{ color: 'var(--dim)' }}>locked</span>}
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
