// Volumes page — SPEC §4 + §14 step 15.
//   Back-fill UI: explicit date picker, the same per-active-number
//   table with editable volume cells, bulk save. No metric cards or
//   import button — those live on Dashboard / Numbers.
//
// Closed-month enforcement is server-side (DB trigger + service
// pre-check). The UI surfaces any rejected rows in the error bar
// instead of failing the whole save.

import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export default function Volumes() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [date, setDate] = useState(todayISO());
  const [numbers, setNumbers] = useState(null);
  const [volumes, setVolumes] = useState(new Map());
  const [edits, setEdits] = useState(new Map());
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  const [saving, setSaving] = useState(false);

  async function load(thisDate) {
    setError(null);
    setInfo(null);
    try {
      const [{ numbers: nums }, { volumes: vols }] = await Promise.all([
        api.get('/api/numbers?active=true'),
        api.get(`/api/volumes?from=${thisDate}&to=${thisDate}`),
      ]);
      setNumbers(nums);
      const map = new Map();
      for (const v of vols) map.set(v.number_id, v.volume);
      setVolumes(map);
      setEdits(new Map());
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => { load(date); }, [date]);

  function setEdit(numberId, value) {
    const next = new Map(edits);
    if (value === '' || value === null || value === undefined) next.delete(numberId);
    else next.set(numberId, value);
    setEdits(next);
  }

  async function saveAll() {
    if (!isAdmin || edits.size === 0) return;
    setSaving(true);
    setError(null);
    setInfo(null);
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
      if (res.errors?.length) {
        setError(res.errors.map((e) => e.error).join(' • '));
      }
      setInfo(`Saved: ${res.changed} changed, ${res.unchanged} unchanged.`);
      await load(date);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page">
      <div className="dash-toolbar">
        <div className="dash-date">
          <label className="mono">Editing volumes for date</label>
          <input
            type="date"
            value={date}
            max={todayISO()}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <p className="mono" style={{ color: 'var(--dim)', margin: 0 }}>
          // closed months refuse writes; you'll see per-row errors instead of a silent skip
        </p>
      </div>

      {error && <div className="err-box" style={{ marginBottom: 14 }}>{error}</div>}
      {info && <div className="ok-box" style={{ marginBottom: 14 }}>{info}</div>}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Number</th>
              <th>type</th>
              <th>country</th>
              <th>client</th>
              <th style={{ textAlign: 'right', width: 160 }}>Volume on {date}</th>
            </tr>
          </thead>
          <tbody>
            {numbers === null && (
              <tr><td colSpan={5} className="mono" style={{ color: 'var(--dim)' }}>loading…</td></tr>
            )}
            {numbers && numbers.length === 0 && (
              <tr><td colSpan={5} className="mono" style={{ color: 'var(--dim)' }}>No active numbers.</td></tr>
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
                  <td style={{ textAlign: 'right' }}>
                    {isAdmin ? (
                      <input
                        type="number" min="0" step="1"
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
    </div>
  );
}
