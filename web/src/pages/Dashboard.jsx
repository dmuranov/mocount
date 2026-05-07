// Dashboard — SPEC §4.
//   Top: date picker + 4 cards (yesterday vol/rev, MTD vol/rev) + admin import buttons.
//   Body: one row per active number with a Volume cell editable by admins.
//   Save persists every edited row via POST /api/volumes (bulk upsert).
//
// Imports (admin only):
//   • Numbers — used once for initial bulk load, also for ongoing edits
//     (price changes, new numbers, fee additions). Header set incl. fees.
//   • Volumes — recurring daily imports. Manual editing in the table is
//     the alternative path for small daily corrections.

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import ImportPanel from '../components/ImportPanel.jsx';

function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function formatMoney(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}
function formatInt(n) {
  return (Number(n) || 0).toLocaleString('en-US');
}

export default function Dashboard() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [date, setDate] = useState(todayISO());
  const [numbers, setNumbers] = useState(null);   // null = loading
  const [volumes, setVolumes] = useState(new Map()); // number_id -> volume on `date`
  const [edits, setEdits] = useState(new Map());     // number_id -> string (input value)
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const [importOpen, setImportOpen] = useState(false);

  async function loadAll(thisDate) {
    setError(null);
    try {
      const [{ numbers: nums }, { volumes: vols }, hist] = await Promise.all([
        api.get('/api/numbers?active=true'),
        api.get(`/api/volumes?from=${thisDate}&to=${thisDate}`),
        api.get(`/api/history/${thisDate.slice(0, 7)}`),
      ]);
      setNumbers(nums);
      const map = new Map();
      for (const v of vols) map.set(v.number_id, v.volume);
      setVolumes(map);
      setEdits(new Map()); // reset pending edits when the date changes
      setHistory(hist);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => { loadAll(date); }, [date]);

  function setEdit(numberId, value) {
    const next = new Map(edits);
    if (value === '' || value === null || value === undefined) next.delete(numberId);
    else next.set(numberId, value);
    setEdits(next);
  }

  async function saveAll() {
    if (!isAdmin) return;
    if (edits.size === 0) return;
    setSaving(true);
    setError(null);
    try {
      const rows = [];
      for (const [number_id, raw] of edits.entries()) {
        const v = Number(raw);
        if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
          throw new Error(`Bad volume "${raw}" for one of the rows`);
        }
        rows.push({ number_id, date, volume: v });
      }
      const res = await api.post('/api/volumes', rows);
      // Surface row-level errors (closed-month etc.) without losing the rest.
      if (res.errors?.length) {
        setError(res.errors.map((e) => e.error).join(' • '));
      }
      await loadAll(date);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  // ── Cards: yesterday + MTD from /api/history ──
  const cards = useMemo(() => {
    if (!history) return null;
    const last = history.visibleLastDay;
    const yest = last ? history.sections : null;
    let yVol = 0, yRev = 0;
    if (yest) {
      for (const s of Object.values(yest)) {
        const cell = s.byDay?.[last];
        if (cell) { yVol += cell.volume; yRev += cell.revenue; }
      }
    }
    return {
      yesterdayDate: last,
      yesterday: { volume: yVol, revenue: Math.round(yRev * 100) / 100 },
      mtd: history.grandTotal,
    };
  }, [history]);

  return (
    <div className="page">
      <div className="dash-toolbar">
        <div className="dash-date">
          <label className="mono">date for volume entry</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            disabled={!isAdmin && false /* viewers can change date too */}
          />
        </div>
        {isAdmin && (
          <div className="dash-actions">
            <button className="btn-ghost" onClick={() => setImportOpen(true)}>Import (.xlsx)</button>
          </div>
        )}
      </div>

      {cards && (
        <div className="cards">
          <Card label={`Yesterday volume${cards.yesterdayDate ? ` (${cards.yesterdayDate})` : ''}`} value={formatInt(cards.yesterday.volume)} />
          <Card label="Yesterday revenue" value={formatMoney(cards.yesterday.revenue)} />
          <Card label={`MTD volume (${history.month})`} value={formatInt(cards.mtd.volume)} />
          <Card label="MTD revenue" value={formatMoney(cards.mtd.revenue)} />
        </div>
      )}

      {error && <div className="err-box" style={{ marginBottom: 14 }}>{error}</div>}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Number</th>
              <th>type</th>
              <th>country</th>
              <th>client</th>
              <th style={{ textAlign: 'right' }}>Purchase $/MO</th>
              <th style={{ textAlign: 'right' }}>Selling $/MO</th>
              <th style={{ textAlign: 'right' }}>Margin Δ</th>
              <th style={{ textAlign: 'right', width: 140 }}>Volume on {date}</th>
            </tr>
          </thead>
          <tbody>
            {numbers === null && (
              <tr><td colSpan={8} className="mono" style={{ color: 'var(--dim)' }}>loading…</td></tr>
            )}
            {numbers && numbers.length === 0 && (
              <tr><td colSpan={8} className="mono" style={{ color: 'var(--dim)' }}>No active numbers. Import via the button above.</td></tr>
            )}
            {numbers && numbers.map((n) => {
              const persisted = volumes.has(n.id) ? String(volumes.get(n.id)) : '';
              const editVal = edits.has(n.id) ? edits.get(n.id) : persisted;
              const dirty = edits.has(n.id) && editVal !== persisted;
              return (
                <tr key={n.id} className={dirty ? 'row-dirty' : ''}>
                  <td className="mono">{n.number}</td>
                  <td>{n.type}</td>
                  <td>{n.country || '—'}</td>
                  <td>{n.client || '—'}</td>
                  <td style={{ textAlign: 'right' }} className="mono">{n.purchase_price_per_mo.toFixed(4)}</td>
                  <td style={{ textAlign: 'right' }} className="mono">{n.selling_price_per_mo.toFixed(4)}</td>
                  <td style={{ textAlign: 'right' }} className="mono">{n.margin_per_mo.toFixed(4)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {isAdmin ? (
                      <input
                        type="number"
                        min="0"
                        step="1"
                        className="vol-input"
                        value={editVal}
                        placeholder="—"
                        onChange={(e) => setEdit(n.id, e.target.value)}
                      />
                    ) : (
                      <span className="mono">{persisted || '—'}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {isAdmin && (
        <div className="save-bar">
          <span className="mono">{edits.size} pending edit{edits.size === 1 ? '' : 's'}</span>
          <button className="btn-primary" disabled={saving || edits.size === 0} onClick={saveAll}>
            {saving ? 'Saving…' : 'Save volumes'}
          </button>
        </div>
      )}

      <ImportPanel
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onDone={() => loadAll(date)}
        endpoint="/api/import"
        title="Import (.xlsx) — numbers, fees, volumes"
        summarize={(p) => (
          <ul className="preview-list">
            <li>Numbers to create: <b>{p.toCreate?.length ?? 0}</b></li>
            <li>Numbers to update: <b>{p.toUpdate?.length ?? 0}</b></li>
            <li>Fees to create: <b>{p.feesToCreate?.length ?? 0}</b></li>
            <li>Volumes to upsert: <b>{p.volumesToUpsert?.length ?? 0}</b></li>
            <li>Errors: <b>{p.errors?.length ?? 0}</b></li>
            {p.closedMonths?.length > 0 && (
              <li style={{ color: 'var(--danger-fg)' }}>Closed months in file: {p.closedMonths.join(', ')}</li>
            )}
            {p.errors?.length > 0 && (
              <li style={{ color: 'var(--danger-fg)' }}>
                <details>
                  <summary>Show errors</summary>
                  <pre className="result-pre">{p.errors.map((e) => `row ${e.idx}: ${e.error}`).join('\n')}</pre>
                </details>
              </li>
            )}
          </ul>
        )}
      />
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
