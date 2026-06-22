// Invoices page (admin only).
//
// Pick month + client → preview line items + grand total in the page →
// click Generate to (a) open the print-ready HTML in a new tab so the
// browser print dialog appears for "Save as PDF", and (b) download the
// matching CSV report. Both files reflect the current filter state.
//
// Mid-month price changes show as multiple lines per number, matching
// the Google reference invoice format.

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

function lastCompletedMonth() {
  const d = new Date();
  // If we're past the 1st, the previous calendar month is the most
  // recent "complete" month for invoicing.
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
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
function monthLabel(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

export default function Invoices() {
  const [month, setMonth] = useState(lastCompletedMonth());
  const [client, setClient] = useState('');
  const [clients, setClients] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Populate the client dropdown from distinct numbers.client values.
  useEffect(() => {
    api.get('/api/numbers').then(({ numbers }) => {
      const set = new Set();
      for (const n of numbers || []) if (n.client) set.add(String(n.client).trim());
      setClients([...set].sort());
    }).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!client) { setData(null); return; }
    setLoading(true);
    setError(null);
    api.get(`/api/invoices/${month}?client=${encodeURIComponent(client)}`)
      .then((r) => setData(r))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [month, client]);

  const q = `client=${encodeURIComponent(client)}`;
  const csvUrl = client ? `/api/invoices/${month}/export.csv?${q}` : '#';
  const htmlUrl = client ? `/api/invoices/${month}/preview.html?${q}` : '#';
  const canGen = client && data && data.lines.length > 0;

  const summary = useMemo(() => {
    if (!data) return null;
    return { count: data.lines.length, total: data.grandTotal };
  }, [data]);

  return (
    <div className="page">
      <div className="numbers-toolbar">
        <div className="filter-row">
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
          <select value={client} onChange={(e) => setClient(e.target.value)}>
            <option value="">— pick a client —</option>
            {clients.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="dash-actions" style={{ display: 'flex', gap: 8 }}>
          <a
            className="btn-primary"
            href={htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ opacity: canGen ? 1 : 0.4, pointerEvents: canGen ? 'auto' : 'none' }}
            onClick={(e) => { if (!canGen) e.preventDefault(); }}
          >
            Open pro forma invoice
          </a>
          <a
            className="btn-ghost"
            href={csvUrl}
            style={{ opacity: canGen ? 1 : 0.4, pointerEvents: canGen ? 'auto' : 'none' }}
            onClick={(e) => { if (!canGen) e.preventDefault(); }}
          >
            Download CSV report
          </a>
        </div>
      </div>

      {error && <div className="err-box" style={{ marginBottom: 14 }}>{error}</div>}

      {!client && (
        <p className="mono" style={{ color: 'var(--dim)' }}>
          // pick a client to preview the pro forma invoice for {monthLabel(month)}
        </p>
      )}

      {client && loading && <p className="mono">loading…</p>}

      {client && data && summary && (
        <>
          <p className="mono" style={{ color: 'var(--dim)', marginTop: 0 }}>
            // {client} — {monthLabel(month)} · {summary.count} line{summary.count === 1 ? '' : 's'} · total <b>${fmtMoney(summary.total)}</b>
          </p>
          {data.lines.length === 0 ? (
            <p className="mono" style={{ color: 'var(--dim)' }}>No volume found for this client in this month.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th style={{ width: 40 }}>#</th>
                    <th>Description</th>
                    <th>Period</th>
                    <th style={{ textAlign: 'right' }}>Qty</th>
                    <th style={{ textAlign: 'right' }}>Rate</th>
                    <th style={{ textAlign: 'right' }}>Amount (USD)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((ln, i) => (
                    <tr key={`${ln.number_id}-${ln.fromDate}`}>
                      <td className="mono" style={{ color: 'var(--dim)' }}>{i + 1}</td>
                      <td className="mono">SMS MO - {ln.type === 'SC' ? 'SC' : 'VLN'} {ln.number}</td>
                      <td className="mono" style={{ color: 'var(--dim)' }}>{ln.fromDate} → {ln.toDate}</td>
                      <td style={{ textAlign: 'right' }} className="mono">{fmtInt(ln.qty)}</td>
                      <td style={{ textAlign: 'right' }} className="mono">{fmtRate(ln.rate)}</td>
                      <td style={{ textAlign: 'right' }} className="mono">{fmtMoney(ln.amount)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={5} style={{ textAlign: 'right', fontWeight: 600 }}>Total amount in USD</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }} className="mono">{fmtMoney(data.grandTotal)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
