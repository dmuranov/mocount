// History page — SPEC §4 + §14 step 16.
//
// Renders the buildHistoryMatrix output from /api/history/:yyyymm.
// View state (month, metric, client, country, collapsed sections)
// is mirrored to the URL so a teammate can paste a link and see the
// exact same view.
//
// Columns are days of the month; current month truncates to
// yesterday (the matrix service handles this). Numbers with zero
// activity in the visible range still render as a row of '—' cells
// so admins can spot missed traffic.

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';

function thisMonthYM() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const METRICS = [
  { value: 'volume',  label: 'Volume' },
  { value: 'revenue', label: 'Revenue' },
  { value: 'both',    label: 'Both' },
];

function fmtInt(n) { return (Number(n) || 0).toLocaleString('en-US'); }
function fmtMoney(n) { return `$${(Number(n) || 0).toFixed(2)}`; }

// Compact: 1234 → '1.23k', 1_234_567 → '1.23M'. Used in 'Both' view
// where each cell stacks two numbers — full formatting is too wide.
function compactNum(n, fractionDigits = 2) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(fractionDigits).replace(/\.?0+$/, '') + 'B';
  if (abs >= 1e6) return (v / 1e6).toFixed(fractionDigits).replace(/\.?0+$/, '') + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(fractionDigits).replace(/\.?0+$/, '') + 'k';
  return Math.round(v).toString();
}
function compactMoney(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1000) return '$' + compactNum(v);
  return '$' + v.toFixed(2);
}

function fmtCell(cell, metric) {
  if (!cell || (!cell.volume && !cell.revenue)) return '—';
  if (metric === 'volume')  return fmtInt(cell.volume);
  if (metric === 'revenue') return fmtMoney(cell.revenue);
  return (
    <>
      <div>{compactNum(cell.volume)}</div>
      <div className="mono" style={{ color: 'var(--dim)', fontSize: 11 }}>{compactMoney(cell.revenue)}</div>
    </>
  );
}

