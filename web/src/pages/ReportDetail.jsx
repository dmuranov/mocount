// ReportDetail — SPEC §5 + §14 step 17.
//
// Renders the 4 SPEC-§5 tabs from /api/reports/:yyyymm. Tab nav is
// query-string driven so a teammate can deep-link a tab. The xlsx
// download link mirrors whichever month is in the URL.

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';

const TABS = [
  { id: 'summary', label: 'Summary' },
  { id: 'per',     label: 'Per SC/LVN' },
  { id: 'costs',   label: 'Costs' },
  { id: 'client',  label: 'Client billing' },
];

function fmtMoney(n) { return `$${(Number(n) || 0).toFixed(2)}`; }
function fmtInt(n)   { return (Number(n) || 0).toLocaleString('en-US'); }
function fmt4(n)     { return (Number(n) || 0).toFixed(4); }

export default function ReportDetail() {
  const { yyyymm } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'summary';

  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setReport(null); setError(null);
    api.get(`/api/reports/${yyyymm}`)
      .then(setReport)
      .catch((e) => setError(e.message));
  }, [yyyymm]);

  const xlsxHref = useMemo(() => `/api/reports/${yyyymm}/xlsx`, [yyyymm]);

  return (
    <div className="page">
      <div className="numbers-toolbar">
        <div className="filter-row">
          <Link className="btn-ghost" to="/reports">← All months</Link>
          <span className="mono" style={{ marginLeft: 6, fontSize: 14, fontWeight: 600 }}>Report — {yyyymm}</span>
        </div>
        <div className="dash-actions">
          <a className="btn-ghost" href={xlsxHref}>Download (.xlsx)</a>
        </div>
      </div>

      <div className="tab-nav">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={'tab' + (tab === t.id ? ' active' : '')}
            onClick={() => setParams({ tab: t.id }, { replace: true })}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <div className="err-box">{error}</div>}
      {!report && !error && <p className="mono">loading…</p>}

      {report && tab === 'summary' && <SummaryTab r={report} />}
      {report && tab === 'per'     && <PerNumberTab r={report} />}
      {report && tab === 'costs'   && <CostsTab r={report} />}
      {report && tab === 'client'  && <ClientBillingTab r={report} />}
    </div>
  );
}