export default function History() {
  const [params, setParams] = useSearchParams();

  const month = params.get('month') || thisMonthYM();
  const metric = params.get('metric') || 'volume';
  const clientFilter = params.get('client') || '';
  const countryFilter = params.get('country') || '';
  const scCollapsed  = params.get('sc')  === '0';
  const lvnCollapsed = params.get('lvn') === '0';

  const [matrix, setMatrix] = useState(null);
  const [error, setError] = useState(null);

  async function load() {
    setError(null);
    setMatrix(null);
    try {
      const q = new URLSearchParams();
      if (clientFilter) q.set('client', clientFilter);
      if (countryFilter) q.set('country', countryFilter);
      const url = `/api/history/${month}${q.toString() ? '?' + q.toString() : ''}`;
      const r = await api.get(url);
      setMatrix(r);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => { load(); }, [month, clientFilter, countryFilter]);

  function update(patch) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === '' || v == null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  }

  const exportHref = useMemo(() => {
    const q = new URLSearchParams();
    if (clientFilter) q.set('client', clientFilter);
    if (countryFilter) q.set('country', countryFilter);
    return `/api/history/${month}/xlsx${q.toString() ? '?' + q.toString() : ''}`;
  }, [month, clientFilter, countryFilter]);

  // Pull filter dropdown options out of the matrix (no extra round trip).
  const clientOpts = useMemo(() => {
    if (!matrix) return [];
    const all = [];
    for (const sect of Object.values(matrix.sections)) {
      for (const row of sect.rows) if (row.client) all.push(row.client);
    }
    return [...new Set(all)].sort();
  }, [matrix]);
  const countryOpts = useMemo(() => {
    if (!matrix) return [];
    const all = [];
    for (const sect of Object.values(matrix.sections)) {
      for (const row of sect.rows) if (row.country) all.push(row.country);
    }
    return [...new Set(all)].sort();
  }, [matrix]);

  return (
    <div className="page">
      <div className="numbers-toolbar">
        <div className="filter-row">
          <input
            type="month"
            value={month}
            onChange={(e) => update({ month: e.target.value })}
          />
          <select value={metric} onChange={(e) => update({ metric: e.target.value })}>
            {METRICS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <select value={clientFilter} onChange={(e) => update({ client: e.target.value })}>
            <option value="">All clients</option>
            {clientOpts.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={countryFilter} onChange={(e) => update({ country: e.target.value })}>
            <option value="">All countries</option>
            {countryOpts.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="dash-actions">
          <a className="btn-ghost" href={exportHref}>Export (.xlsx)</a>
        </div>
      </div>

      {error && <div className="err-box" style={{ marginBottom: 14 }}>{error}</div>}
      {!matrix && !error && <p className="mono">loading…</p>}

      {matrix && (
        <>
          {matrix.isCurrent && (
            <p className="mono" style={{ color: 'var(--dim)', marginTop: 0 }}>
              // current month — visible through {matrix.visibleLastDay || '—'}
              {!matrix.visibleLastDay && ' (no completed days yet)'}
            </p>
          )}

          {['SC', 'LVN'].map((type) => {
            const sect = matrix.sections[type];
            if (!sect || sect.rows.length === 0) return null;
            const collapsed = type === 'SC' ? scCollapsed : lvnCollapsed;
            return (
              <Section
                key={type}
                type={type}
                section={sect}
                days={matrix.days}
                metric={metric}
                collapsed={collapsed}
                onToggle={() => update({ [type === 'SC' ? 'sc' : 'lvn']: collapsed ? '1' : '0' })}
              />
            );
          })}

          <div className="grand-total">
            <span className="mono" style={{ color: 'var(--muted)' }}>GRAND TOTAL — {matrix.month}</span>
            <span>Volume: <b>{fmtInt(matrix.grandTotal.volume)}</b></span>
            <span>Revenue: <b>{fmtMoney(matrix.grandTotal.revenue)}</b></span>
          </div>
        </>
      )}
    </div>
  );
}

function Section({ type, section, days, metric, collapsed, onToggle }) {
  const dayLabels = days.map((d) => d.slice(8, 10));
  return (
    <section className="hist-section">
      <button className="hist-toggle" onClick={onToggle}>
        <span>{collapsed ? '▸' : '▾'} {type}</span>
        <span className="mono" style={{ color: 'var(--dim)', marginLeft: 14 }}>
          {section.rows.length} numbers · vol {fmtInt(section.totals.volume)} · rev {fmtMoney(section.totals.revenue)}
        </span>
      </button>
      {!collapsed && (
        <div className="table-wrap">
          <table className="data hist-grid">
            <thead>
              <tr>
                <th className="sticky-col">Number</th>
                <th>country</th>
                <th>client</th>
                {days.map((d, i) => (
                  <th key={d} title={d} style={{ textAlign: 'right' }}>{dayLabels[i]}</th>
                ))}
                <th style={{ textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {section.rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono sticky-col">{r.number}</td>
                  <td>{r.country || '—'}</td>
                  <td>{r.client || '—'}</td>
                  {days.map((d) => (
                    <td key={d} style={{ textAlign: 'right' }} className="mono">
                      {fmtCell(r.byDay[d], metric)}
                    </td>
                  ))}
                  <td style={{ textAlign: 'right' }} className="mono">
                    {metric === 'revenue' ? fmtMoney(r.totals.revenue) : fmtInt(r.totals.volume)}
                  </td>
                </tr>
              ))}
              <tr className="hist-subtotal">
                <td className="sticky-col">{type} total</td>
                <td></td><td></td>
                {days.map((d) => (
                  <td key={d} style={{ textAlign: 'right' }} className="mono">
                    {fmtCell(section.byDay[d], metric)}
                  </td>
                ))}
                <td style={{ textAlign: 'right' }} className="mono">
                  {metric === 'revenue' ? fmtMoney(section.totals.revenue) : fmtInt(section.totals.volume)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