function SummaryTab({ r }) {
  const h = r.summary.headline;
  return (
    <div>
      <div className="cards">
        <Card label="Total volume"  value={fmtInt(h.total_volume)} />
        <Card label="Total revenue" value={fmtMoney(h.total_revenue)} />
        <Card label="Cost fees"     value={fmtMoney(h.total_cost_fees)} />
        <Card label={h.net >= 0 ? 'Net' : 'Net (loss)'} value={fmtMoney(h.net)} />
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr><th>Section</th><th>Line</th><th style={{ textAlign: 'right' }}>Amount</th></tr>
          </thead>
          <tbody>
            <tr><td>CREDIT</td><td>Total revenue (volume × margin)</td><td style={{ textAlign: 'right' }} className="mono">{fmtMoney(r.summary.credit.total_revenue)}</td></tr>
            <tr><td colSpan={3} className="mono" style={{ color: 'var(--dim)', borderTop: '1px solid var(--line)' }}>DEBIT (cost-side)</td></tr>
            {r.summary.debit.lines.map((line, i) => (
              <tr key={i}>
                <td></td>
                <td>{line.label}</td>
                <td style={{ textAlign: 'right' }} className="mono">{fmtMoney(line.amount)}</td>
              </tr>
            ))}
            <tr style={{ borderTop: '1px solid var(--line)' }}>
              <td></td>
              <td>Total cost fees</td>
              <td style={{ textAlign: 'right' }} className="mono"><b>{fmtMoney(r.summary.debit.total)}</b></td>
            </tr>
            <tr style={{ borderTop: '2px solid var(--accent)' }}>
              <td>NET</td><td></td>
              <td style={{ textAlign: 'right' }} className="mono"><b>{fmtMoney(r.summary.net)}</b></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PerNumberTab({ r }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Number</th><th>type</th><th>country</th><th>client</th>
            <th style={{ textAlign: 'right' }}>volume</th>
            <th style={{ textAlign: 'right' }}>margin</th>
            <th style={{ textAlign: 'right' }}>revenue</th>
          </tr>
        </thead>
        <tbody>
          {r.perNumber.rows.map((row, i) => (
            <tr key={i}>
              <td className="mono">{row.number}</td>
              <td>{row.type}</td>
              <td>{row.country || '—'}</td>
              <td>{row.client || '—'}</td>
              <td style={{ textAlign: 'right' }} className="mono">{fmtInt(row.volume)}</td>
              <td style={{ textAlign: 'right' }} className="mono">{fmt4(row.margin)}</td>
              <td style={{ textAlign: 'right' }} className="mono">{fmtMoney(row.revenue)}</td>
            </tr>
          ))}
          <tr style={{ borderTop: '2px solid var(--accent)' }}>
            <td><b>TOTAL</b></td><td></td><td></td><td></td>
            <td style={{ textAlign: 'right' }} className="mono"><b>{fmtInt(r.perNumber.totals.volume)}</b></td>
            <td></td>
            <td style={{ textAlign: 'right' }} className="mono"><b>{fmtMoney(r.perNumber.totals.revenue)}</b></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function CostsTab({ r }) {
  const t = r.costs.totals;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Number</th><th>type</th><th>country</th><th>client</th>
            <th style={{ textAlign: 'right' }}>volume</th>
            <th style={{ textAlign: 'right' }}>purchase</th>
            <th style={{ textAlign: 'right' }}>cost (vol×price)</th>
            <th style={{ textAlign: 'right' }}>monthly fee</th>
            <th style={{ textAlign: 'right' }}>yearly fee</th>
            <th style={{ textAlign: 'right' }}>setup fee</th>
            <th style={{ textAlign: 'right' }}>total cost</th>
          </tr>
        </thead>
        <tbody>
          {r.costs.rows.map((row, i) => (
            <tr key={i}>
              <td className="mono">{row.number}</td>
              <td>{row.type}</td>
              <td>{row.country || '—'}</td>
              <td>{row.client || '—'}</td>
              <td style={{ textAlign: 'right' }} className="mono">{fmtInt(row.volume)}</td>
              <td style={{ textAlign: 'right' }} className="mono">{fmt4(row.purchase_price)}</td>
              <td style={{ textAlign: 'right' }} className="mono">{fmtMoney(row.cost)}</td>
              <td style={{ textAlign: 'right' }} className="mono">{fmtMoney(row.monthly_fee)}</td>
              <td style={{ textAlign: 'right' }} className="mono">{fmtMoney(row.yearly_fee)}</td>
              <td style={{ textAlign: 'right' }} className="mono">{fmtMoney(row.setup_fee)}</td>
              <td style={{ textAlign: 'right' }} className="mono">{fmtMoney(row.total_cost)}</td>
            </tr>
          ))}
          <tr style={{ borderTop: '2px solid var(--accent)' }}>
            <td><b>TOTAL</b></td><td></td><td></td><td></td>
            <td style={{ textAlign: 'right' }} className="mono"><b>{fmtInt(t.volume)}</b></td>
            <td></td>
            <td style={{ textAlign: 'right' }} className="mono"><b>{fmtMoney(t.cost)}</b></td>
            <td style={{ textAlign: 'right' }} className="mono"><b>{fmtMoney(t.monthly_fee)}</b></td>
            <td style={{ textAlign: 'right' }} className="mono"><b>{fmtMoney(t.yearly_fee)}</b></td>
            <td style={{ textAlign: 'right' }} className="mono"><b>{fmtMoney(t.setup_fee)}</b></td>
            <td style={{ textAlign: 'right' }} className="mono"><b>{fmtMoney(t.total_cost)}</b></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function ClientBillingTab({ r }) {
  const g = r.clientBilling;
  return (
    <div>
      {g.groups.map((group) => (
        <div key={group.client} className="client-group">
          <h4>{group.client}</h4>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Number</th><th>country</th>
                  <th style={{ textAlign: 'right' }}>volume</th>
                  <th style={{ textAlign: 'right' }}>selling</th>
                  <th style={{ textAlign: 'right' }}>sales (vol×selling)</th>
                  <th style={{ textAlign: 'right' }}>monthly fee</th>
                  <th style={{ textAlign: 'right' }}>yearly fee</th>
                  <th style={{ textAlign: 'right' }}>setup fee</th>
                  <th style={{ textAlign: 'right' }}>total</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row, i) => (
                  <tr key={i}>
                    <td className="mono">{row.number}</td>
                    <td>{row.country || '—'}</td>
                    <td style={{ textAlign: 'right' }} className="mono">{fmtInt(row.volume)}</td>
                    <td style={{ textAlign: 'right' }} className="mono">{fmt4(row.selling_price)}</td>
                    <td style={{ textAlign: 'right' }} className="mono">{fmtMoney(row.sales)}</td>
                    <td style={{ textAlign: 'right' }} className="mono">{fmtMoney(row.monthly_fee)}</td>
                    <td style={{ textAlign: 'right' }} className="mono">{fmtMoney(row.yearly_fee)}</td>
                    <td style={{ textAlign: 'right' }} className="mono">{fmtMoney(row.setup_fee)}</td>
                    <td style={{ textAlign: 'right' }} className="mono">{fmtMoney(row.total)}</td>
                  </tr>
                ))}
                <tr style={{ borderTop: '1px solid var(--accent)' }}>
                  <td><b>subtotal</b></td><td></td>
                  <td style={{ textAlign: 'right' }} className="mono"><b>{fmtInt(group.subtotal.volume)}</b></td>
                  <td></td>
                  <td style={{ textAlign: 'right' }} className="mono"><b>{fmtMoney(group.subtotal.sales)}</b></td>
                  <td style={{ textAlign: 'right' }} className="mono"><b>{fmtMoney(group.subtotal.monthly_fee)}</b></td>
                  <td style={{ textAlign: 'right' }} className="mono"><b>{fmtMoney(group.subtotal.yearly_fee)}</b></td>
                  <td style={{ textAlign: 'right' }} className="mono"><b>{fmtMoney(group.subtotal.setup_fee)}</b></td>
                  <td style={{ textAlign: 'right' }} className="mono"><b>{fmtMoney(group.subtotal.total)}</b></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <div className="grand-total">
        <span className="mono" style={{ color: 'var(--muted)' }}>GRAND TOTAL</span>
        <span>Volume: <b>{fmtInt(g.grandTotal.volume)}</b></span>
        <span>Sales: <b>{fmtMoney(g.grandTotal.sales)}</b></span>
        <span>Total: <b>{fmtMoney(g.grandTotal.total)}</b></span>
      </div>
    </div>
  );
}

function Card({ label, value }) {
  return (
    <div className="card">
      <div className="card-label">{label}</div>
      <div className="card-value">{value}</div>
    </div>
  );
}
